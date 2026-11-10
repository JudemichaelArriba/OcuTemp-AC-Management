import { Injectable } from '@angular/core';
import { Database, DataSnapshot, get, ref } from '@angular/fire/database';
import { DeviceRecord, OccupancyLogEntry, OverrideHistoryEntry } from '../models/esp.model';
import { LoggerService } from './logger.service';

/**
 * Read-only access to per-device record sets. Each method reads its node once with `get()`;
 * nothing here opens a live listener or writes.
 */
@Injectable({ providedIn: 'root' })
export class DeviceRecordsService {

  constructor(private db: Database, private logger: LoggerService) { }

  /** Every entry at `devices/{deviceId}/occupancyDebugLog`, in stored (push-key) order. */
  async getOccupancyLog(deviceId: string): Promise<DeviceRecord<OccupancyLogEntry>[]> {
    try {
      const safeDeviceId = this.requireDeviceId(deviceId);
      const snapshot = await get(ref(this.db, `devices/${safeDeviceId}/occupancyDebugLog`));
      return this.readRecords<OccupancyLogEntry>(snapshot);
    } catch (err) {
      this.logger.error('Failed to fetch occupancy log', err, {
        service: 'DeviceRecordsService',
        action: 'getOccupancyLog',
        deviceId,
      });
      throw err;
    }
  }

  /**
   * Entries at `overrideHistory/{deviceId}` that belong to `roomUid`, in stored (push-key)
   * order. A device can be reassigned, so its history may include other rooms' entries.
   */
  async getOverrideHistory(
    deviceId: string,
    roomUid: string
  ): Promise<DeviceRecord<OverrideHistoryEntry>[]> {
    try {
      const safeDeviceId = this.requireDeviceId(deviceId);
      const snapshot = await get(ref(this.db, `overrideHistory/${safeDeviceId}`));
      return this.readRecords<OverrideHistoryEntry>(snapshot)
        .filter((entry) => entry.roomUid === roomUid);
    } catch (err) {
      this.logger.error('Failed to fetch override history', err, {
        service: 'DeviceRecordsService',
        action: 'getOverrideHistory',
        deviceId,
        roomUid,
      });
      throw err;
    }
  }

  private readRecords<T extends object>(snapshot: DataSnapshot): DeviceRecord<T>[] {
    const records: DeviceRecord<T>[] = [];
    snapshot.forEach((child) => {
      const value: unknown = child.val();
      if (child.key && typeof value === 'object' && value !== null) {
        records.push({ ...(value as T), id: child.key });
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
