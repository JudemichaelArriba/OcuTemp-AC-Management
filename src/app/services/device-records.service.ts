import { Injectable } from '@angular/core';
import {
  Database, DataSnapshot, QueryConstraint,
  endAt, get, limitToLast, onValue, orderByKey, query, ref, startAt,
} from '@angular/fire/database';
import { DeviceRecord, OccupancyLogEntry, OverrideHistoryEntry } from '../models/esp.model';
import { RecordPage, RecordPageRequest } from '../helpers/records-pager';
import { LoggerContext, LoggerService } from './logger.service';

/** Most records a live tail keeps in view. New records arrive one at a time. */
const LIVE_TAIL_LIMIT = 20;

type RecordKind = 'occupancy' | 'override';

const RECORD_PATHS: Record<RecordKind, (safeDeviceId: string) => string> = {
  occupancy: (safeDeviceId) => `devices/${safeDeviceId}/occupancyDebugLog`,
  override: (safeDeviceId) => `overrideHistory/${safeDeviceId}`,
};

/**
 * Read-only access to the per-device record lists `devices/{deviceId}/occupancyDebugLog`
 * and `overrideHistory/{deviceId}`. Both are read a page at a time by push key, newest
 * first, so a list is never downloaded whole. Nothing here writes.
 */
@Injectable({ providedIn: 'root' })
export class DeviceRecordsService {

  constructor(private db: Database, private logger: LoggerService) { }

  fetchOccupancyPage(
    deviceId: string,
    request: RecordPageRequest
  ): Promise<RecordPage<DeviceRecord<OccupancyLogEntry>>> {
    return this.fetchPage<OccupancyLogEntry>('occupancy', deviceId, request);
  }

  fetchOverridePage(
    deviceId: string,
    request: RecordPageRequest
  ): Promise<RecordPage<DeviceRecord<OverrideHistoryEntry>>> {
    return this.fetchPage<OverrideHistoryEntry>('override', deviceId, request);
  }

  /**
   * Streams occupancy entries whose push key is `fromKey` or newer. Returns an unsubscribe
   * function. Do not keep it open while paging the same device with `fetchOccupancyPage`.
   */
  streamOccupancyFrom(
    deviceId: string,
    fromKey: string | undefined,
    callback: (records: DeviceRecord<OccupancyLogEntry>[]) => void,
    onError?: (error: Error) => void
  ): () => void {
    return this.streamFrom<OccupancyLogEntry>('occupancy', deviceId, fromKey, callback, onError);
  }

  /** Override-history counterpart of {@link streamOccupancyFrom}. */
  streamOverridesFrom(
    deviceId: string,
    fromKey: string | undefined,
    callback: (records: DeviceRecord<OverrideHistoryEntry>[]) => void,
    onError?: (error: Error) => void
  ): () => void {
    return this.streamFrom<OverrideHistoryEntry>('override', deviceId, fromKey, callback, onError);
  }

  /**
   * One page of a device's records, newest first.
   *
   * The cursor is anchored with `endAt(before)` and the cursor row dropped afterwards:
   * `endBefore(key) + limitToLast(N)` under-counts by one (see `LogService.fetchPage`).
   * One extra row is requested to learn whether older records exist.
   */
  private async fetchPage<T extends object>(
    kind: RecordKind,
    deviceId: string,
    request: RecordPageRequest
  ): Promise<RecordPage<DeviceRecord<T>>> {
    try {
      const safeDeviceId = this.requireDeviceId(deviceId);
      const { limit, before, keyRange } = request;
      const constraints: QueryConstraint[] = [orderByKey()];

      if (keyRange?.startKey) constraints.push(startAt(keyRange.startKey));
      if (before) constraints.push(endAt(before));
      else if (keyRange?.endKey) constraints.push(endAt(keyRange.endKey));
      constraints.push(limitToLast(before ? limit + 2 : limit + 1));

      const snapshot = await get(
        query(ref(this.db, RECORD_PATHS[kind](safeDeviceId)), ...constraints)
      );
      const records = this.readRecords<T>(snapshot, safeDeviceId)
        .filter((record) => record.key !== before)
        .reverse();

      return { records: records.slice(0, limit), hasMore: records.length > limit };
    } catch (err) {
      this.logger.error('Failed to fetch device records page', err, {
        service: 'DeviceRecordsService',
        action: 'fetchPage',
        kind,
        deviceId,
        hasCursor: request.before !== undefined,
        hasRange: request.keyRange !== undefined,
      });
      throw err;
    }
  }

  private streamFrom<T extends object>(
    kind: RecordKind,
    deviceId: string,
    fromKey: string | undefined,
    callback: (records: DeviceRecord<T>[]) => void,
    onError?: (error: Error) => void
  ): () => void {
    const context: LoggerContext = {
      service: 'DeviceRecordsService',
      action: 'streamFrom',
      kind,
      deviceId,
    };
    const fail = (error: unknown): void => {
      this.logger.error('Device records stream failed', error, context);
      onError?.(error instanceof Error ? error : new Error(String(error)));
    };

    try {
      const safeDeviceId = this.requireDeviceId(deviceId);
      const constraints: QueryConstraint[] = [orderByKey()];
      if (fromKey) constraints.push(startAt(fromKey));
      constraints.push(limitToLast(LIVE_TAIL_LIMIT));

      return onValue(
        query(ref(this.db, RECORD_PATHS[kind](safeDeviceId)), ...constraints),
        (snapshot) => callback(this.readRecords<T>(snapshot, safeDeviceId)),
        fail
      );
    } catch (err) {
      fail(err);
      return () => { };
    }
  }

  /** Oldest first, as stored. Entries that are not objects are skipped. */
  private readRecords<T extends object>(snapshot: DataSnapshot, deviceId: string): DeviceRecord<T>[] {
    const records: DeviceRecord<T>[] = [];
    snapshot.forEach((child) => {
      const value: unknown = child.val();
      if (child.key && typeof value === 'object' && value !== null) {
        records.push({ ...(value as T), id: `${deviceId}/${child.key}`, key: child.key, deviceId });
      }
    });
    return records;
  }

  /** Rejects IDs that are empty or would change the database path being read. */
  private requireDeviceId(deviceId: string): string {
    const normalized = deviceId.trim();
    if (!normalized) {
      throw new Error('Device ID is required');
    }
    if (/[.#$\/\[\]\x00-\x1F\x7F]/.test(normalized)) {
      throw new Error('Device ID contains invalid characters');
    }
    return normalized;
  }
}
