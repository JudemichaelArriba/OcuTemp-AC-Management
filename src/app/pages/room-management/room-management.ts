import { Component, OnDestroy, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { AddRoomModal } from '../../components/add-room-modal/add-room-modal'; 
import { Room } from '../../models/room.model'; 
import { FormsModule } from '@angular/forms';
import { RoomCard } from '../../components/room-card/room-card';
import { RoomService } from '../../services/room.service';
import { DeviceService, DeviceTelemetry } from '../../services/device.service';
import { DialogService } from '../../services/dialog.service';
import { mergeRoomsWithTelemetry } from '../../helpers/room-telemetry';
import { AuthStateService } from '../../services/auth-state.service';
import { Subscription } from 'rxjs';
import { FloorPlanCellSelection, FloorPlanComponent } from '../../components/floor-plan/floor-plan';
import { FloorPlanRoomModal } from '../../components/floor-plan-room-modal/floor-plan-room-modal';
import { FloorPlanDefinition, FloorPlanService } from '../../services/floor-plan.service';
import { LoggerService } from '../../services/logger.service';
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
  searchQuery = '';
  rooms: Room[] = [];
  filteredRooms: Room[] = [];
  isAdmin = false;
  viewMode: 'cards' | 'map' = 'cards';
  floorPlans: FloorPlanDefinition[] = [];
  selectedFloorPlanId = '';
  floorPlanEditMode = false;
  selectedMapRoom: Room | undefined;
  selectedFloorPlanCell: FloorPlanCellSelection | null = null;
  private baseRooms: Room[] = [];
  private deviceMap: Record<string, DeviceTelemetry> = {};
  private stopRoomsStream?: () => void;
  private stopDevicesStream?: () => void;
  private authSub?: Subscription;

  constructor(
    private roomService: RoomService,
    private deviceService: DeviceService,
    private dialogService: DialogService,
    private cdr: ChangeDetectorRef,
    private authState: AuthStateService,
    private floorPlanService: FloorPlanService,
    private logger: LoggerService
  ) {}

  ngOnInit(): void {
    this.floorPlans = this.floorPlanService.getFloorPlans();
    this.selectedFloorPlanId = this.floorPlanService.getDefaultFloorPlanId();

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
    this.authSub?.unsubscribe();
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

  selectFloorPlan(floorPlanId: string): void {
    this.selectedFloorPlanId = floorPlanId;
    this.selectedFloorPlanCell = null;
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
    return this.rooms.filter((room) => !room.device).length;
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
          this.logger.error('[RoomManagement] Error deleting room:', error);
          this.dialogService.error('Error', 'An error occurred while deleting the room. Please try again.');
        }
      },
      undefined,
      'Delete',
      'Cancel'
    );
  }

  private mergeRoomTelemetryAndFilter(): void {
    this.rooms = mergeRoomsWithTelemetry(this.baseRooms, this.deviceMap, {
      defaultPower: false,
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
