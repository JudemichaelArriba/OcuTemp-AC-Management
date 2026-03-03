import { Injectable } from '@angular/core';
import { Database, onValue, ref } from '@angular/fire/database';

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
