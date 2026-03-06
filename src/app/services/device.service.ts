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
  constructor(private db: Database) {}

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
}
