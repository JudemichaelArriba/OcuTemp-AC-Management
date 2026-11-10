import {
  PagedRecord,
  RecordPage,
  RecordPageRequest,
  RecordsPager,
  RecordsPagerSource,
  collectRecords,
} from './records-pager';

interface TestRecord extends PagedRecord {
  readonly text: string;
}

/** Push-key-like keys: zero-padded so string order equals numeric (time) order. */
const key = (time: number) => `k${time.toString().padStart(5, '0')}`;

function record(deviceId: string, time: number, text = ''): TestRecord {
  return { id: `${deviceId}/${key(time)}`, key: key(time), deviceId, text };
}

/** In-memory stand-in for the database: one time-ordered list per device. */
class FakeSource implements RecordsPagerSource<TestRecord> {
  readonly requests: { deviceId: string; request: RecordPageRequest }[] = [];
  readonly tails = new Map<string, { fromKey?: string; emit: (records: TestRecord[]) => void }>();
  /** Device ids being read right now, to prove a tail is never open during a read. */
  readonly overlaps: string[] = [];
  failNext = false;

  constructor(private readonly data: Record<string, TestRecord[]>) { }

  async fetchPage(deviceId: string, request: RecordPageRequest): Promise<RecordPage<TestRecord>> {
    this.requests.push({ deviceId, request });
    if (this.tails.has(deviceId)) this.overlaps.push(deviceId);
    await Promise.resolve();
    if (this.failNext) {
      this.failNext = false;
      throw new Error('permission_denied');
    }

    const { startKey, endKey } = request.keyRange ?? {};
    const matching = (this.data[deviceId] ?? [])
      .filter((item) =>
        (!request.before || item.key < request.before)
        && (!startKey || item.key >= startKey)
        && (!endKey || item.key < endKey))
      .sort((a, b) => (a.key < b.key ? 1 : -1));
    return { records: matching.slice(0, request.limit), hasMore: matching.length > request.limit };
  }

  streamFrom(deviceId: string, fromKey: string | undefined, onRecords: (records: TestRecord[]) => void) {
    this.tails.set(deviceId, { fromKey, emit: onRecords });
    return () => { this.tails.delete(deviceId); };
  }
}

const times = (records: readonly TestRecord[]) => records.map((item) => Number(item.key.slice(1)));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('RecordsPager', () => {
  it('merges devices newest first, one page at a time', async () => {
    const source = new FakeSource({
      a: [1, 4, 5, 9].map((time) => record('a', time)),
      b: [2, 3, 8].map((time) => record('b', time)),
    });
    const pager = new RecordsPager(source, { pageSize: 3 });
    pager.start({ deviceIds: ['a', 'b'] });

    await pager.loadMore();
    expect(times(pager.loaded)).toEqual([9, 8, 5]);
    expect(pager.hasMore).toBe(true);

    await pager.loadMore();
    expect(times(pager.loaded)).toEqual([9, 8, 5, 4, 3, 2]);

    await pager.loadMore();
    expect(times(pager.loaded)).toEqual([9, 8, 5, 4, 3, 2, 1]);
    expect(pager.hasMore).toBe(false);
  });

  it('reads only what a page needs instead of whole device histories', async () => {
    const source = new FakeSource({
      a: range(1, 1000).map((time) => record('a', time)),
      b: range(1, 3).map((time) => record('b', time)),
    });
    const pager = new RecordsPager(source, { pageSize: 10 });
    pager.start({ deviceIds: ['a', 'b'] });

    await pager.loadMore();
    expect(times(pager.loaded)).toEqual(range(991, 1000).reverse());
    expect(source.requests).toHaveLength(2);
    expect(pager.scanned).toBe(13);

    await pager.loadMore();
    expect(times(pager.loaded)).toEqual(range(981, 1000).reverse());
    // Device b still has its three buffered records, so only device a is read again.
    expect(source.requests).toHaveLength(3);
    expect(source.requests[2]).toEqual({
      deviceId: 'a',
      request: { limit: 10, before: key(991), keyRange: undefined },
    });
  });

  it('never shows a record before an older-looking device has been checked', async () => {
    // Device b's newest record is newer than device a's second page.
    const source = new FakeSource({
      a: [10, 9, 2, 1].map((time) => record('a', time)),
      b: [5].map((time) => record('b', time)),
    });
    const pager = new RecordsPager(source, { pageSize: 2 });
    pager.start({ deviceIds: ['a', 'b'] });

    await pager.loadMore();
    await pager.loadMore();
    expect(times(pager.loaded)).toEqual([10, 9, 5, 2]);
  });

  it('applies the key range on the server', async () => {
    const source = new FakeSource({ a: range(1, 30).map((time) => record('a', time)) });
    const pager = new RecordsPager(source, { pageSize: 5 });
    pager.start({ deviceIds: ['a'], keyRange: { startKey: key(10), endKey: key(13) } });

    await pager.loadMore();
    expect(times(pager.loaded)).toEqual([12, 11, 10]);
    expect(pager.hasMore).toBe(false);
  });

  it('pages through matches of a client-side filter in larger chunks', async () => {
    const source = new FakeSource({
      a: range(1, 100).map((time) => record('a', time, time % 10 === 0 ? 'match' : 'other')),
    });
    const pager = new RecordsPager(source, { pageSize: 3, filteredChunkSize: 50 });
    pager.start({ deviceIds: ['a'], matches: (item) => item.text === 'match' });

    await pager.loadMore();
    expect(times(pager.loaded)).toEqual([100, 90, 80]);
    expect(source.requests).toHaveLength(1);

    await pager.loadMore();
    await pager.loadMore();
    await pager.loadMore();
    expect(times(pager.loaded)).toEqual([100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
    expect(pager.hasMore).toBe(false);
  });

  it('stops a rare search at the scan budget and continues on the next call', async () => {
    const source = new FakeSource({
      a: range(1, 100).map((time) => record('a', time, time === 5 ? 'match' : 'other')),
    });
    const pager = new RecordsPager(source, { pageSize: 3, filteredChunkSize: 20, scanBudget: 40 });
    pager.start({ deviceIds: ['a'], matches: (item) => item.text === 'match' });

    await pager.loadMore();
    expect(pager.loaded).toHaveLength(0);
    expect(pager.scanned).toBe(40);
    expect(pager.hasMore).toBe(true);

    await pager.loadMore();
    await pager.loadMore();
    expect(times(pager.loaded)).toEqual([5]);
    expect(pager.hasMore).toBe(false);
  });

  it('shares one run between overlapping loadMore calls', async () => {
    const source = new FakeSource({ a: range(1, 20).map((time) => record('a', time)) });
    const pager = new RecordsPager(source, { pageSize: 5 });
    pager.start({ deviceIds: ['a'] });

    await Promise.all([pager.loadMore(), pager.loadMore()]);
    expect(pager.loaded).toHaveLength(5);
    expect(source.requests).toHaveLength(1);
  });

  it('drops the results of a query that was replaced while loading', async () => {
    const source = new FakeSource({
      a: [1, 2].map((time) => record('a', time)),
      b: [7, 8].map((time) => record('b', time)),
    });
    const pager = new RecordsPager(source, { pageSize: 5 });

    pager.start({ deviceIds: ['a'] });
    const abandoned = pager.loadMore();
    pager.start({ deviceIds: ['b'] });
    await Promise.all([abandoned, pager.loadMore()]);

    expect(times(pager.loaded)).toEqual([8, 7]);
  });

  it('rejects when a read fails and recovers on retry', async () => {
    const source = new FakeSource({ a: [1, 2, 3].map((time) => record('a', time)) });
    const pager = new RecordsPager(source, { pageSize: 2 });
    pager.start({ deviceIds: ['a'] });

    source.failNext = true;
    await expect(pager.loadMore()).rejects.toThrow('permission_denied');
    expect(pager.loaded).toHaveLength(0);

    await pager.loadMore();
    expect(times(pager.loaded)).toEqual([3, 2]);
  });

  it('has nothing to load without devices', async () => {
    const pager = new RecordsPager(new FakeSource({}), { pageSize: 5 });
    pager.start({ deviceIds: [] });

    expect(pager.hasMore).toBe(false);
    await pager.loadMore();
    expect(pager.loaded).toEqual([]);
  });

  describe('live records', () => {
    it('follows each device from its newest fetched key and adds new records on top', async () => {
      const onLiveRecords = vi.fn();
      const source = new FakeSource({
        a: [1, 2, 3].map((time) => record('a', time)),
        b: [],
      });
      const pager = new RecordsPager(source, { pageSize: 2, onLiveRecords });
      pager.start({ deviceIds: ['a', 'b'], live: true });
      await pager.loadMore();

      expect(source.tails.get('a')?.fromKey).toBe(key(3));
      expect(source.tails.get('b')?.fromKey).toBeUndefined();

      // The tail starts at the newest fetched record, so that record comes back too.
      source.tails.get('a')?.emit([record('a', 3), record('a', 7)]);
      source.tails.get('b')?.emit([record('b', 6)]);
      source.tails.get('a')?.emit([record('a', 3), record('a', 7)]);

      expect(times(pager.loaded)).toEqual([7, 6, 3, 2]);
      expect(onLiveRecords).toHaveBeenCalledTimes(2);
    });

    it('keeps a tail closed while its device is being read', async () => {
      const source = new FakeSource({ a: range(1, 30).map((time) => record('a', time)) });
      const pager = new RecordsPager(source, { pageSize: 5 });
      pager.start({ deviceIds: ['a'], live: true });

      await pager.loadMore();
      await pager.loadMore();
      await pager.loadMore();

      expect(source.overlaps).toEqual([]);
      expect(source.tails.has('a')).toBe(true);
    });

    it('ignores live records outside the key range or the filter', async () => {
      const source = new FakeSource({ a: [1].map((time) => record('a', time, 'match')) });
      const pager = new RecordsPager(source, { pageSize: 5 });
      pager.start({
        deviceIds: ['a'],
        live: true,
        keyRange: { endKey: key(50) },
        matches: (item) => item.text === 'match',
      });
      await pager.loadMore();

      source.tails.get('a')?.emit([record('a', 10, 'other'), record('a', 60, 'match')]);
      expect(times(pager.loaded)).toEqual([1]);

      source.tails.get('a')?.emit([record('a', 20, 'match')]);
      // 20 is older than the newest key already seen (60), so it is not treated as new.
      expect(times(pager.loaded)).toEqual([1]);
    });

    it('opens no tails unless asked, and closes them on dispose and suspend', async () => {
      const source = new FakeSource({ a: [1].map((time) => record('a', time)) });

      const quiet = new RecordsPager(source, { pageSize: 5 });
      quiet.start({ deviceIds: ['a'] });
      await quiet.loadMore();
      expect(source.tails.size).toBe(0);

      const live = new RecordsPager(source, { pageSize: 5 });
      live.start({ deviceIds: ['a'], live: true });
      await live.loadMore();
      expect(source.tails.size).toBe(1);

      live.suspendLive();
      expect(source.tails.size).toBe(0);
      live.resumeLive();
      expect(source.tails.size).toBe(1);

      live.dispose();
      expect(source.tails.size).toBe(0);
    });

    it('keeps following a device after a later read of it fails', async () => {
      const source = new FakeSource({ a: range(1, 30).map((time) => record('a', time)) });
      const pager = new RecordsPager(source, { pageSize: 5 });
      pager.start({ deviceIds: ['a'], live: true });
      await pager.loadMore();

      source.failNext = true;
      await expect(pager.loadMore()).rejects.toThrow('permission_denied');
      expect(source.tails.has('a')).toBe(true);

      source.tails.get('a')?.emit([record('a', 31)]);
      expect(times(pager.loaded)[0]).toBe(31);
    });

    it('does not open a tail for a device that was never read', async () => {
      const source = new FakeSource({ a: [1].map((time) => record('a', time)) });
      const pager = new RecordsPager(source, { pageSize: 5 });
      pager.start({ deviceIds: ['a'], live: true });

      pager.resumeLive();
      expect(source.tails.size).toBe(0);
    });
  });
});

describe('collectRecords', () => {
  const source = new FakeSource({
    a: range(1, 40).map((time) => record('a', time)),
    b: range(41, 60).map((time) => record('b', time)),
  });

  it('reads every matching record across devices', async () => {
    const result = await collectRecords(source, { deviceIds: ['a', 'b'] }, 1000, 25);
    expect(times(result.records)).toEqual(range(1, 60).reverse());
    expect(result.truncated).toBe(false);
  });

  it('stops at the limit and says so', async () => {
    const result = await collectRecords(source, { deviceIds: ['a', 'b'] }, 30, 25);
    expect(times(result.records)).toEqual(range(31, 60).reverse());
    expect(result.truncated).toBe(true);
  });
});
