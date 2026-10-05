import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy, ChangeDetectorRef, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RoomService, isRoomActionError } from '../../services/room.service';
import { DeviceService } from '../../services/device.service';
import { DialogService } from '../../services/dialog.service';
import { Room, Schedule } from '../../models/room.model';
import { getRoomNameError, toScheduleArray, validateSchedulesList } from '../../helpers/room-validation';
import { DropDown, DropDownOption } from '../shared/drop-down/drop-down';
import { ScheduleBuilder } from '../shared/schedule-builder/schedule-builder';

@Component({
  selector: 'app-add-room-modal',
  standalone: true,
  imports: [FormsModule, DatePipe, DropDown, ScheduleBuilder],
  templateUrl: './add-room-modal.html',
  styleUrl: './add-room-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRoomModal implements OnInit {
  /** When set, the modal restores this soft-deleted room instead of creating a new one. */
  @Input() restoreFrom: Room | null = null;
  @Output() closed = new EventEmitter<void>();
  @Output() roomAdded = new EventEmitter<Room>();

  visible = false;
  animating = false;
  isSaving = false;
  isStepOneLoading = false;
  step = 1;

  roomName = '';
  selectedDevice = '';
  devices: string[] = [];
  deviceOptions: DropDownOption[] = [];
  schedules: Schedule[] = [];

  /** Deleted room being restored (from `restoreFrom`, or chosen in the same-name prompt). */
  restoreTarget: Room | null = null;
  /** Schedules the admin had before the prompt pre-filled archived ones; restored on Back. */
  private schedulesBeforeRestore: Schedule[] | null = null;

  get isRestoreFromList(): boolean {
    return this.restoreFrom !== null;
  }

  constructor(
    private roomService: RoomService,
    private deviceService: DeviceService,
    private dialogService: DialogService,
    private cdr: ChangeDetectorRef
  ) { }

  async ngOnInit(): Promise<void> {
    this.devices = await this.deviceService.getAvailableDevices();
    this.deviceOptions = this.devices.map((device) => ({
      value: device,
      label: device,
      hint: 'Registered controller',
    }));
    this.openModal();
  }

  private openModal(): void {
    this.visible = true;
    this.animating = false;
    this.isSaving = false;
    this.isStepOneLoading = false;
    this.step = 1;
    this.roomName = '';
    this.selectedDevice = '';
    this.schedules = [];
    this.restoreTarget = null;
    this.schedulesBeforeRestore = null;

    if (this.restoreFrom) {
      this.restoreTarget = this.restoreFrom;
      this.roomName = this.restoreFrom.roomName ?? '';
      const former = this.restoreFrom.deletedDevice ?? '';
      this.selectedDevice = former && this.devices.includes(former) ? former : '';
      this.schedules = toScheduleArray(this.restoreFrom.archivedSchedules);
    }
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
    if (this.isSaving || this.isStepOneLoading) return;
    this.animateOut(() => this.closed.emit());
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('eu-backdrop')) {
      this.close();
    }
  }

  async nextStep(): Promise<void> {
    if (this.isStepOneLoading) return;

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

    this.isStepOneLoading = true;
    this.cdr.markForCheck();

    try {
      const conflict = await this.roomService.findRoomNameConflict(trimmedName, this.restoreTarget?.uid);
      if (conflict.activeConflict) {
        this.dialogService.error(
          'Duplicate Room',
          this.restoreTarget
            ? 'A room with this name already exists. Choose a different name to restore this room.'
            : 'A room with this name already exists. Please choose a different name.'
        );
        return;
      }

      const deletedMatch = this.restoreTarget ? null : conflict.deletedMatches[0];
      if (deletedMatch) {
        this.promptRestoreOrCreate(deletedMatch);
        return;
      }

      this.step = 2;
    } catch (err) {
      this.dialogService.error('Validation Failed', 'Unable to validate room details. Please try again.');
    } finally {
      this.isStepOneLoading = false;
      this.cdr.markForCheck();
    }
  }

  private promptRestoreOrCreate(match: Room): void {
    const deletedOn = match.deletedAt ? ` (deleted ${new Date(match.deletedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})` : '';
    this.dialogService.choose(
      'Deleted Room Found',
      `A deleted room named "${match.roomName}"${deletedOn} exists. Restore it to keep its energy history, or create a new room with no history.`,
      { label: 'Restore', action: () => this.startPromptRestore(match) },
      { label: 'Create new', action: () => this.goToStep(2) },
    );
  }

  private startPromptRestore(match: Room): void {
    this.restoreTarget = match;
    const archived = toScheduleArray(match.archivedSchedules);
    if (archived.length > 0) {
      this.schedulesBeforeRestore = this.schedules;
      this.schedules = archived;
    }
    this.goToStep(2);
  }

  private goToStep(step: number): void {
    this.step = step;
    this.cdr.markForCheck();
  }

  /** Back to step 1. A restore chosen in the same-name prompt is undone, since name/device can change. */
  goBack(): void {
    if (this.isSaving || this.isStepOneLoading) return;
    if (this.restoreTarget && !this.isRestoreFromList) {
      this.restoreTarget = null;
      if (this.schedulesBeforeRestore) this.schedules = this.schedulesBeforeRestore;
      this.schedulesBeforeRestore = null;
    }
    this.goToStep(1);
  }

  async onSave(): Promise<void> {
    if (this.isSaving) return;
    if (this.schedules.length === 0) {
      this.dialogService.error(
        'Validation Error',
        this.restoreTarget ? 'Add at least one schedule before restoring the room.' : 'Add at least one schedule before creating a room.'
      );
      return;
    }
    const scheduleError = validateSchedulesList(this.schedules);
    if (scheduleError) {
      this.dialogService.error('Validation Error', scheduleError);
      return;
    }

    if (this.restoreTarget) {
      await this.saveRestore(this.restoreTarget);
      return;
    }

    this.isSaving = true;
    this.cdr.markForCheck();

    try {
      const roomData = {
        roomName: this.roomName.trim(),
        device: this.selectedDevice,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        schedules: this.schedules
      };
      const newRoom = await this.roomService.createRoom(roomData);
      this.animateOut(() => {
        this.roomAdded.emit(newRoom);
        this.closed.emit();
        setTimeout(() => {
          this.dialogService.success('Room Created', `${newRoom.roomName} has been added successfully.`);
        }, 50);
      });
    } catch (err) {
      this.isSaving = false;
      this.cdr.markForCheck();
      this.dialogService.error('Create Failed', 'Something went wrong. Please try again.');
    }
  }

  private async saveRestore(target: Room): Promise<void> {
    this.isSaving = true;
    this.cdr.markForCheck();

    try {
      const { room, cellRestored } = await this.roomService.restoreRoom(target.uid, {
        roomName: this.roomName.trim(),
        device: this.selectedDevice,
        schedules: this.schedules,
      });
      const cellNote = target.deletedFloorPlanCellId && !cellRestored
        ? ' Its previous floor plan spot is taken, so assign it on the floor plan again.'
        : '';
      this.animateOut(() => {
        this.roomAdded.emit(room);
        this.closed.emit();
        setTimeout(() => {
          this.dialogService.success('Room Restored', `${room.roomName} has been restored. Its energy history is kept.${cellNote}`);
        }, 50);
      });
    } catch (err) {
      this.isSaving = false;
      this.cdr.markForCheck();
      this.dialogService.error(
        'Restore Failed',
        isRoomActionError(err) ? err.message : 'Something went wrong while restoring the room. Please try again.'
      );
    }
  }
}
