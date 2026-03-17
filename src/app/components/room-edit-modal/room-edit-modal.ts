import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnChanges,
  SimpleChanges,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Room, Schedule } from '../../models/room.model';
import { RoomService } from '../../services/room.service';
import { DeviceService } from '../../services/device.service';
import { DialogService } from '../../services/dialog.service';
import { DropDown, DropDownOption } from '../drop-down/drop-down';
import { ScheduleBuilder } from '../schedule-builder/schedule-builder';
import {
  getRoomNameError,
  normalizeSchedule,
  validateSchedulesList,
} from '../../helpers/room-validation';

@Component({
  selector: 'app-room-edit-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, DropDown, ScheduleBuilder],
  templateUrl: './room-edit-modal.html',
  styleUrl: './room-edit-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomEditModal implements OnChanges {
  @Input() room: Room | null = null;
  @Output() closed = new EventEmitter<void>();
  @Output() roomUpdated = new EventEmitter<Room>();

  visible = false;
  animating = false;
  isSaving = false;
  isLoadingDevices = false;

  roomName = '';
  status: Room['status'] = 'active';
  selectedDevice = '';
  deviceOptions: DropDownOption[] = [];
  schedules: Schedule[] = [];

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
    private cdr: ChangeDetectorRef
  ) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['room']) {
      if (this.room) {
        this.initializeFromRoom(this.room);
        void this.loadDevices(this.room.device);
      } else {
        this.animateOut();
      }
    }
  }

  private initializeFromRoom(room: Room): void {
    this.roomName = room.roomName || '';
    this.status = room.status || 'active';
    this.selectedDevice = room.device || '';
    this.schedules = this.cloneSchedules(room.schedules || []);
    this.originalSnapshot = {
      roomName: this.roomName.trim(),
      status: this.status,
      device: this.selectedDevice,
      schedules: this.cloneSchedules(this.schedules),
    };
    this.openModal();
  }

  private async loadDevices(currentDeviceId?: string): Promise<void> {
    this.isLoadingDevices = true;
    this.cdr.markForCheck();
    try {
      const devices = await this.deviceService.getAvailableDevicesForRoom(currentDeviceId);
      this.deviceOptions = devices.map((device) => ({
        value: device,
        label: device,
        hint: device === currentDeviceId ? 'Currently assigned' : 'Available device',
      }));
    } catch (err) {
      console.error('Failed to load devices:', err);
      this.deviceOptions = [];
      this.dialogService.error('Load Failed', 'Unable to load device list. Please try again.');
    } finally {
      this.isLoadingDevices = false;
      this.cdr.markForCheck();
    }
  }

  private openModal(): void {
    this.visible = true;
    this.animating = false;
    this.isSaving = false;
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

  close(): void {
    if (this.isSaving) return;
    if (this.hasUnsavedChanges()) {
      this.dialogService.confirm(
        'Discard Changes',
        'You have unsaved changes. Do you want to discard them and close?',
        () => this.animateOut(() => this.closed.emit())
      );
      return;
    }
    this.animateOut(() => this.closed.emit());
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('eu-backdrop')) {
      this.close();
    }
  }

  setStatus(value: Room['status']): void {
    this.status = value;
    this.cdr.markForCheck();
  }

  private cloneSchedules(schedules: Schedule[]): Schedule[] {
    return schedules.map((schedule) => ({ ...schedule }));
  }

  private hasUnsavedChanges(): boolean {
    if (!this.originalSnapshot) return false;
    const trimmedName = this.roomName.trim();
    if (trimmedName !== this.originalSnapshot.roomName) return true;
    if (this.status !== this.originalSnapshot.status) return true;
    if (this.selectedDevice !== this.originalSnapshot.device) return true;
    if (this.schedules.length !== this.originalSnapshot.schedules.length) return true;
    for (let i = 0; i < this.schedules.length; i++) {
      const current = normalizeSchedule(this.schedules[i]);
      const original = normalizeSchedule(this.originalSnapshot.schedules[i]);
      if (
        current.day !== original.day ||
        current.startTime !== original.startTime ||
        current.endTime !== original.endTime ||
        current.subject !== original.subject
      ) {
        return true;
      }
    }
    return false;
  }

  async onSave(): Promise<void> {
    if (!this.room || this.isSaving) return;

    if (!this.hasUnsavedChanges()) {
      this.dialogService.alert('No Changes', 'You have not made any changes to save.');
      return;
    }

    const nameError = getRoomNameError(this.roomName);
    if (nameError) {
      this.dialogService.error('Validation Error', nameError);
      return;
    }
    const trimmedName = this.roomName.trim();
    if (!this.selectedDevice) {
      this.dialogService.error('Validation Error', 'Device UID is required.');
      return;
    }
    if (this.schedules.length === 0) {
      this.dialogService.error('Validation Error', 'Add at least one schedule before updating the room.');
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
      if (trimmedName !== this.room.roomName.trim()) {
        const exists = await this.roomService.checkRoomNameExists(trimmedName, this.room.uid);
        if (exists) {
          this.dialogService.error('Duplicate Room', 'A room with this name already exists. Please choose a different name.');
          this.isSaving = false;
          this.cdr.markForCheck();
          return;
        }
      }

      const availableDevices = await this.deviceService.getAvailableDevicesForRoom(this.room.device);
      if (!availableDevices.includes(this.selectedDevice)) {
        this.dialogService.error('Device Unavailable', 'The selected device is no longer available. Please choose another.');
        this.isSaving = false;
        this.cdr.markForCheck();
        return;
      }

      this.dialogService.confirm(
        'Confirm Update',
        'Are you sure you want to save these room changes?',
        async () => {
          try {
            const updatedAt = new Date().toISOString();
            const roomUpdate: Partial<Omit<Room, 'uid'>> = {
              roomName: trimmedName,
              status: this.status,
              device: this.selectedDevice,
              schedules: this.cloneSchedules(this.schedules),
              updatedAt,
            };

            await this.roomService.updateRoom(this.room!.uid, roomUpdate);

            const updatedRoom: Room = {
              ...this.room!,
              ...roomUpdate,
            };

            this.originalSnapshot = {
              roomName: trimmedName,
              status: this.status,
              device: this.selectedDevice,
              schedules: this.cloneSchedules(this.schedules),
            };

            this.animateOut(() => {
              this.roomUpdated.emit(updatedRoom);
              this.closed.emit();
              setTimeout(() => {
                this.dialogService.success('Room Updated', `${updatedRoom.roomName} has been updated successfully.`);
              }, 50);
            });
          } catch (err) {
            console.error('Failed to update room:', err);
            this.isSaving = false;
            this.cdr.markForCheck();
            this.dialogService.error('Update Failed', 'Something went wrong. Please try again.');
          }
        },
        () => {
          this.isSaving = false;
          this.cdr.markForCheck();
        },
        'Save Changes',
        'Cancel'
      );
    } catch (err) {
      console.error('Validation failed:', err);
      this.isSaving = false;
      this.cdr.markForCheck();
      this.dialogService.error('Update Failed', 'Something went wrong. Please try again.');
    }
  }
}
