import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { RoomService } from '../../services/room.service';
import { DeviceService, DeviceTelemetry } from '../../services/device.service';
import { Room } from '../../models/room.model';

@Component({
  selector: 'app-room-details',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './room-details.html',
  styleUrl: './room-details.css',
})
export class RoomDetails implements OnInit, OnDestroy {
  room: Room | null = null;
  deviceData: DeviceTelemetry | null = null;
  loading = true;
  error: string | null = null;

  private unsubscribeRooms?: () => void;
  private unsubscribeDevices?: () => void;
  private loadingTimeoutId?: ReturnType<typeof setTimeout>;
  private destroyed = false;

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


    this.unsubscribeRooms = this.roomService.streamRooms((rooms) => {
      const foundRoom = rooms.find(r => r.uid === uid);
      if (foundRoom) {
        this.error = null;
        this.room = foundRoom;
        this.loading = false;
        this.clearLoadingTimeout();
        this.refreshView();


        if (foundRoom.device) {
          this.streamDeviceData(foundRoom.device);
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
    this.unsubscribeDevices = this.deviceService.streamDevices((devices) => {
      this.deviceData = devices[deviceId] || null;
      this.refreshView();
    });
  }

  goBack() {
    this.router.navigate(['/app/room-management']);
  }

  editRoom() {

    console.log('Edit room:', this.room?.uid);
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

}
