import { Component, OnDestroy, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { Room } from '../../models/room.model';
import { RoomService } from '../../services/room.service';
import { DeviceService, DeviceTelemetry } from '../../services/device.service';
import { RoomCard } from '../../components/room-card/room-card';




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
  private stopDeviceStream?: () => void;

  constructor(
    private roomService: RoomService,
    private deviceService: DeviceService,
    private cdr: ChangeDetectorRef
  ) { }


  ngOnInit(): void {
    this.stopRoomStream = this.roomService.streamRooms((rooms) => {
      this.baseRooms = rooms;
      this.isLoading = false;
      this.mergeRoomTelemetry();
    });

    this.stopDeviceStream = this.deviceService.streamDevices((devices) => {
      this.deviceMap = devices;
      this.mergeRoomTelemetry();
    });
  }



  ngOnDestroy(): void {
    this.stopRoomStream?.();
    this.stopDeviceStream?.();
  }

  private mergeRoomTelemetry(): void {
   this.rooms = this.baseRooms.map((room)=>{
      const telemetry = room.device ? this.deviceMap[room.device] : undefined;
    return{
        ...room,
        temperature: telemetry?.temperature ?? room.temperature,
        humidity: telemetry?.humidity ?? room.humidity,
        occupancy: telemetry?.occupancy ?? room.occupancy,
        power: telemetry?.acState?.power ?? room.power ?? false,
    };
   });
   this.cdr.markForCheck();
  }



}
