import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
} from '@angular/core';

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
  @Input() value = '';
  @Input() disabled = false;
  @Input() icon = 'expand_more';
  @Input() variant: 'device' | 'day' | 'time' = 'device';

  @Output() valueChange = new EventEmitter<string>();

  isOpen = false;
  activeIndex = -1;

  constructor(
    private elementRef: ElementRef<HTMLElement>,
    private cdr: ChangeDetectorRef
  ) {}

  get selectedOption(): DropDownOption | undefined {
    return this.options.find((option) => option.value === this.value);
  }

  toggle(): void {
    if (this.disabled) return;
    this.isOpen ? this.close() : this.open();
  }

  open(): void {
    if (this.disabled || this.isOpen) return;
    this.isOpen = true;
    this.activeIndex = this.getSelectedIndex();
    if (this.activeIndex < 0 && this.options.length > 0) {
      this.activeIndex = 0;
    }
    this.cdr.markForCheck();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.activeIndex = -1;
    this.cdr.markForCheck();
  }

  select(value: string): void {
    if (this.disabled) return;
    this.valueChange.emit(value);
    this.close();
  }

  onKeyDown(event: KeyboardEvent): void {
    if (this.disabled) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!this.isOpen) {
          this.open();
          return;
        }
        this.moveActive(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (!this.isOpen) {
          this.open();
          return;
        }
        this.moveActive(-1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (!this.isOpen) {
          this.open();
          return;
        }
        if (this.activeIndex >= 0 && this.activeIndex < this.options.length) {
          this.select(this.options[this.activeIndex].value);
        }
        return;
      case 'Escape':
        if (this.isOpen) {
          event.preventDefault();
          this.close();
        }
        return;
      default:
        return;
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.isOpen) return;
    const target = event.target as Node | null;
    if (target && !this.elementRef.nativeElement.contains(target)) {
      this.close();
    }
  }

  private moveActive(step: number): void {
    if (this.options.length === 0) return;
    if (this.activeIndex === -1) {
      this.activeIndex = 0;
    } else {
      this.activeIndex = (this.activeIndex + step + this.options.length) % this.options.length;
    }
    this.cdr.markForCheck();
  }

  private getSelectedIndex(): number {
    return this.options.findIndex((option) => option.value === this.value);
  }
}
