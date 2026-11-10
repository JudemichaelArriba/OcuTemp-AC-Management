import { LogKeyRange } from './log-date-filter.helper';

/**
 * Server-side paging over records that are stored as one push-key-ordered list per device.
 *
 * Nothing is downloaded ahead of need: each device is read a chunk at a time, newest first,
 * and the chunks are merged by push key (push keys sort by creation time across devices).
 * A device is only read again once all of its fetched records have been shown.
 *
 * New records arrive through a per-device live tail. A tail is closed while that device is
 * being read: overlapping a live listener with a one-time query on the same RTDB location
 * can serve incomplete cached reads.
 */

/** The identity every paged record carries. `key` is the RTDB push key. */
export interface PagedRecord {
  readonly id: string;
  readonly key: string;
  readonly deviceId: string;
}

export interface RecordPageRequest {
  readonly limit: number;
  /** Exclusive cursor: only records with a push key older than this one. */
  readonly before?: string;
  readonly keyRange?: LogKeyRange;
}

export interface RecordPage<T> {
  /** Newest first. */
  readonly records: T[];
  /** True when the device holds older records than the ones returned. */
  readonly hasMore: boolean;
}

export interface RecordsPagerSource<T> {
  fetchPage(deviceId: string, request: RecordPageRequest): Promise<RecordPage<T>>;
  /**
   * Live records of a device whose push key is `fromKey` or newer (every record when
   * `fromKey` is undefined). Returns an unsubscribe function. Omit for a pager that only reads.
   */
  streamFrom?(
    deviceId: string,
    fromKey: string | undefined,
    onRecords: (records: T[]) => void
  ): () => void;
}

export interface RecordsPagerQuery<T> {
  readonly deviceIds: readonly string[];
  readonly keyRange?: LogKeyRange;
  /** Client-side filter for what the server cannot match, such as free text. */
  readonly matches?: (record: T) => boolean;
  /** Follow new records as they arrive. Pointless when the key range ends in the past. */
  readonly live?: boolean;
}

export interface RecordsPagerOptions {
  /** Rows revealed per `loadMore()`. */
  readonly pageSize: number;
  /** Records read per device request while `matches` is set; defaults to `pageSize`. */
  readonly filteredChunkSize?: number;
  /**
   * Most records one `loadMore()` may read while `matches` is set. Bounds how much a rare
   * search term downloads per click; the next `loadMore()` continues where this one stopped.
   */
  readonly scanBudget?: number;
  /** Called after live records were added to `loaded`. */
  readonly onLiveRecords?: () => void;
}

interface Feed<T> {
  readonly deviceId: string;
  /** Fetched, matching, not yet revealed. Newest first. */
  buffer: T[];
  /** Oldest push key fetched so far; the next request reads before it. */
  cursor?: string;
  /** Newest push key seen from this device, fetched or live. Empty until one is seen. */
  newestKey: string;
  exhausted: boolean;
  /** True once the device has been read; only then is its newest key known for a live tail. */
  fetched: boolean;
  stopTail?: () => void;
}

/** Newest first; equal keys (practically impossible) fall back to the device for a stable order. */
function isNewer(a: PagedRecord, b: PagedRecord): boolean {
  return a.key === b.key ? a.deviceId < b.deviceId : a.key > b.key;
}

export class RecordsPager<T extends PagedRecord> {
  private feeds: Feed<T>[] = [];
  private query: RecordsPagerQuery<T> = { deviceIds: [] };
  private rows: T[] = [];
  private scannedCount = 0;
  /** Bumped by `start()` and `dispose()` so results of an abandoned query are dropped. */
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private liveSuspended = false;

  constructor(
    private readonly source: RecordsPagerSource<T>,
    private readonly options: RecordsPagerOptions
  ) { }

  /** Records revealed so far, newest first. */
  get loaded(): readonly T[] {
    return this.rows;
  }

  /** True while older matching records may still exist on the server. */
  get hasMore(): boolean {
    return this.feeds.some((feed) => feed.buffer.length > 0 || !feed.exhausted);
  }

  /** Records read from the server for the current query, matching or not. */
  get scanned(): number {
    return this.scannedCount;
  }

  /** Begins a new query. Nothing is read until `loadMore()` is called. */
  start(query: RecordsPagerQuery<T>): void {
    this.closeTails();
    this.generation++;
    this.inFlight = null;
    this.query = query;
    this.rows = [];
    this.scannedCount = 0;
    this.feeds = [...new Set(query.deviceIds)].map((deviceId) => ({
      deviceId,
      buffer: [],
      newestKey: '',
      exhausted: false,
      fetched: false,
    }));
  }

  /**
   * Reveals up to `pageSize` more records. Calls made while one is running share it.
   * Rejects when a read fails; the pager stays usable and the call can be repeated.
   */
  loadMore(): Promise<void> {
    if (!this.inFlight) {
      const generation = this.generation;
      const run = this.reveal(generation).finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
      this.inFlight = run;
    }
    return this.inFlight;
  }

  /** Closes the live tails, e.g. before reading the same devices through another pager. */
  suspendLive(): void {
    this.liveSuspended = true;
    this.closeTails();
  }

  resumeLive(): void {
    this.liveSuspended = false;
    this.feeds.forEach((feed) => this.openTail(feed));
  }

  /** Stops all live tails and abandons any read in progress. */
  dispose(): void {
    this.closeTails();
    this.generation++;
    this.inFlight = null;
    this.feeds = [];
  }

  private async reveal(generation: number): Promise<void> {
    let revealed = 0;
    let budget = this.query.matches
      ? this.options.scanBudget ?? Number.POSITIVE_INFINITY
      : Number.POSITIVE_INFINITY;

    while (revealed < this.options.pageSize) {
      const next = this.feedWithNewestBuffered();
      const blockers = this.feedsBlocking(next?.buffer[0]);

      if (blockers.length === 0) {
        if (!next) break; // every device is exhausted
        this.rows.push(next.buffer.shift() as T);
        revealed++;
        continue;
      }

      if (budget <= 0) break;
      // Every read settles before this run ends, so a retry can never read a device that is
      // still being read (which would buffer the same records twice).
      const results = await Promise.allSettled(blockers.map((feed) => this.fill(feed, generation)));
      if (generation !== this.generation) return;
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        budget -= result.value;
      }
    }
  }

  private feedWithNewestBuffered(): Feed<T> | undefined {
    let newest: Feed<T> | undefined;
    for (const feed of this.feeds) {
      if (feed.buffer.length === 0) continue;
      if (!newest || isNewer(feed.buffer[0], newest.buffer[0])) newest = feed;
    }
    return newest;
  }

  /**
   * Devices that must be read before `candidate` can be shown: those with nothing buffered
   * whose unread records (all older than their cursor) could still be newer than it.
   */
  private feedsBlocking(candidate: T | undefined): Feed<T>[] {
    return this.feeds.filter((feed) =>
      !feed.exhausted
      && feed.buffer.length === 0
      && (!candidate || feed.cursor === undefined || feed.cursor > candidate.key));
  }

  /** Reads the next chunk of one device into its buffer. Resolves to the records read. */
  private async fill(feed: Feed<T>, generation: number): Promise<number> {
    this.closeTail(feed);

    const { matches, keyRange } = this.query;
    const limit = matches
      ? this.options.filteredChunkSize ?? this.options.pageSize
      : this.options.pageSize;
    let page: RecordPage<T>;
    try {
      page = await this.source.fetchPage(feed.deviceId, { limit, before: feed.cursor, keyRange });
    } catch (error) {
      // The read is over; keep following a device that was already being followed.
      if (generation === this.generation) this.openTail(feed);
      throw error;
    }
    if (generation !== this.generation) return 0;

    const records = page.records;
    if (records.length > 0) {
      feed.cursor = records[records.length - 1].key;
      if (records[0].key > feed.newestKey) feed.newestKey = records[0].key;
    }
    feed.exhausted = !page.hasMore;
    feed.fetched = true;
    feed.buffer.push(...(matches ? records.filter(matches) : records));
    this.scannedCount += records.length;

    this.openTail(feed);
    return records.length;
  }

  private openTail(feed: Feed<T>): void {
    if (!this.query.live || this.liveSuspended || !feed.fetched || feed.stopTail) return;
    if (!this.source.streamFrom) return;

    const generation = this.generation;
    feed.stopTail = this.source.streamFrom(
      feed.deviceId,
      feed.newestKey || this.query.keyRange?.startKey,
      (records) => this.acceptLive(feed, records, generation)
    );
  }

  private closeTail(feed: Feed<T>): void {
    feed.stopTail?.();
    feed.stopTail = undefined;
  }

  private closeTails(): void {
    this.feeds.forEach((feed) => this.closeTail(feed));
  }

  /** Adds live records newer than anything this device has delivered so far. */
  private acceptLive(feed: Feed<T>, records: T[], generation: number): void {
    if (generation !== this.generation) return;

    const fresh = records
      .filter((record) => record.key > feed.newestKey)
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    if (fresh.length === 0) return;
    feed.newestKey = fresh[fresh.length - 1].key;

    const { matches, keyRange } = this.query;
    const accepted = fresh.filter((record) =>
      (!keyRange?.endKey || record.key < keyRange.endKey) && (!matches || matches(record)));
    if (accepted.length === 0) return;

    for (const record of accepted) {
      const index = this.rows.findIndex((row) => isNewer(record, row));
      this.rows.splice(index === -1 ? this.rows.length : index, 0, record);
    }
    this.options.onLiveRecords?.();
  }
}

/**
 * Reads every record matching `query`, newest first, up to `limit`. `truncated` is true when
 * more matching records exist beyond the limit. Used for exports; never opens live tails.
 */
export async function collectRecords<T extends PagedRecord>(
  source: Pick<RecordsPagerSource<T>, 'fetchPage'>,
  query: Omit<RecordsPagerQuery<T>, 'live'>,
  limit: number,
  chunkSize: number
): Promise<{ records: T[]; truncated: boolean }> {
  const pager = new RecordsPager<T>(
    { fetchPage: (deviceId, request) => source.fetchPage(deviceId, request) },
    { pageSize: chunkSize, filteredChunkSize: chunkSize }
  );
  pager.start({ ...query, live: false });

  while (pager.hasMore && pager.loaded.length < limit) {
    await pager.loadMore();
  }
  return {
    records: pager.loaded.slice(0, limit),
    truncated: pager.loaded.length > limit || pager.hasMore,
  };
}
