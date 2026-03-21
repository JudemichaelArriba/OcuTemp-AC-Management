import { Component, OnDestroy, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { Room } from '../../models/room.model';
import { RoomService } from '../../services/room.service';
import { DeviceService, DeviceTelemetry } from '../../services/device.service';
import { RoomCard } from '../../components/room-card/room-card';
import { mergeRoomsWithTelemetry } from '../../helpers/room-telemetry';




@Component({
  selector: 'app-dashboard',
  imports: [RoomCard],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Dashboard {
  isLoading: boolean = true;
  rooms: Room[] = [];

  private baseRooms: Room[] = [];
  private deviceMap: Record<string, DeviceTelemetry> = {};
  private stopRoomStream?: () => void;
  private stopDevicesStream?: () => void;

  constructor(
    private roomService: RoomService,
    private deviceService: DeviceService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit(): void {
    this.stopRoomStream = this.roomService.streamRoomsByStatus('active', (rooms) => {
      this.baseRooms = rooms;

      const deviceIds = rooms
        .map(room => room.device)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      this.stopDevicesStream?.();

      let isFirstDeviceLoad = true;
      this.stopDevicesStream = this.deviceService.streamDevicesByIds(deviceIds, (devices) => {
        this.deviceMap = devices;
        if (isFirstDeviceLoad && Object.keys(devices).length === deviceIds.length) {
          this.isLoading = false;
          isFirstDeviceLoad = false;
        }

        this.mergeRoomTelemetry();
      });
    });
  }



  ngOnDestroy(): void {
    this.stopRoomStream?.();
    this.stopDevicesStream?.();
  }


  private mergeRoomTelemetry(): void {
    this.rooms = mergeRoomsWithTelemetry(this.baseRooms, this.deviceMap, {
      fallbackToRoomPower: true,
      defaultPower: false,
    });
    this.cdr.markForCheck();
  }



}
