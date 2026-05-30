import { Component, OnDestroy, OnInit, ChangeDetectionStrategy, ChangeDetectorRef, NgZone } from '@angular/core';
import { AddRoomModal } from '../../components/add-room-modal/add-room-modal'; 
import { Room } from '../../models/room.model'; 
import { FormsModule } from '@angular/forms';
import { RoomCard } from '../../components/room-card/room-card';
import { RoomService } from '../../services/room.service';
import { DeviceService,getDeviceOnlineState } from '../../services/device.service';
import { Device } from '../../models/esp.model';
import { DialogService } from '../../services/dialog.service';
import { mergeRoomsWithTelemetry } from '../../helpers/room-telemetry';
import { AuthStateService } from '../../services/auth-state.service';
import { Subscription } from 'rxjs';
import { FloorPlanCellSelection, FloorPlanComponent } from '../../components/floor-plan/floor-plan';
import { FloorPlanRoomModal } from '../../components/floor-plan-room-modal/floor-plan-room-modal';
import { MlSuggestionService } from '../../services/ml-suggestion.service';


@Component({
  selector: 'app-room-management',
  standalone: true,
  imports: [FormsModule, AddRoomModal, RoomCard, FloorPlanComponent, FloorPlanRoomModal],
  templateUrl: './room-management.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomManagement implements OnInit, OnDestroy {
  showAddModal = false;
  isLoading = true; 
  useAnimations = false; 
  searchQuery = '';
  
  rooms: Room[] = [];
  filteredRooms: Room[] = [];
  isAdmin = false;
  viewMode: 'cards' | 'map' = 'cards';
  
  floorPlanEditMode = false;
  selectedMapRoom: Room | undefined;
  selectedFloorPlanCell: FloorPlanCellSelection | null = null;
  
  displayTotalRooms: number = 0;
  displayActiveRooms: number = 0;
  displayRoomsWithTelemetry: number = 0;
  displayRoomsWithoutDevice: number = 0;

  private isRoomsLoaded = false;
  private isDevicesLoaded = false;

  private baseRooms: Room[] = [];
  private deviceMap: Record<string, Device> = {};
  private stopRoomsStream?: () => void;
  private stopDevicesStream?: () => void;
  private authSub?: Subscription;

  constructor(
    private roomService: RoomService,
    private deviceService: DeviceService,
    private dialogService: DialogService,
    private cdr: ChangeDetectorRef,
    private authState: AuthStateService,
    private mlSuggestionService: MlSuggestionService,
    private ngZone: NgZone
  ) {}

  ngOnInit(): void {
    if (!sessionStorage.getItem('room_mgmt_animated')) {
      this.useAnimations = true;
      sessionStorage.setItem('room_mgmt_animated', 'true');
    }

    this.authSub = this.authState.currentUser$.subscribe((user) => {
      this.isAdmin = user?.role === 'admin';
      if (!this.isAdmin) {
        this.floorPlanEditMode = false;
        this.selectedFloorPlanCell = null;
      }
      this.cdr.markForCheck();
    });

    this.stopRoomsStream = this.roomService.streamRooms((rooms) => {
      this.baseRooms = rooms;
      this.isRoomsLoaded = true;
      this.mergeRoomTelemetryAndFilter();
    });

    this.stopDevicesStream = this.deviceService.streamDevices((devices) => {
      this.deviceMap = devices;
      this.isDevicesLoaded = true;
      this.mergeRoomTelemetryAndFilter();
    });
  }

  ngOnDestroy(): void {
    this.stopRoomsStream?.();
    this.stopDevicesStream?.();
    this.authSub?.unsubscribe();
  }

  private mergeRoomTelemetryAndFilter(): void {
    const roomsWithTelemetry = mergeRoomsWithTelemetry(this.baseRooms, this.deviceMap, {
      defaultPower: false,
    });
    this.rooms = this.mlSuggestionService.attachPendingSuggestions(roomsWithTelemetry, this.deviceMap);

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

    this.updateDisplayMetrics();
    this.cdr.markForCheck();
  }

  private updateDisplayMetrics(): void {
    if (this.isRoomsLoaded && this.isDevicesLoaded) {
      const wasLoading = this.isLoading;
      this.isLoading = false; 

      if (wasLoading && this.useAnimations) {
        this.animateMetrics();
      } else {
        this.applyRealData(); 
      }
    }
  }

  private animateMetrics(): void {
    this.ngZone.runOutsideAngular(() => {
      const duration = 1000; 
      const targets = [this.totalRooms, this.activeRooms, this.roomsWithTelemetry, this.roomsWithoutDevice];
      let startTimestamp: number | null = null;

      const step = (timestamp: number) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        
        const easeOut = 1 - Math.pow(1 - progress, 3);

        this.displayTotalRooms = Math.floor(easeOut * targets[0]);
        this.displayActiveRooms = Math.floor(easeOut * targets[1]);
        this.displayRoomsWithTelemetry = Math.floor(easeOut * targets[2]);
        this.displayRoomsWithoutDevice = Math.floor(easeOut * targets[3]);

        this.ngZone.run(() => this.cdr.markForCheck());

        if (progress < 1) {
          window.requestAnimationFrame(step);
        } else {
          this.ngZone.run(() => this.applyRealData());
        }
      };
      window.requestAnimationFrame(step);
    });
  }

  private applyRealData(): void {
    this.displayTotalRooms = this.totalRooms;
    this.displayActiveRooms = this.activeRooms;
    this.displayRoomsWithTelemetry = this.roomsWithTelemetry;
    this.displayRoomsWithoutDevice = this.roomsWithoutDevice;
    this.cdr.markForCheck();
  }

  onSearch(): void {
    this.mergeRoomTelemetryAndFilter();
  }

  setViewMode(mode: 'cards' | 'map'): void {
    this.viewMode = mode;
    if (mode !== 'map') {
      this.floorPlanEditMode = false;
      this.selectedFloorPlanCell = null;
    }
    this.cdr.markForCheck();
  }

  toggleFloorPlanEditMode(): void {
    if (!this.isAdmin) return;
    this.floorPlanEditMode = !this.floorPlanEditMode;
    if (!this.floorPlanEditMode) {
      this.selectedFloorPlanCell = null;
    }
    this.cdr.markForCheck();
  }

  trackByRoomId(index: number, room: Room): string {
    return room.uid;
  }

  get totalRooms(): number {
    return this.rooms.length;
  }

  get activeRooms(): number {
    return this.rooms.filter((room) => room.power === true).length;
  }

  get roomsWithTelemetry(): number {
    return this.rooms.filter((room) =>
      room.temperature !== undefined ||
      room.humidity !== undefined ||
      room.occupancy !== undefined
    ).length;
  }

get roomsWithoutDevice(): number {
  return this.rooms.filter((room) => {
    if (!room.device) return true;
    const device = this.deviceMap[room.device];
    return getDeviceOnlineState(device?.status?.lastSeen) === 'offline';
  }).length;
}

  onDeleteRoom(room: Room): void {
    this.dialogService.confirm(
      'Delete Room',
      `Are you sure you want to delete "${room.roomName}"? This action cannot be undone.`,
      async () => {
        try {
          await this.roomService.deleteRoom(room.uid);
          this.dialogService.success('Room Deleted', `The room "${room.roomName}" has been successfully removed.`);
        } catch (error) {
          this.dialogService.error('Error', 'An error occurred while deleting the room. Please try again.');
        }
      },
      undefined,
      'Delete',
      'Cancel'
    );
  }

  onMapRoomSelected(room: Room | undefined): void {
    this.selectedMapRoom = room;
  }

  onFloorPlanCellEditRequested(selection: FloorPlanCellSelection): void {
    if (!this.isAdmin || !this.floorPlanEditMode) return;
    this.selectedFloorPlanCell = selection;
    this.cdr.markForCheck();
  }

  closeFloorPlanModal(): void {
    this.selectedFloorPlanCell = null;
    this.cdr.markForCheck();
  }
}
