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
  @Input() variant: 'device' | 'day' | 'time' = 'device';

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
  
  hours = Array.from({ length: 12 }, (_, i) => (i + 1).toString().padStart(2, '0'));
  minutes = Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, '0'));
  periods = ['AM', 'PM'];

  selectedHour = '08';
  selectedMinute = '00';
  selectedPeriod = 'AM';

  constructor(private elementRef: ElementRef, private cdr: ChangeDetectorRef) {}

  get selectedLabel(): string {
    if (this.variant === 'time' && this._value) {
      // Returns a clean 12-hour format for the UI label based on internal states, 
      // keeping the frontend user-friendly while emitting strict 24-hour HH:mm
      return `${this.selectedHour}:${this.selectedMinute} ${this.selectedPeriod}`;
    }
    const option = this.options.find(opt => opt.value === this._value);
    return option ? option.label : this.placeholder;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (!this.elementRef.nativeElement.contains(event.target)) {
      if (this.isOpen) {
        this.isOpen = false;
        this.cdr.markForCheck();
      }
    }
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
      requestAnimationFrame(() => {
        this.checkSpace();
        this.cdr.markForCheck();
      });
    }
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

  private getFormattedTime24(): string {
    let h = parseInt(this.selectedHour, 10);
    if (this.selectedPeriod === 'PM' && h < 12) h += 12;
    if (this.selectedPeriod === 'AM' && h === 12) h = 0;
    return `${h.toString().padStart(2, '0')}:${this.selectedMinute}`;
  }

  private checkSpace(): void {
    if (typeof window === 'undefined') return;
    const rect = this.elementRef.nativeElement.getBoundingClientRect();
    const dropdownHeight = this.variant === 'time' ? 260 : 240; 
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    
    this.isDropdownAbove = spaceBelow < dropdownHeight && spaceAbove > spaceBelow;
  }
}