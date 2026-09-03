import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DecisionLog } from '../../models/logs.model';
import {
  formatEventType,
  formatMode,
  formatReason,
  formatSource,
  getEventColor,
  getEventIcon,
} from '../../helpers/log-display.helper';

interface DetailRow {
  readonly label: string;
  readonly value: string;
  /** Prior value, when this field represents a change. Rendered as "from → value". */
  readonly from?: string;
}

interface DetailGroup {
  readonly title: string;
  readonly icon: string;
  readonly rows: readonly DetailRow[];
}

@Component({
  selector: 'app-logs-details-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './logs-details-modal.html',
  styleUrl: './logs-details-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsDetailsModal implements OnChanges {
  @Input() isOpen = false;
  @Input() log: DecisionLog | null = null;
  @Output() closed = new EventEmitter<void>();
  @Input() isLoading = false;

  readonly formatEventType = formatEventType;
  readonly getEventIcon = getEventIcon;
  readonly getEventColor = getEventColor;

  visible = false;
  animating = false;

  readonly skeletonGroups: readonly (readonly null[])[] = [
    Array(3).fill(null),
    Array(4).fill(null),
    Array(4).fill(null),
  ];

  constructor(private cdr: ChangeDetectorRef) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isOpen']) {
      if (this.isOpen) {
        this.visible = true;
        this.animating = false;
        this.cdr.markForCheck();
        requestAnimationFrame(() => {
          setTimeout(() => {
            this.animating = true;
            this.cdr.markForCheck();
          }, 10);
        });
      } else {
        this.animateOut();
      }
    }
  }

  private animateOut(afterDone?: () => void): void {
    this.animating = false;
    this.cdr.markForCheck();
    setTimeout(() => {
      this.visible = false;
      this.cdr.markForCheck();
      afterDone?.();
    }, 200);
  }

  close(): void {
    this.animateOut(() => this.closed.emit());
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('logs-details-backdrop')) {
      this.close();
    }
  }

  formatDateTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'Not recorded';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }

  /**
   * Field groups for the open log. Fields already shown in the header
   * (event type, timestamp, read state) are intentionally omitted, and
   * optional fields appear only when the device actually recorded them.
   */
  get detailGroups(): DetailGroup[] {
    const log = this.log;
    if (!log) return [];

    const outcome: DetailRow[] = [
      {
        label: 'Power',
        value: this.formatPower(log.power),
        from: typeof log.previousPower === 'boolean' ? this.formatPower(log.previousPower) : undefined,
      },
      {
        label: 'Target temperature',
        value: this.formatTemperature(log.targetTemp),
        from: typeof log.previousTemp === 'number' ? this.formatTemperature(log.previousTemp) : undefined,
      },
      { label: 'Mode', value: formatMode(log.mode) },
      { label: 'Applied to device', value: this.formatBoolean(log.applied) },
    ];
    if (typeof log.irSent === 'boolean') {
      outcome.push({ label: 'IR signal sent', value: this.formatBoolean(log.irSent) });
    }

    const cause: DetailRow[] = [
      {
        label: 'Control source',
        value: formatSource(log.source),
        from: log.previousSource ? formatSource(log.previousSource) : undefined,
      },
      { label: 'Reason', value: formatReason(log.reason) },
    ];
    if (typeof log.suggestedTemp === 'number') {
      cause.push({ label: 'AI suggested temperature', value: this.formatTemperature(log.suggestedTemp) });
    }
    cause.push({ label: 'AI auto-apply', value: log.aiAutoApply ? 'On' : 'Off' });

    const device: DetailRow[] = [
      { label: 'Device', value: this.formatText(log.deviceId) },
      { label: 'Room', value: this.formatText(log.roomUid, 'No room assigned') },
      { label: 'Uptime at event', value: this.formatUptime(log.uptimeMs) },
      { label: 'Log ID', value: log.id },
    ];

    return [
      { title: 'Outcome', icon: 'bolt', rows: outcome },
      { title: 'Why it happened', icon: 'help', rows: cause },
      { title: 'Device', icon: 'router', rows: device },
    ];
  }

  private formatPower(value: boolean): string {
    return value ? 'On' : 'Off';
  }

  private formatBoolean(value: boolean | undefined): string {
    if (typeof value !== 'boolean') return 'Not recorded';
    return value ? 'Yes' : 'No';
  }

  private formatTemperature(value: number | undefined): string {
    if (typeof value !== 'number') return 'Not recorded';
    return `${value}°C`;
  }

  private formatText(value: string | undefined, fallback = 'Not recorded'): string {
    return value && value.trim().length > 0 ? value : fallback;
  }

  private formatUptime(value: number | undefined): string {
    if (typeof value !== 'number') return 'Not recorded';
    const totalSeconds = Math.floor(value / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }
}
