import {
  Component,
  Input,
  Output,
  EventEmitter,
  HostListener,
  ElementRef,
  ChangeDetectorRef,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';

export interface DropDownOption {
  value: string;
  label: string;
  hint?: string;
}

/** One cell of the `date` variant's month grid. */
export interface DropDownCalendarDay {
  /** `YYYY-MM-DD`. */
  key: string;
  day: number;
  label: string;
  inMonth: boolean;
  disabled: boolean;
  today: boolean;
  selected: boolean;
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CALENDAR_CELLS = 42; // six weeks, so the panel height never jumps between months
const DATE_PANEL_WIDTH = 288;

function toDateKey(date: Date): string {
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Local-time date for a `YYYY-MM-DD` key, or null when the key is malformed. */
function fromDateKey(key: string): Date | null {
  const match = DATE_KEY_PATTERN.exec(key ?? '');
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return toDateKey(date) === key ? date : null;
}

@Component({
  selector: 'app-drop-down',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './drop-down.html',
  styleUrl: './drop-down.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DropDown {
  @Input() options: DropDownOption[] = [];
  @Input() placeholder = 'Select';
  @Input() disabled = false;
  @Input() label: string = '';
  /** `date` shows a calendar and emits `YYYY-MM-DD`, or an empty string when cleared. */
  @Input() variant: 'device' | 'day' | 'time' | 'date' = 'device';
  /** `date` variant only: inclusive `YYYY-MM-DD` bounds. Days outside them cannot be picked. */
  @Input() min = '';
  @Input() max = '';

  @Output() valueChange = new EventEmitter<string>();

  private _value: string = '';

  @Input()
  get value(): string { return this._value; }
  set value(val: string) {
    if (this._value !== val) {
      this._value = val;
      if (this.variant === 'time' && val) {
        this.parseCurrentTime(val);
      }
      // CRITICAL FIX: Triggers change detection when value is updated externally by room-edit
      this.cdr.markForCheck();
    }
  }

  isOpen = false;
  isDropdownAbove = false;
  isAlignedRight = false;

  hours = Array.from({ length: 12 }, (_, i) => (i + 1).toString().padStart(2, '0'));
  minutes = Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, '0'));
  periods = ['AM', 'PM'];

  selectedHour = '08';
  selectedMinute = '00';
  selectedPeriod = 'AM';

  readonly weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  calendarDays: DropDownCalendarDay[] = [];
  monthLabel = '';
  isTodayDisabled = false;
  private viewYear = 0;
  private viewMonth = 0;

  constructor(private elementRef: ElementRef, private cdr: ChangeDetectorRef) {}

  get selectedLabel(): string {
    if (this.variant === 'time' && this._value) {
      // Returns a clean 12-hour format for the UI label based on internal states,
      // keeping the frontend user-friendly while emitting strict 24-hour HH:mm
      return `${this.selectedHour}:${this.selectedMinute} ${this.selectedPeriod}`;
    }
    if (this.variant === 'date') {
      const date = fromDateKey(this._value);
      return date
        ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : this.placeholder;
    }
    const option = this.options.find(opt => opt.value === this._value);
    return option ? option.label : this.placeholder;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (!this.elementRef.nativeElement.contains(event.target)) {
      this.close();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    this.close();
  }

  onTriggerKey(event: Event) {
    event.preventDefault();
    this.toggle();
  }

  toggle() {
    if (this.disabled) return;
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      // Auto-emit the default value immediately if opened and empty to prevent validation errors
      if (this.variant === 'time' && !this._value) {
        this._value = this.getFormattedTime24();
        this.valueChange.emit(this._value);
      }
      if (this.variant === 'date') {
        this.showMonthOf(fromDateKey(this._value) ?? this.clampToBounds(new Date()));
      }
      requestAnimationFrame(() => {
        this.checkSpace();
        this.cdr.markForCheck();
      });
    }
  }

  private close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.cdr.markForCheck();
  }

  private parseCurrentTime(val: string) {
    if (!val) return;
    const match12 = val.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
    if (match12) {
      this.selectedHour = match12[1].padStart(2, '0');
      this.selectedMinute = match12[2].padStart(2, '0');
      this.selectedPeriod = match12[3].toUpperCase();
      return;
    }

    const match24 = val.match(/^(\d{1,2}):(\d{2})$/);
    if (match24) {
      let h = parseInt(match24[1], 10);
      this.selectedPeriod = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      this.selectedHour = h.toString().padStart(2, '0');
      this.selectedMinute = match24[2].padStart(2, '0');
    }
  }

  select(option: DropDownOption) {
    this._value = option.value;
    this.valueChange.emit(this._value);
    this.isOpen = false;
    this.cdr.markForCheck();
  }

  selectTimePart(type: 'h' | 'm' | 'p', val: string) {
    if (type === 'h') this.selectedHour = val;
    if (type === 'm') this.selectedMinute = val;
    if (type === 'p') this.selectedPeriod = val;

    this._value = this.getFormattedTime24();
    this.valueChange.emit(this._value);
    this.cdr.markForCheck();
  }

  shiftMonth(delta: number) {
    this.showMonthOf(new Date(this.viewYear, this.viewMonth + delta, 1));
    this.cdr.markForCheck();
  }

  selectDate(day: DropDownCalendarDay) {
    if (day.disabled) return;
    this.commitDate(day.key);
  }

  selectToday() {
    const todayKey = toDateKey(new Date());
    if (this.isOutOfBounds(todayKey)) return;
    this.commitDate(todayKey);
  }

  clearDate() {
    this.commitDate('');
  }

  private commitDate(key: string) {
    this._value = key;
    this.valueChange.emit(key);
    this.isOpen = false;
    this.cdr.markForCheck();
  }

  private isOutOfBounds(key: string): boolean {
    return (!!this.min && key < this.min) || (!!this.max && key > this.max);
  }

  /** Nearest in-bounds date, so the calendar opens on a month that has pickable days. */
  private clampToBounds(date: Date): Date {
    const key = toDateKey(date);
    if (this.min && key < this.min) return fromDateKey(this.min) ?? date;
    if (this.max && key > this.max) return fromDateKey(this.max) ?? date;
    return date;
  }

  private showMonthOf(date: Date) {
    this.viewYear = date.getFullYear();
    this.viewMonth = date.getMonth();

    const first = new Date(this.viewYear, this.viewMonth, 1);
    const todayKey = toDateKey(new Date());

    this.monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    this.isTodayDisabled = this.isOutOfBounds(todayKey);
    this.calendarDays = Array.from({ length: CALENDAR_CELLS }, (_, index) => {
      const cell = new Date(this.viewYear, this.viewMonth, index - first.getDay() + 1);
      const key = toDateKey(cell);
      return {
        key,
        day: cell.getDate(),
        label: cell.toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        }),
        inMonth: cell.getMonth() === this.viewMonth,
        disabled: this.isOutOfBounds(key),
        today: key === todayKey,
        selected: key === this._value,
      };
    });
  }

  private getFormattedTime24(): string {
    let h = parseInt(this.selectedHour, 10);
    if (this.selectedPeriod === 'PM' && h < 12) h += 12;
    if (this.selectedPeriod === 'AM' && h === 12) h = 0;
    return `${h.toString().padStart(2, '0')}:${this.selectedMinute}`;
  }

  private checkSpace(): void {
    if (typeof window === 'undefined') return;
    const rect = this.elementRef.nativeElement.getBoundingClientRect();
    const dropdownHeight = this.variant === 'date' ? 380 : this.variant === 'time' ? 260 : 240;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    this.isDropdownAbove = spaceBelow < dropdownHeight && spaceAbove > spaceBelow;
    // The calendar is wider than a narrow trigger; anchor it right when it would leave the viewport.
    this.isAlignedRight = this.variant === 'date'
      && rect.left + DATE_PANEL_WIDTH > window.innerWidth - 8
      && rect.right - DATE_PANEL_WIDTH >= 8;
  }
}
