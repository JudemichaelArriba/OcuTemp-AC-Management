import { Injectable } from '@angular/core';
import { Database, get, onValue, ref } from '@angular/fire/database';

export interface DeviceTelemetry {
  temperature?: number;
  humidity?: number;
  occupancy?: boolean;
  acState?: {
    power?: boolean;
    currentTemp?: number;
    roomUid?: string;
    source?: string;
    updatedAt?: string;
  };
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

  streamDevices(callback: (devices: Record<string, DeviceTelemetry>) => void): () => void {
    const devicesRef = ref(this.db, 'devices');
    return onValue(devicesRef, (snapshot) => {
      if (!snapshot.exists()) {
        callback({});
        return;
      }
      callback(snapshot.val() as Record<string, DeviceTelemetry>);
    });
  }

  streamDevice(deviceId: string, callback: (device: DeviceTelemetry | null) => void): () => void {
    const deviceRef = ref(this.db, `devices/${deviceId}`);
    return onValue(deviceRef, (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }
      callback(snapshot.val() as DeviceTelemetry);
    });
  }

  private ensureCurrentDevice(list: string[], currentDeviceId?: string): string[] {
    if (!currentDeviceId) return list;
    if (list.includes(currentDeviceId)) return list;
    return [currentDeviceId, ...list];
  }



  streamDevicesByIds(
    deviceIds: string[],
    callback: (devices: Record<string, DeviceTelemetry>) => void
  ): () => void {
    const uniqueIds = Array.from(new Set(deviceIds)).filter(id => id.length > 0);
    const deviceMap: Record<string, DeviceTelemetry> = {};
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

}
