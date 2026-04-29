import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FloorPlanCellSelection } from '../floor-plan/floor-plan';
import { Room, Schedule } from '../../models/room.model';
import { RoomService } from '../../services/room.service';
import { DeviceService } from '../../services/device.service';
import { DialogService } from '../../services/dialog.service';
import { LoggerService } from '../../services/logger.service';
import { DropDown, DropDownOption } from '../shared/drop-down/drop-down';
import { ScheduleBuilder } from '../shared/schedule-builder/schedule-builder';
import {
  getRoomNameError,
  normalizeSchedule,
  validateSchedulesList,
} from '../../helpers/room-validation';

type FloorPlanModalMode = 'assign' | 'create' | 'edit';

@Component({
  selector: 'app-floor-plan-room-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, DropDown, ScheduleBuilder],
  templateUrl: './floor-plan-room-modal.html',
  styleUrl: './floor-plan-room-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FloorPlanRoomModal implements OnChanges {
  @Input() selection: FloorPlanCellSelection | null = null;
  @Input() rooms: Room[] = [];

  @Output() closed = new EventEmitter<void>();

  visible = false;
  animating = false;
  isSaving = false;
  isLoadingDevices = false;
  mode: FloorPlanModalMode = 'assign';

  existingRoomUid = '';
  roomName = '';
  status: Room['status'] = 'active';
  selectedDevice = '';
  schedules: Schedule[] = [];
  deviceOptions: DropDownOption[] = [];

  sourceRoom: Room | null = null;
  private originalSnapshot: {
    roomName: string;
    status: Room['status'];
    device: string;
    schedules: Schedule[];
  } | null = null;

  constructor(
    private roomService: RoomService,
    private deviceService: DeviceService,
    private dialogService: DialogService,
    private logger: LoggerService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['selection']) {
      if (this.selection) {
        this.initializeFromSelection(this.selection);
      } else {
        this.animateOut();
      }
    }
  }

  get cellLabel(): string {
    return this.selection?.cellId.replace(/-/g, ' ') ?? 'Floorplan Cell';
  }

  get isAssigned(): boolean {
    return !!this.sourceRoom;
  }

  get availableRoomOptions(): DropDownOption[] {
    return this.rooms
      .filter((room) => !room.floorPlanCellId)
      .map((room) => ({
        value: room.uid,
        label: room.roomName,
        hint: room.device ? `Device ${room.device}` : 'No device linked',
      }));
  }

  get telemetryTemperatureText(): string {
    if (this.sourceRoom?.temperature === undefined) return '--';
    return `${this.sourceRoom.temperature.toFixed(1)}C`;
  }

  get telemetryHumidityText(): string {
    if (this.sourceRoom?.humidity === undefined) return '--';
    return `${this.sourceRoom.humidity.toFixed(1)}%`;
  }

  get telemetryStatusText(): string {
    if (!this.sourceRoom) return 'Unassigned';
    return this.sourceRoom.power === true ? 'ON' : 'OFF';
  }

  get telemetryOccupancyText(): string {
    if (this.sourceRoom?.occupancy === undefined) return '--';
    return this.sourceRoom.occupancy ? 'Occupied' : 'Vacant';
  }

  get stateBadgeClass(): string {
    const visualState = this.selection?.state.visualState ?? 'no-telemetry';
    const classes: Record<string, string> = {
      off: 'bg-slate-100 text-slate-600',
      comfortable: 'bg-emerald-100 text-emerald-700',
      'slightly-warm': 'bg-yellow-100 text-yellow-700',
      warm: 'bg-amber-100 text-amber-700',
      hot: 'bg-orange-100 text-orange-700',
      'very-hot': 'bg-red-100 text-red-700',
      'no-telemetry': 'bg-slate-100 text-slate-500',
    };
    return classes[visualState] ?? classes['no-telemetry'];
  }

  setMode(mode: FloorPlanModalMode): void {
    if (this.isSaving) return;
    this.mode = mode;
    if (mode === 'create') {
      void this.loadDevices();
    }
    this.cdr.markForCheck();
  }

  setStatus(value: Room['status']): void {
    this.status = value;
    this.cdr.markForCheck();
  }

  close(): void {
    if (this.isSaving) return;
    this.animateOut(() => this.closed.emit());
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('eu-backdrop')) {
      this.close();
    }
  }

  async assignExistingRoom(): Promise<void> {
    if (!this.selection || this.isSaving) return;
    if (!this.existingRoomUid) {
      this.dialogService.error('Validation Error', 'Select a room before assigning this floorplan cell.');
      return;
    }

    this.isSaving = true;
    this.cdr.markForCheck();

    try {
      await this.roomService.assignRoomToFloorPlan(this.existingRoomUid, {
        floorPlanId: this.selection.floorPlanId,
        floorPlanCellId: this.selection.cellId,
      });
      const assignedRoom = this.rooms.find((room) => room.uid === this.existingRoomUid);
      this.animateOut(() => {
        this.closed.emit();
        setTimeout(() => {
          this.dialogService.success(
            'Room Assigned',
            `${assignedRoom?.roomName ?? 'Room'} is now linked to ${this.cellLabel}.`
          );
        }, 50);
      });
    } catch (err) {
      this.logger.error('Failed to assign room to floorplan:', err);
      this.isSaving = false;
      this.cdr.markForCheck();
      this.dialogService.error('Assign Failed', this.toUserMessage(err));
    }
  }

  async createAssignedRoom(): Promise<void> {
    if (!this.selection || this.isSaving) return;
    const nameError = getRoomNameError(this.roomName);
    if (nameError) {
      this.dialogService.error('Validation Error', nameError);
      return;
    }
    if (!this.selectedDevice) {
      this.dialogService.error('Validation Error', 'Device UID is required.');
      return;
    }
    if (this.schedules.length === 0) {
      this.dialogService.error('Validation Error', 'Add at least one schedule before creating a room.');
      return;
    }
    const scheduleError = validateSchedulesList(this.schedules);
    if (scheduleError) {
      this.dialogService.error('Validation Error', scheduleError);
      return;
    }

    this.isSaving = true;
    this.cdr.markForCheck();

    try {
      const trimmedName = this.roomName.trim();
      const exists = await this.roomService.checkRoomNameExists(trimmedName);
      if (exists) {
        this.dialogService.error('Duplicate Room', 'A room with this name already exists.');
        this.isSaving = false;
        this.cdr.markForCheck();
        return;
      }

      const availableDevices = await this.deviceService.getAvailableDevices();
      if (!availableDevices.includes(this.selectedDevice)) {
        this.dialogService.error('Device Unavailable', 'The selected device is no longer available.');
        this.isSaving = false;
        this.cdr.markForCheck();
        return;
      }

      const newRoom = await this.roomService.createRoom({
        roomName: trimmedName,
        device: this.selectedDevice,
        status: 'active',
        schedules: this.cloneSchedules(this.schedules),
        createdAt: new Date().toISOString(),
        floorPlanId: this.selection.floorPlanId,
        floorPlanCellId: this.selection.cellId,
        floorPlanAssignedAt: new Date().toISOString(),
      });

      this.animateOut(() => {
        this.closed.emit();
        setTimeout(() => {
          this.dialogService.success('Room Created', `${newRoom.roomName} has been linked to the floorplan.`);
        }, 50);
      });
    } catch (err) {
      this.logger.error('Failed to create assigned room:', err);
      this.isSaving = false;
      this.cdr.markForCheck();
      this.dialogService.error('Create Failed', this.toUserMessage(err));
    }
  }

  async saveAssignedRoom(): Promise<void> {
    if (!this.selection || !this.sourceRoom || this.isSaving) return;

    const nameError = getRoomNameError(this.roomName);
    if (nameError) {
      this.dialogService.error('Validation Error', nameError);
      return;
    }
    if (!this.selectedDevice) {
      this.dialogService.error('Validation Error', 'Device UID is required.');
      return;
    }
    if (this.schedules.length === 0) {
      this.dialogService.error('Validation Error', 'Add at least one schedule before saving.');
      return;
    }
    const scheduleError = validateSchedulesList(this.schedules);
    if (scheduleError) {
      this.dialogService.error('Validation Error', scheduleError);
      return;
    }

    const trimmedName = this.roomName.trim();
    if (!this.hasEditableChanges(trimmedName)) {
      this.dialogService.alert('No Changes', 'There are no room changes to save.');
      return;
    }

    this.isSaving = true;
    this.cdr.markForCheck();

    try {
      if (trimmedName !== this.sourceRoom.roomName.trim()) {
        const exists = await this.roomService.checkRoomNameExists(trimmedName, this.sourceRoom.uid);
        if (exists) {
          this.dialogService.error('Duplicate Room', 'A room with this name already exists.');
          this.isSaving = false;
          this.cdr.markForCheck();
          return;
        }
      }

      const availableDevices = await this.deviceService.getAvailableDevicesForRoom(this.sourceRoom.device);
      if (!availableDevices.includes(this.selectedDevice)) {
        this.dialogService.error('Device Unavailable', 'The selected device is no longer available.');
        this.isSaving = false;
        this.cdr.markForCheck();
        return;
      }

      await this.roomService.updateRoom(this.sourceRoom.uid, {
        roomName: trimmedName,
        status: this.status,
        device: this.selectedDevice,
        schedules: this.cloneSchedules(this.schedules),
        floorPlanId: this.selection.floorPlanId,
        floorPlanCellId: this.selection.cellId,
        floorPlanAssignedAt: this.sourceRoom.floorPlanAssignedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      this.animateOut(() => {
        this.closed.emit();
        setTimeout(() => {
          this.dialogService.success('Room Updated', `${trimmedName} has been updated.`);
        }, 50);
      });
    } catch (err) {
      this.logger.error('Failed to update floorplan room:', err);
      this.isSaving = false;
      this.cdr.markForCheck();
      this.dialogService.error('Update Failed', this.toUserMessage(err));
    }
  }

  unassignRoom(): void {
    if (!this.sourceRoom || this.isSaving) return;
    this.dialogService.confirm(
      'Unassign Room',
      `Remove ${this.sourceRoom.roomName} from this floorplan cell? The room record will remain.`,
      async () => {
        this.isSaving = true;
        this.cdr.markForCheck();
        try {
          await this.roomService.unassignRoomFromFloorPlan(this.sourceRoom!.uid);
          this.animateOut(() => {
            this.closed.emit();
            setTimeout(() => {
              this.dialogService.success('Room Unassigned', 'The room was removed from the floorplan cell.');
            }, 50);
          });
        } catch (err) {
          this.logger.error('Failed to unassign floorplan room:', err);
          this.isSaving = false;
          this.cdr.markForCheck();
          this.dialogService.error('Unassign Failed', this.toUserMessage(err));
        }
      }
    );
  }

  deleteRoom(): void {
    if (!this.sourceRoom || this.isSaving) return;
    this.dialogService.confirm(
      'Delete Room',
      `Delete ${this.sourceRoom.roomName}? This cannot be undone.`,
      async () => {
        this.isSaving = true;
        this.cdr.markForCheck();
        try {
          await this.roomService.deleteRoom(this.sourceRoom!.uid);
          this.animateOut(() => {
            this.closed.emit();
            setTimeout(() => {
              this.dialogService.success('Room Deleted', 'The assigned room has been removed.');
            }, 50);
          });
        } catch (err) {
          this.logger.error('Failed to delete floorplan room:', err);
          this.isSaving = false;
          this.cdr.markForCheck();
          this.dialogService.error('Delete Failed', this.toUserMessage(err));
        }
      },
      undefined,
      'Delete',
      'Cancel'
    );
  }

  private initializeFromSelection(selection: FloorPlanCellSelection): void {
    this.sourceRoom = selection.room ?? null;
    this.mode = this.sourceRoom ? 'edit' : 'assign';
    this.existingRoomUid = '';
    this.isSaving = false;

    if (this.sourceRoom) {
      this.roomName = this.sourceRoom.roomName;
      this.status = this.sourceRoom.status;
      this.selectedDevice = this.sourceRoom.device;
      this.schedules = this.cloneSchedules(this.sourceRoom.schedules ?? []);
      this.originalSnapshot = {
        roomName: this.roomName.trim(),
        status: this.status,
        device: this.selectedDevice,
        schedules: this.cloneSchedules(this.schedules),
      };
    } else {
      this.roomName = selection.cellId.replace(/-/g, ' ');
      this.status = 'active';
      this.selectedDevice = '';
      this.schedules = [];
      this.originalSnapshot = null;
    }

    this.openModal();
    void this.loadDevices();
  }

  private async loadDevices(): Promise<void> {
    this.isLoadingDevices = true;
    this.cdr.markForCheck();

    try {
      const devices = this.sourceRoom
        ? await this.deviceService.getAvailableDevicesForRoom(this.sourceRoom.device)
        : await this.deviceService.getAvailableDevices();

      this.deviceOptions = devices.map((device) => ({
        value: device,
        label: device,
        hint: this.sourceRoom?.device === device ? 'Currently assigned' : 'Available device',
      }));
    } catch (err) {
      this.logger.error('Failed to load floorplan modal devices:', err);
      this.deviceOptions = [];
      this.dialogService.error('Load Failed', 'Unable to load available devices.');
    } finally {
      this.isLoadingDevices = false;
      this.cdr.markForCheck();
    }
  }

  private openModal(): void {
    this.visible = true;
    this.animating = false;
    this.cdr.markForCheck();
    requestAnimationFrame(() => {
      setTimeout(() => {
        this.animating = true;
        this.cdr.markForCheck();
      }, 10);
    });
  }

  private animateOut(afterDone?: () => void): void {
    this.animating = false;
    this.cdr.markForCheck();
    setTimeout(() => {
      this.visible = false;
      this.cdr.markForCheck();
      afterDone?.();
    }, 180);
  }

  private cloneSchedules(schedules: Schedule[]): Schedule[] {
    return schedules.map((schedule) => ({ ...schedule }));
  }

  private hasEditableChanges(trimmedName: string): boolean {
    if (!this.originalSnapshot || !this.sourceRoom) return true;
    if (!this.sourceRoom.floorPlanCellId) return true;
    if (trimmedName !== this.originalSnapshot.roomName) return true;
    if (this.status !== this.originalSnapshot.status) return true;
    if (this.selectedDevice !== this.originalSnapshot.device) return true;
    if (this.schedules.length !== this.originalSnapshot.schedules.length) return true;

    return this.schedules.some((schedule, index) => {
      const current = normalizeSchedule(schedule);
      const original = normalizeSchedule(this.originalSnapshot!.schedules[index]);
      return (
        current.day !== original.day ||
        current.startTime !== original.startTime ||
        current.endTime !== original.endTime ||
        current.subject !== original.subject
      );
    });
  }

  private toUserMessage(err: unknown): string {
    if (err instanceof Error && err.message === 'Floorplan cell is already assigned') {
      return 'This floorplan cell is already assigned to another room.';
    }
    if (err instanceof Error && err.message === 'Room name already exists') {
      return 'A room with this name already exists.';
    }
    return 'Something went wrong. Please try again.';
  }
}
