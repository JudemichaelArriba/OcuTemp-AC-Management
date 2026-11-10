import { Injectable } from '@angular/core';
import { Database, DataSnapshot, onValue, ref } from '@angular/fire/database';
import { DeviceRecord, OccupancyLogEntry, OverrideHistoryEntry } from '../models/esp.model';
import { LoggerContext, LoggerService } from './logger.service';

/**
 * Read-only live access to per-device record sets. Every stream method returns an
 * unsubscribe function; call it in `ngOnDestroy`. Nothing here writes.
 */
@Injectable({ providedIn: 'root' })
export class DeviceRecordsService {

  constructor(private db: Database, private logger: LoggerService) { }

  /** Streams every entry at `devices/{deviceId}/occupancyDebugLog`, in stored (push-key) order. */
  streamOccupancyLog(
    deviceId: string,
    callback: (records: DeviceRecord<OccupancyLogEntry>[]) => void,
    onError?: (error: Error) => void
  ): () => void {
    return this.streamRecords<OccupancyLogEntry>(
      (safeDeviceId) => `devices/${safeDeviceId}/occupancyDebugLog`,
      deviceId,
      callback,
      onError,
      { action: 'streamOccupancyLog', deviceId },
      'Occupancy log stream failed'
    );
  }

  /**
   * Streams every entry at `overrideHistory/{deviceId}`, in stored (push-key) order. A device
   * can be reassigned, so entries carry the `roomUid` they were made for.
   */
  streamOverrideHistory(
    deviceId: string,
    callback: (records: DeviceRecord<OverrideHistoryEntry>[]) => void,
    onError?: (error: Error) => void
  ): () => void {
    return this.streamRecords<OverrideHistoryEntry>(
      (safeDeviceId) => `overrideHistory/${safeDeviceId}`,
      deviceId,
      callback,
      onError,
      { action: 'streamOverrideHistory', deviceId },
      'Override history stream failed'
    );
  }

  private streamRecords<T extends object>(
    buildPath: (safeDeviceId: string) => string,
    deviceId: string,
    callback: (records: DeviceRecord<T>[]) => void,
    onError: ((error: Error) => void) | undefined,
    context: LoggerContext,
    failureMessage: string
  ): () => void {
    const fail = (error: unknown): void => {
      this.logger.error(failureMessage, error, { service: 'DeviceRecordsService', ...context });
      onError?.(error instanceof Error ? error : new Error(String(error)));
    };

    try {
      const safeDeviceId = this.requireDeviceId(deviceId);
      return onValue(
        ref(this.db, buildPath(safeDeviceId)),
        (snapshot) => callback(this.readRecords<T>(snapshot, safeDeviceId)),
        fail
      );
    } catch (err) {
      fail(err);
      return () => { };
    }
  }

  /** Record ids are prefixed with the device so they stay unique across devices. */
  private readRecords<T extends object>(snapshot: DataSnapshot, deviceId: string): DeviceRecord<T>[] {
    const records: DeviceRecord<T>[] = [];
    snapshot.forEach((child) => {
      const value: unknown = child.val();
      if (child.key && typeof value === 'object' && value !== null) {
        records.push({ ...(value as T), id: `${deviceId}/${child.key}`, deviceId });
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
