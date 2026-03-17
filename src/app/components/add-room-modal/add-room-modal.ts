import { Component, Output, EventEmitter, ChangeDetectionStrategy, ChangeDetectorRef, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RoomService } from '../../services/room.service';
import { DeviceService } from '../../services/device.service';
import { DialogService } from '../../services/dialog.service';
import { Room, Schedule } from '../../models/room.model';
import { getRoomNameError } from '../../helpers/room-validation';
import { DropDown, DropDownOption } from '../drop-down/drop-down';
import { ScheduleBuilder } from '../schedule-builder/schedule-builder';

@Component({
  selector: 'app-add-room-modal',
  standalone: true,
  imports: [FormsModule, DropDown, ScheduleBuilder],
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
  schedules: Schedule[] = [];

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
