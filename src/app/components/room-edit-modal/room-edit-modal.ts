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

@Component({
  selector: 'app-room-edit-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, DropDown],
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

  dayOptions: DropDownOption[] = [
    { value: 'Monday', label: 'Monday', hint: 'Start of work week' },
    { value: 'Tuesday', label: 'Tuesday', hint: 'Second weekday' },
    { value: 'Wednesday', label: 'Wednesday', hint: 'Midweek' },
    { value: 'Thursday', label: 'Thursday', hint: 'Near weekend' },
    { value: 'Friday', label: 'Friday', hint: 'Last weekday' },
    { value: 'Saturday', label: 'Saturday', hint: 'Weekend' },
    { value: 'Sunday', label: 'Sunday', hint: 'Weekend' },
  ];
  timeOptions: DropDownOption[] = this.buildTimeOptions();

  newSchedule: Schedule = { day: '', startTime: '', endTime: '', subject: '' };
  schedules: Schedule[] = [];
  editingIndex: number | null = null;

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
  ) {}

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
    this.newSchedule = { day: '', startTime: '', endTime: '', subject: '' };
    this.editingIndex = null;
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

  onDayChange(value: string): void {
    if (!this.isScheduleDay(value)) return;
    this.newSchedule.day = value;
    this.cdr.markForCheck();
  }

  editSchedule(index: number): void {
    const schedule = this.schedules[index];
    if (!schedule) return;
    this.newSchedule = { ...schedule };
    this.editingIndex = index;
    this.cdr.markForCheck();
  }

  cancelEdit(): void {
    this.newSchedule = { day: '', startTime: '', endTime: '', subject: '' };
    this.editingIndex = null;
    this.cdr.markForCheck();
  }

  addOrUpdateSchedule(): void {
    const error = this.getScheduleValidationError(this.newSchedule, this.schedules, this.editingIndex ?? undefined);
    if (error) {
      this.dialogService.error('Validation Error', error);
      return;
    }

    const normalized = this.normalizeSchedule(this.newSchedule);
    if (this.editingIndex !== null) {
      this.schedules[this.editingIndex] = normalized;
      this.editingIndex = null;
    } else {
      this.schedules.push(normalized);
    }

    this.newSchedule = { day: '', startTime: '', endTime: '', subject: '' };
    this.cdr.markForCheck();
  }

  removeSchedule(index: number): void {
    const schedule = this.schedules[index];
    if (!schedule) return;
    const label = `${schedule.day} ${schedule.startTime}-${schedule.endTime}`;
    this.dialogService.confirm(
      'Remove Schedule',
      `Remove ${label} (${schedule.subject})?`,
      () => {
        this.schedules.splice(index, 1);
        if (this.editingIndex === index) {
          this.cancelEdit();
        } else if (this.editingIndex !== null && index < this.editingIndex) {
          this.editingIndex -= 1;
        }
        this.cdr.markForCheck();
      }
    );
  }

  private buildTimeOptions(): DropDownOption[] {
    const options: DropDownOption[] = [];
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        const value = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        options.push({
          value,
          label: this.toMeridiem(value),
          hint: value,
        });
      }
    }
    return options;
  }

  private toMeridiem(time: string): string {
    const [hour, minute] = time.split(':').map(Number);
    const period = hour >= 12 ? 'PM' : 'AM';
    const adjustedHour = hour % 12 === 0 ? 12 : hour % 12;
    return `${adjustedHour}:${minute.toString().padStart(2, '0')} ${period}`;
  }

  private isScheduleDay(value: string): value is Exclude<Schedule['day'], ''> {
    return (
      value === 'Monday' ||
      value === 'Tuesday' ||
      value === 'Wednesday' ||
      value === 'Thursday' ||
      value === 'Friday' ||
      value === 'Saturday' ||
      value === 'Sunday'
    );
  }

  private normalizeSchedule(schedule: Schedule): Schedule {
    return {
      day: schedule.day,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      subject: schedule.subject.trim(),
    };
  }

  private cloneSchedules(schedules: Schedule[]): Schedule[] {
    return schedules.map((schedule) => ({ ...schedule }));
  }

  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  private hasOverlap(start1: string, end1: string, start2: string, end2: string): boolean {
    const s1 = this.timeToMinutes(start1);
    const e1 = this.timeToMinutes(end1);
    const s2 = this.timeToMinutes(start2);
    const e2 = this.timeToMinutes(end2);
    return s1 < e2 && s2 < e1;
  }

  private getScheduleValidationError(
    schedule: Schedule,
    schedules: Schedule[],
    excludeIndex?: number
  ): string | null {
    const { day, startTime, endTime, subject } = schedule;
    const trimmedSubject = subject.trim();
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

    if (!day || !startTime || !endTime || !trimmedSubject) {
      return 'All schedule fields are required.';
    }
    if (!this.isScheduleDay(day)) {
      return 'Please select a valid day.';
    }
    if (!timePattern.test(startTime) || !timePattern.test(endTime)) {
      return 'Please select a valid time value.';
    }
    const namePattern = /^[a-zA-Z0-9\s\-]+$/;
    if (!namePattern.test(trimmedSubject)) {
      return 'Subject may only contain letters, numbers, spaces, and hyphens.';
    }
    if (startTime === endTime) {
      return 'Start time and end time cannot be the same.';
    }
    if (this.timeToMinutes(startTime) >= this.timeToMinutes(endTime)) {
      return 'Start time must be before end time.';
    }

    const normalized = this.normalizeSchedule(schedule);
    if (schedules.some((s, i) => i !== excludeIndex && s.subject.trim() === trimmedSubject)) {
      return 'Subject name must be unique.';
    }
    if (
      schedules.some(
        (s, i) =>
          i !== excludeIndex &&
          s.day === normalized.day &&
          s.startTime === normalized.startTime &&
          s.endTime === normalized.endTime &&
          s.subject.trim() === trimmedSubject
      )
    ) {
      return 'Duplicate schedule.';
    }
    if (
      schedules.some(
        (s, i) =>
          i !== excludeIndex &&
          s.day === normalized.day &&
          this.hasOverlap(normalized.startTime, normalized.endTime, s.startTime, s.endTime)
      )
    ) {
      return 'Schedules on the same day cannot overlap.';
    }

    return null;
  }

  private validateSchedulesList(): string | null {
    for (let i = 0; i < this.schedules.length; i++) {
      const schedule = this.schedules[i];
      const error = this.getScheduleValidationError(schedule, this.schedules, i);
      if (error) return error;
    }
    return null;
  }

  private hasUnsavedChanges(): boolean {
    if (!this.originalSnapshot) return false;
    const trimmedName = this.roomName.trim();
    if (trimmedName !== this.originalSnapshot.roomName) return true;
    if (this.status !== this.originalSnapshot.status) return true;
    if (this.selectedDevice !== this.originalSnapshot.device) return true;
    if (this.schedules.length !== this.originalSnapshot.schedules.length) return true;
    for (let i = 0; i < this.schedules.length; i++) {
      const current = this.normalizeSchedule(this.schedules[i]);
      const original = this.normalizeSchedule(this.originalSnapshot.schedules[i]);
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

    const trimmedName = this.roomName.trim();
    if (!trimmedName) {
      this.dialogService.error('Validation Error', 'Room name is required.');
      return;
    }
    const namePattern = /^[a-zA-Z0-9\s\-]+$/;
    if (!namePattern.test(trimmedName)) {
      this.dialogService.error('Invalid Input', 'Room name may only contain letters, numbers, spaces, and hyphens.');
      return;
    }
    if (!this.selectedDevice) {
      this.dialogService.error('Validation Error', 'Device UID is required.');
      return;
    }
    if (this.schedules.length === 0) {
      this.dialogService.error('Validation Error', 'Add at least one schedule before updating the room.');
      return;
    }
    const scheduleError = this.validateSchedulesList();
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
