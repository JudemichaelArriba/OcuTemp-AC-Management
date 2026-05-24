import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Device } from '../models/esp.model';
import { Room } from '../models/room.model';
import { DeviceService, getDeviceOnlineState } from './device.service';
import { LoggerService } from './logger.service';
import { RoomService } from './room.service';
import { SnackBarService } from './snack-bar.service';

interface OfflineDeviceAlert {
  deviceId: string;
  room: Room;
}

@Injectable({ providedIn: 'root' })
export class DeviceOfflineMonitorService {
  private static readonly CHECK_INTERVAL_MS = 60_000;

  private rooms: Room[] = [];
  private devices: Record<string, Device> = {};
  private alertedDeviceIds = new Set<string>();

  private roomsReady = false;
  private devicesReady = false;
  private started = false;
  private stopRoomsStream?: () => void;
  private stopDevicesStream?: () => void;
  private checkInterval?: ReturnType<typeof setInterval>;

  constructor(
    private roomService: RoomService,
    private deviceService: DeviceService,
    private snackBar: SnackBarService,
    private router: Router,
    private logger: LoggerService,
  ) {}

  start(): void {
    if (this.started) return;

    this.started = true;
    this.roomsReady = false;
    this.devicesReady = false;

    this.stopRoomsStream = this.roomService.streamRoomsByStatus(
      'active',
      (rooms) => {
        this.rooms = rooms;
        this.roomsReady = true;
        this.evaluate();
      },
      (error) => this.handleStreamError('rooms', error),
    );

    this.stopDevicesStream = this.deviceService.streamDevices(
      (devices) => {
        this.devices = devices;
        this.devicesReady = true;
        this.evaluate();
      },
      (error) => this.handleStreamError('devices', error),
    );

    this.checkInterval = setInterval(() => this.evaluate(), DeviceOfflineMonitorService.CHECK_INTERVAL_MS);
  }

  stop(): void {
    this.stopRoomsStream?.();
    this.stopDevicesStream?.();
    clearInterval(this.checkInterval);

    this.rooms = [];
    this.devices = {};
    this.alertedDeviceIds.clear();
    this.roomsReady = false;
    this.devicesReady = false;
    this.started = false;
    this.stopRoomsStream = undefined;
    this.stopDevicesStream = undefined;
    this.checkInterval = undefined;
  }

  private evaluate(): void {
    if (!this.started || !this.roomsReady || !this.devicesReady) return;

    const assignedRoomByDevice = this.getAssignedRoomByDevice();
    this.resetRecoveredDevices(assignedRoomByDevice);

    const newlyOffline = Array.from(assignedRoomByDevice.entries())
      .filter(([deviceId]) => !this.alertedDeviceIds.has(deviceId))
      .filter(([deviceId]) => getDeviceOnlineState(this.devices[deviceId]?.status?.lastSeen) === 'offline')
      .map(([deviceId, room]) => ({ deviceId, room }));

    if (newlyOffline.length === 0) return;

    newlyOffline.forEach((alert) => this.alertedDeviceIds.add(alert.deviceId));
    this.showOfflineAlert(newlyOffline);
  }

  private getAssignedRoomByDevice(): Map<string, Room> {
    const assignedRoomByDevice = new Map<string, Room>();

    this.rooms.forEach((room) => {
      const deviceId = room.device?.trim();
      if (!deviceId || assignedRoomByDevice.has(deviceId)) return;
      assignedRoomByDevice.set(deviceId, room);
    });

    return assignedRoomByDevice;
  }

  private resetRecoveredDevices(assignedRoomByDevice: Map<string, Room>): void {
    Array.from(this.alertedDeviceIds).forEach((deviceId) => {
      if (!assignedRoomByDevice.has(deviceId)) {
        this.alertedDeviceIds.delete(deviceId);
        return;
      }

      const state = getDeviceOnlineState(this.devices[deviceId]?.status?.lastSeen);
      if (state !== 'offline') {
        this.alertedDeviceIds.delete(deviceId);
      }
    });
  }

  private showOfflineAlert(alerts: OfflineDeviceAlert[]): void {
    if (alerts.length === 1) {
      const alert = alerts[0];
      this.snackBar.warning(
        'Device offline',
        `${alert.room.roomName} (${alert.deviceId}) has not reported in over 5 minutes.`,
        {
          actionLabel: 'View room',
          dedupeKey: `device-offline:${alert.deviceId}`,
          durationMs: 8000,
          icon: 'router',
          onAction: () => {
            void this.router.navigate(['/app/room-details', alert.room.uid]);
          },
        },
      );
      return;
    }

    const deviceIds = alerts.map((alert) => alert.deviceId).sort();
    const roomNames = alerts.slice(0, 2).map((alert) => alert.room.roomName).join(', ');
    const remainingCount = Math.max(alerts.length - 2, 0);
    const messageSuffix = remainingCount > 0 ? ` and ${remainingCount} more` : '';

    this.snackBar.warning(
      `${alerts.length} devices offline`,
      `${roomNames}${messageSuffix} need attention.`,
      {
        actionLabel: 'View rooms',
        dedupeKey: `devices-offline:${deviceIds.join('|')}`,
        durationMs: 9000,
        icon: 'sensors_off',
        onAction: () => {
          void this.router.navigate(['/app/room-management']);
        },
      },
    );
  }

  private handleStreamError(stream: 'rooms' | 'devices', error: Error): void {
    this.logger.error('Offline device monitor stream failed', error, {
      service: 'DeviceOfflineMonitorService',
      stream,
    });
  }
}
