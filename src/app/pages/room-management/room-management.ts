import { Component, OnDestroy, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { AddRoomModal } from '../../components/add-room-modal/add-room-modal'; 
import { CommonModule } from '@angular/common';
import { Room } from '../../models/room.model'; 
import { FormsModule } from '@angular/forms';
import { RoomCard } from '../../components/room-card/room-card';
import { RoomService } from '../../services/room.service';
import { DeviceService, DeviceTelemetry } from '../../services/device.service';

@Component({
  selector: 'app-room-management',
  standalone: true,
  imports: [CommonModule, FormsModule, AddRoomModal, RoomCard],
  templateUrl: './room-management.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomManagement implements OnInit, OnDestroy {
  showAddModal = false;
  isLoading = true;
  searchQuery = '';
  rooms: Room[] = [];
  filteredRooms: Room[] = [];

  private baseRooms: Room[] = [];
  private deviceMap: Record<string, DeviceTelemetry> = {};
  private stopRoomsStream?: () => void;
  private stopDevicesStream?: () => void;

  constructor(
    private roomService: RoomService,
    private deviceService: DeviceService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.stopRoomsStream = this.roomService.streamRooms((rooms) => {
      this.baseRooms = rooms;
      this.isLoading = false;
      this.mergeRoomTelemetryAndFilter();
    });

    this.stopDevicesStream = this.deviceService.streamDevices((devices) => {
      this.deviceMap = devices;
      this.mergeRoomTelemetryAndFilter();
    });
  }

  ngOnDestroy(): void {
    this.stopRoomsStream?.();
    this.stopDevicesStream?.();
  }

  onRoomAdded(room: Room): void {
    console.log('New room added:', room);
  }

  onSearch(): void {
    this.mergeRoomTelemetryAndFilter();
  }

  trackByRoomId(index: number, room: Room): string {
    return room.uid;
  }

  get totalRooms(): number {
    return this.rooms.length;
  }

  get activeRooms(): number {
    return this.rooms.filter((room) => room.status === 'active').length;
  }

  get roomsWithTelemetry(): number {
    return this.rooms.filter((room) => room.temperature !== undefined || room.humidity !== undefined).length;
  }

  get roomsWithoutDevice(): number {
    return this.rooms.filter((room) => !room.device).length;
  }

  private mergeRoomTelemetryAndFilter(): void {
    this.rooms = this.baseRooms.map((room) => {
      const telemetry = room.device ? this.deviceMap[room.device] : undefined;
      return {
        ...room,
        temperature: telemetry?.temperature ?? room.temperature,
        humidity: telemetry?.humidity ?? room.humidity,
      };
    });

    const query = this.searchQuery.trim().toLowerCase();
    if (!query) {
      this.filteredRooms = this.rooms;
    } else {
      this.filteredRooms = this.rooms.filter((room) =>
        room.roomName.toLowerCase().includes(query) ||
        room.uid.toLowerCase().includes(query) ||
        (room.device ?? '').toLowerCase().includes(query)
      );
    }

    this.cdr.markForCheck();
  }
}
