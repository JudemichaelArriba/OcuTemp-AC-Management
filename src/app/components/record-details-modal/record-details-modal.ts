import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
} from '@angular/core';
import { RecordDetails } from '../../helpers/device-records.helper';

const EXIT_MS = 200;

/** Shows one occupancy or override record in full. Opens whenever `details` is set. */
@Component({
  selector: 'app-record-details-modal',
  standalone: true,
  templateUrl: './record-details-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecordDetailsModal implements OnChanges, OnDestroy {
  @Input() details: RecordDetails | null = null;
  @Input() icon = 'receipt_long';
  /** Tailwind classes for the header icon tile. */
  @Input() iconClasses = 'bg-blue-50 text-blue-600';
  @Output() closed = new EventEmitter<void>();

  /** The record on screen; kept while the exit transition runs after `details` is cleared. */
  shown: RecordDetails | null = null;
  shownIcon = this.icon;
  shownIconClasses = this.iconClasses;
  animating = false;

  private timer?: ReturnType<typeof setTimeout>;

  constructor(private cdr: ChangeDetectorRef) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['details']) return;
    clearTimeout(this.timer);

    if (this.details) {
      this.shown = this.details;
      this.shownIcon = this.icon;
      this.shownIconClasses = this.iconClasses;
      this.timer = setTimeout(() => {
        this.animating = true;
        this.cdr.markForCheck();
      }, 10);
    } else {
      this.animating = false;
      this.timer = setTimeout(() => {
        this.shown = null;
        this.cdr.markForCheck();
      }, EXIT_MS);
    }
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.details) this.close();
  }

  close(): void {
    this.closed.emit();
  }
}
