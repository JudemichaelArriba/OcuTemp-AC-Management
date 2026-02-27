import { Component, Output, EventEmitter, ChangeDetectionStrategy, ChangeDetectorRef, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RoomService } from '../../services/room.service'; 
import { DialogService } from '../../services/dialog.service';
import { Room, Schedule } from '../../models/room.model'; 
import { DropDown, DropDownOption } from '../drop-down/drop-down';

@Component({
  selector: 'app-add-room-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, DropDown],
  templateUrl: './add-room-modal.html',
  styleUrl: './add-room-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddRoomModal implements OnInit {
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

  constructor(
    private roomService: RoomService,
    private dialogService: DialogService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit(): Promise<void> {
    this.devices = await this.roomService.getDevices();
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
    this.newSchedule = { day: '', startTime: '', endTime: '', subject: '' };
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

    this.isStepOneLoading = true;
    this.cdr.markForCheck();

    try {
      const roomExists = await this.roomService.checkRoomNameExists(trimmedName);
      if (roomExists) {
        this.dialogService.error('Duplicate Room', 'A room with this name already exists. Please choose a different name.');
        return;
      }

      this.step = 2;
    } catch (err) {
      console.error('Failed to validate room details:', err);
      this.dialogService.error('Validation Failed', 'Unable to validate room details. Please try again.');
    } finally {
      this.isStepOneLoading = false;
      this.cdr.markForCheck();
    }
  }

  onDayChange(value: string): void {
    if (!this.isScheduleDay(value)) return;
    this.newSchedule.day = value;
    this.cdr.markForCheck();
  }

  addSchedule(): void {
    const { day, startTime, endTime, subject } = this.newSchedule;
    const trimmedSubject = subject.trim();
    if (!day || !startTime || !endTime || !trimmedSubject) {
      this.dialogService.error('Validation Error', 'All schedule fields are required.');
      return;
    }
    const namePattern = /^[a-zA-Z0-9\s\-]+$/;
    if (!namePattern.test(trimmedSubject)) {
      this.dialogService.error('Invalid Input', 'Subject may only contain letters, numbers, spaces, and hyphens.');
      return;
    }
    // Check if start time and end time are the same
    if (startTime === endTime) {
      this.dialogService.error('Validation Error', 'Start time and end time cannot be the same.');
      return;
    }
    if (this.timeToMinutes(startTime) >= this.timeToMinutes(endTime)) {
      this.dialogService.error('Validation Error', 'Start time must be before end time.');
      return;
    }
    if (this.schedules.some(s => s.subject === trimmedSubject)) {
      this.dialogService.error('Duplicate Error', 'Subject name must be unique.');
      return;
    }
    if (this.schedules.some(s => s.day === day && s.startTime === startTime && s.endTime === endTime && s.subject === trimmedSubject)) {
      this.dialogService.error('Duplicate Error', 'Duplicate schedule.');
      return;
    }
    if (this.schedules.some(s => s.day === day && this.hasOverlap(startTime, endTime, s.startTime, s.endTime))) {
      this.dialogService.error('Overlap Error', 'Schedules on the same day cannot overlap.');
      return;
    }

    this.schedules.push({ day, startTime, endTime, subject: trimmedSubject });
    this.newSchedule = { day: '', startTime: '', endTime: '', subject: '' };
    this.cdr.markForCheck();
  }

  removeSchedule(index: number): void {
    this.schedules.splice(index, 1);
    this.cdr.markForCheck();
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

  async onSave(): Promise<void> {
    if (this.isSaving) return;
    if (this.schedules.length === 0) {
      this.dialogService.error('Validation Error', 'Add at least one schedule before creating a room.');
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
      console.error('Failed to create room:', err);
      this.isSaving = false;
      this.cdr.markForCheck();
      this.dialogService.error('Create Failed', 'Something went wrong. Please try again.');
    }
  }
}
