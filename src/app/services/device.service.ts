import { Injectable } from '@angular/core';
import { Database, get, onValue, ref, set, update } from '@angular/fire/database';
import { Device } from '../models/esp.model';



export type DeviceOnlineState = 'online' | 'stale' | 'offline' | 'unknown';

export function getDeviceOnlineState(lastSeen?: string): DeviceOnlineState {
  if (!lastSeen) return 'offline';
  const ageMs = Date.now() - new Date(lastSeen).getTime();
  if (ageMs < 2 * 60_000) return 'online';
  if (ageMs < 5 * 60_000) return 'stale';
  return 'offline';
}

@Injectable({
  providedIn: 'root'
})
export class DeviceService {
  constructor(private db: Database) { }

  async getAvailableDevices(): Promise<string[]> {
    const devicesRef = ref(this.db, 'devices');
    const roomsRef = ref(this.db, 'rooms');

    const [devicesSnapshot, roomsSnapshot] = await Promise.all([
      get(devicesRef),
      get(roomsRef),
    ]);

    if (!devicesSnapshot.exists()) return [];

    const devices = devicesSnapshot.val() as Record<string, unknown>;
    const allDeviceIds = Object.keys(devices);

    if (!roomsSnapshot.exists()) return allDeviceIds;

    const rooms = roomsSnapshot.val() as Record<string, { device?: string }>;
    const assignedDeviceIds = new Set(
      Object.values(rooms)
        .map((room) => room?.device)
        .filter((deviceId): deviceId is string => typeof deviceId === 'string' && deviceId.length > 0)
    );

    return allDeviceIds.filter((deviceId) => !assignedDeviceIds.has(deviceId));
  }

  async getAvailableDevicesForRoom(currentDeviceId?: string): Promise<string[]> {
    const devicesRef = ref(this.db, 'devices');
    const roomsRef = ref(this.db, 'rooms');

    const [devicesSnapshot, roomsSnapshot] = await Promise.all([
      get(devicesRef),
      get(roomsRef),
    ]);

    if (!devicesSnapshot.exists()) return currentDeviceId ? [currentDeviceId] : [];

    const devices = devicesSnapshot.val() as Record<string, unknown>;
    const allDeviceIds = Object.keys(devices);

    if (!roomsSnapshot.exists()) {
      return this.ensureCurrentDevice(allDeviceIds, currentDeviceId);
    }

    const rooms = roomsSnapshot.val() as Record<string, { device?: string }>;
    const assignedDeviceIds = new Set(
      Object.values(rooms)
        .map((room) => room?.device)
        .filter((deviceId): deviceId is string => typeof deviceId === 'string' && deviceId.length > 0)
    );

    if (currentDeviceId) {
      assignedDeviceIds.delete(currentDeviceId);
    }

    const available = allDeviceIds.filter((deviceId) => !assignedDeviceIds.has(deviceId));
    return this.ensureCurrentDevice(available, currentDeviceId);
  }

  streamDevices(callback: (devices: Record<string, Device>) => void): () => void {
    const devicesRef = ref(this.db, 'devices');
    return onValue(devicesRef, (snapshot) => {
      if (!snapshot.exists()) {
        callback({});
        return;
      }
      callback(snapshot.val() as Record<string, Device>);
    });
  }

  streamDevice(deviceId: string, callback: (device: Device | null) => void): () => void {
    const deviceRef = ref(this.db, `devices/${deviceId}`);
    return onValue(deviceRef, (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }
      callback(snapshot.val() as Device);
    });
  }

  streamDevicesByIds(
    deviceIds: string[],
    callback: (devices: Record<string, Device>) => void
  ): () => void {
    const uniqueIds = Array.from(new Set(deviceIds)).filter(id => id.length > 0);
    const deviceMap: Record<string, Device> = {};
    const unsubs: Array<() => void> = [];

    if (uniqueIds.length === 0) {
      callback({});
      return () => { };
    }

    uniqueIds.forEach((id) => {
      const unsub = this.streamDevice(id, (device) => {
        if (device) {
          deviceMap[id] = device;
        } else {
          delete deviceMap[id];
        }
        callback({ ...deviceMap });
      });
      unsubs.push(unsub);
    });

    return () => {
      unsubs.forEach(fn => fn());
    };
  }

  async setAiAutoApplyEnabled(deviceId: string, enabled: boolean): Promise<void> {
    const safeDeviceId = this.normalizeDeviceId(deviceId);
    const toggleRef = ref(this.db, `devices/${safeDeviceId}/control/aiAutoApply`);
    await set(toggleRef, enabled === true);
  }

  async applyManualOverride(
    deviceId: string,
    payload: { targetTemp: number; overrideUntil: string; requestedBy?: string; roomUid?: string }
  ): Promise<void> {
    const controlRef = ref(this.db, `devices/${deviceId}/control`);
    await update(controlRef, {
      overrideActive: true,
      targetTemp: payload.targetTemp,
      overrideUntil: payload.overrideUntil,
      requestedAt: new Date().toISOString(),
      requestedBy: payload.requestedBy ?? 'unknown',
      roomUid: payload.roomUid ?? ''
    });
  }

  async clearManualOverride(deviceId: string, requestedBy?: string): Promise<void> {
    const controlRef = ref(this.db, `devices/${deviceId}/control`);
    await update(controlRef, {
      overrideActive: false,
      requestedAt: new Date().toISOString(),
      requestedBy: requestedBy ?? 'unknown'
    });
  }

  async sendForcedOff(deviceId: string, requestedBy?: string): Promise<void> {
    const controlRef = ref(this.db, `devices/${deviceId}/control`);
    await update(controlRef, {
      forcedOff: true,
      overrideActive: false,
      requestedAt: new Date().toISOString(),
      requestedBy: requestedBy ?? 'unknown',
    });
  }

  private normalizeDeviceId(deviceId: string): string {
    const normalized = deviceId.trim();
    if (!normalized) {
      throw new Error('Device ID is required');
    }
    if (/[.#$\/\[\]\x00-\x1F\x7F]/.test(normalized)) {
      throw new Error('Device ID contains invalid characters');
    }
    return normalized;
  }

  private ensureCurrentDevice(list: string[], currentDeviceId?: string): string[] {
    if (!currentDeviceId) return list;
    if (list.includes(currentDeviceId)) return list;
    return [currentDeviceId, ...list];
  }
}