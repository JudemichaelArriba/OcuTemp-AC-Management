import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { RoomService } from '../../services/room.service';
import { DeviceService, DeviceTelemetry } from '../../services/device.service';
import { Room } from '../../models/room.model';
import { RoomEditModal } from '../../components/room-edit-modal/room-edit-modal';

@Component({
  selector: 'app-room-details',
  standalone: true,
  imports: [CommonModule, RoomEditModal],
  templateUrl: './room-details.html',
  styleUrl: './room-details.css',
})
export class RoomDetails implements OnInit, OnDestroy {
  room: Room | null = null;
  deviceData: DeviceTelemetry | null = null;
  loading = true;
  error: string | null = null;
  isEditModalOpen = false;

  private unsubscribeRooms?: () => void;
  private unsubscribeDevices?: () => void;
  private loadingTimeoutId?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private currentDeviceId: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private roomService: RoomService,
    private deviceService: DeviceService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit() {
    const uid = this.route.snapshot.paramMap.get('uid');
    if (!uid) {
      this.error = 'Room ID not found';
      this.loading = false;
      this.refreshView();
      return;
    }


    this.loadingTimeoutId = setTimeout(() => {
      if (this.loading) {
        this.error = 'Loading timed out. Please refresh and try again.';
        this.loading = false;
        this.refreshView();
      }
    }, 12000);


    this.unsubscribeRooms = this.roomService.streamRoomById(uid, (foundRoom) => {
      if (foundRoom) {
        this.error = null;
        this.room = foundRoom;
        this.loading = false;
        this.clearLoadingTimeout();
        this.refreshView();


        const nextDeviceId = foundRoom.device || null;
        if (nextDeviceId !== this.currentDeviceId) {
          this.currentDeviceId = nextDeviceId;
          this.deviceData = null;
          this.unsubscribeDevices?.();
          this.unsubscribeDevices = undefined;
          if (nextDeviceId) {
            this.streamDeviceData(nextDeviceId);
          }
        } else if (nextDeviceId && !this.unsubscribeDevices) {
          this.streamDeviceData(nextDeviceId);
        }
      } else {
        this.error = 'Room not found';
        this.loading = false;
        this.clearLoadingTimeout();
        this.refreshView();
      }
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.unsubscribeRooms?.();
    this.unsubscribeDevices?.();
    this.clearLoadingTimeout();
  }
  private streamDeviceData(deviceId: string) {
    this.unsubscribeDevices = this.deviceService.streamDevice(deviceId, (device) => {
      this.deviceData = device;
      this.refreshView();
    });
  }

  goBack() {
    this.router.navigate(['/app/room-management']);
  }

  editRoom() {
    if (!this.room || this.loading) return;
    this.isEditModalOpen = true;
    this.refreshView();
  }

  onEditModalClosed(): void {
    this.isEditModalOpen = false;
    this.refreshView();
  }

  onRoomUpdated(updated: Room): void {
    this.room = updated;
    this.isEditModalOpen = false;
    this.refreshView();
  }

  get statusBadgeClass(): string {
    return this.room?.power === true
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-slate-100 text-slate-600';
  }

  get statusText(): string {
    return this.room?.power === true ? 'ON' : 'OFF';
  }
  get acPowerText(): string {
    if (!this.deviceData?.acState?.power) return this.deviceData?.acState?.power === false ? 'OFF' : '--';
    return 'ON';
  }

  private clearLoadingTimeout(): void {
    if (this.loadingTimeoutId) {
      clearTimeout(this.loadingTimeoutId);
      this.loadingTimeoutId = undefined;
    }
  }

  private refreshView(): void {
    if (!this.destroyed) {
      this.cdr.detectChanges();
    }
  }

  get environmentalTemperature(): number | null {
    if (this.room?.device && this.deviceData?.temperature !== undefined) {
      return this.deviceData.temperature;
    }
    return this.room?.temperature ?? null;
  }

  get environmentalHumidity(): number | null {
    if (this.room?.device && this.deviceData?.humidity !== undefined) {
      return this.deviceData.humidity;
    }
    return this.room?.humidity ?? null;
  }

  get environmentalOccupancy(): boolean | null {
    if (this.room?.device && this.deviceData?.occupancy !== undefined) {
      return this.deviceData.occupancy;
    }
    return this.room?.occupancy ?? null;
  }

}
