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
} from '../../helpers/log-display.helper';

interface LogDetailItem {
  readonly label: string;
  readonly value: string;
  readonly icon: string;
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

  visible = false;
  animating = false;

  readonly skeletonItems = Array(8).fill(null);

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

  getEventIcon(eventType: string): string {
    const map: Record<string, string> = {
      mode_change: 'swap_horiz',
      ac_state_changed: 'ac_unit',
      firebase_ready: 'cloud_done',
      boot: 'restart_alt',
      manual_override: 'back_hand',
      ml_failure: 'error_outline',
      ml_suggestion: 'psychology',
      ml_auto_applied: 'auto_awesome',
      ai_toggle_changed: 'toggle_on',
    };
    return map[eventType] ?? 'info';
  }


  getIconColor(icon: string): [string, string] {
    const map: Record<string, [string, string]> = {
      tag: ['bg-indigo-100', 'text-indigo-500'],
      router: ['bg-blue-100', 'text-blue-600'],
      meeting_room: ['bg-cyan-100', 'text-cyan-600'],
      input: ['bg-violet-100', 'text-violet-600'],
      rule: ['bg-amber-100', 'text-amber-600'],
      settings_suggest: ['bg-sky-100', 'text-sky-600'],
      power_settings_new: ['bg-emerald-100', 'text-emerald-600'],
      device_thermostat: ['bg-orange-100', 'text-orange-600'],
      history: ['bg-slate-100', 'text-slate-500'],
      psychology: ['bg-purple-100', 'text-purple-600'],
      check_circle: ['bg-emerald-100', 'text-emerald-600'],
      auto_awesome: ['bg-fuchsia-100', 'text-fuchsia-600'],
      settings_remote: ['bg-blue-100', 'text-blue-500'],
      restart_alt: ['bg-amber-100', 'text-amber-500'],
      compare_arrows: ['bg-teal-100', 'text-teal-600'],
      timer: ['bg-sky-100', 'text-sky-500'],
      schedule: ['bg-indigo-100', 'text-indigo-500'],
      mark_email_read: ['bg-emerald-100', 'text-emerald-600'],
    };
    return map[icon] ?? ['bg-slate-100', 'text-slate-500'];
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

  get detailItems(): LogDetailItem[] {
    const log = this.log;
    if (!log) return [];
    return [
      { label: 'Log ID', value: log.id, icon: 'tag' },
      { label: 'Device', value: this.formatText(log.deviceId), icon: 'router' },
      { label: 'Room UID', value: this.formatText(log.roomUid, 'No room'), icon: 'meeting_room' },
      { label: 'Source', value: formatSource(log.source), icon: 'input' },
      { label: 'Reason', value: formatReason(log.reason), icon: 'rule' },
      { label: 'Mode', value: formatMode(log.mode), icon: 'settings_suggest' },
      { label: 'Power', value: log.power ? 'On' : 'Off', icon: 'power_settings_new' },
      { label: 'Target Temp', value: this.formatTemperature(log.targetTemp), icon: 'device_thermostat' },
      { label: 'Previous Temp', value: this.formatTemperature(log.previousTemp), icon: 'history' },
      { label: 'Suggested Temp', value: this.formatTemperature(log.suggestedTemp), icon: 'psychology' },
      { label: 'Applied', value: this.formatBoolean(log.applied), icon: 'check_circle' },
      { label: 'AI Auto Apply', value: this.formatBoolean(log.aiAutoApply), icon: 'auto_awesome' },
      { label: 'IR Sent', value: this.formatBoolean(log.irSent), icon: 'settings_remote' },
      { label: 'Previous Power', value: this.formatBoolean(log.previousPower), icon: 'restart_alt' },
      { label: 'Previous Source', value: log.previousSource ? formatSource(log.previousSource) : 'Not recorded', icon: 'compare_arrows' },
      { label: 'Uptime', value: this.formatUptime(log.uptimeMs), icon: 'timer' },
      { label: 'Updated', value: this.formatDateTime(log.updatedAt), icon: 'schedule' },
      { label: 'Read State', value: log.read === true ? 'Read' : 'Unread', icon: 'mark_email_read' },
    ];
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