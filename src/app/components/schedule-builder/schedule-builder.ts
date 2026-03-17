import {
  Component,
  Input,
  Output,
  EventEmitter,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  OnChanges,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Schedule } from '../../models/room.model';
import { DialogService } from '../../services/dialog.service';
import { DropDown, DropDownOption } from '../drop-down/drop-down';
import {
  getScheduleValidationError,
  isScheduleDay,
  normalizeSchedule,
} from '../../helpers/room-validation';

type ScheduleBuilderVariant = 'add' | 'edit';

@Component({
  selector: 'app-schedule-builder',
  standalone: true,
  imports: [CommonModule, FormsModule, DropDown],
  templateUrl: './schedule-builder.html',
  styleUrl: './schedule-builder.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScheduleBuilder implements OnChanges {
  @Input() schedules: Schedule[] = [];
  @Input() disabled = false;
  @Input() variant: ScheduleBuilderVariant = 'add';
  @Input() heading = '';
  @Input() subheading = '';

  @Output() schedulesChange = new EventEmitter<Schedule[]>();

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
  editingIndex: number | null = null;

  constructor(
    private dialogService: DialogService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['variant']) {
      this.resetEditingState();
    }
    if (changes['schedules'] && !changes['schedules'].firstChange) {
      if (this.editingIndex !== null) {
        this.resetEditingState();
      }
    }
  }

  get isEditing(): boolean {
    return this.editingIndex !== null;
  }

  get hasHeading(): boolean {
    return this.heading.trim().length > 0;
  }

  get headingHint(): string {
    return this.variant === 'edit' ? 'Edit or remove as needed' : 'Click to remove';
  }

  get emptyTitle(): string {
    return this.variant === 'edit' ? 'No schedules available' : 'No schedules added yet';
  }

  get emptySubtitle(): string {
    return this.variant === 'edit'
      ? 'Add at least one schedule to save updates'
      : 'Add at least one schedule to continue';
  }

  onDayChange(value: string): void {
    if (!isScheduleDay(value)) return;
    this.newSchedule.day = value;
    this.cdr.markForCheck();
  }

  addOrUpdateSchedule(): void {
    if (this.disabled) return;
    const editingIndex = this.variant === 'edit' ? this.editingIndex ?? undefined : undefined;
    const error = getScheduleValidationError(this.newSchedule, this.schedules, editingIndex);
    if (error) {
      this.dialogService.error('Validation Error', error);
      return;
    }

    const normalized = normalizeSchedule(this.newSchedule);
    const nextSchedules = [...this.schedules];
    if (this.variant === 'edit' && this.editingIndex !== null) {
      nextSchedules[this.editingIndex] = normalized;
      this.editingIndex = null;
    } else {
      nextSchedules.push(normalized);
    }

    this.newSchedule = { day: '', startTime: '', endTime: '', subject: '' };
    this.applySchedules(nextSchedules);
  }

  editSchedule(index: number): void {
    if (this.variant !== 'edit' || this.disabled) return;
    const schedule = this.schedules[index];
    if (!schedule) return;
    this.newSchedule = { ...schedule };
    this.editingIndex = index;
    this.cdr.markForCheck();
  }

  cancelEdit(): void {
    if (this.disabled) return;
    this.resetEditingState();
  }

  removeSchedule(index: number): void {
    if (this.disabled) return;
    const schedule = this.schedules[index];
    if (!schedule) return;

    if (this.variant === 'edit') {
      const label = `${schedule.day} ${schedule.startTime}-${schedule.endTime}`;
      this.dialogService.confirm(
        'Remove Schedule',
        `Remove ${label} (${schedule.subject})?`,
        () => this.applyRemove(index)
      );
      return;
    }

    this.applyRemove(index);
  }

  private applyRemove(index: number): void {
    const nextSchedules = this.schedules.filter((_, current) => current !== index);
    if (this.editingIndex === index) {
      this.resetEditingState(false);
    } else if (this.editingIndex !== null && index < this.editingIndex) {
      this.editingIndex -= 1;
    }
    this.applySchedules(nextSchedules);
  }

  private applySchedules(nextSchedules: Schedule[]): void {
    this.schedules = nextSchedules;
    this.schedulesChange.emit(nextSchedules);
    this.cdr.markForCheck();
  }

  private resetEditingState(markForCheck = true): void {
    this.newSchedule = { day: '', startTime: '', endTime: '', subject: '' };
    this.editingIndex = null;
    if (markForCheck) {
      this.cdr.markForCheck();
    }
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
}
