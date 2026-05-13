import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
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
export class LogsDetailsModal {
  @Input() isOpen = false;
  @Input() log: DecisionLog | null = null;
  @Output() closed = new EventEmitter<void>();
  @Input() isLoading = false;
  readonly formatEventType = formatEventType;

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
      {
        label: 'Previous Source',
        value: log.previousSource ? formatSource(log.previousSource) : 'Not recorded',
        icon: 'compare_arrows',
      },
      { label: 'Uptime', value: this.formatUptime(log.uptimeMs), icon: 'timer' },
      { label: 'Updated', value: this.formatDateTime(log.updatedAt), icon: 'schedule' },
      { label: 'Read State', value: log.read === true ? 'Read' : 'Unread', icon: 'mark_email_read' },
    ];
  }

  close(): void {
    this.closed.emit();
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

  private formatBoolean(value: boolean | undefined): string {
    if (typeof value !== 'boolean') return 'Not recorded';
    return value ? 'Yes' : 'No';
  }

  private formatTemperature(value: number | undefined): string {
    if (typeof value !== 'number') return 'Not recorded';
    return `${value} C`;
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
