import {
  Component, Input, Output, EventEmitter,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DecisionLog } from '../../models/logs.model';
import { formatEventType, formatSource, formatReason } from '../../helpers/log-display.helper';

@Component({
  selector: 'app-logs-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './logs-card.html',
  styleUrl: './logs-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsCard {
  @Input() log!: DecisionLog;
  @Input() isUnread = false;
  @Input() variant: 'full' | 'compact' = 'full';
  @Output() clicked = new EventEmitter<void>();

  readonly formatEventType = formatEventType;
  readonly formatSource = formatSource;
  readonly formatReason = formatReason;

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

  getEventColor(eventType: string): string {
    const map: Record<string, string> = {
      mode_change: 'text-blue-600 bg-blue-50',
      ac_state_changed: 'text-sky-600 bg-sky-50',
      firebase_ready: 'text-emerald-600 bg-emerald-50',
      boot: 'text-slate-500 bg-slate-100',
      manual_override: 'text-amber-600 bg-amber-50',
      ml_failure: 'text-rose-600 bg-rose-50',
      ml_suggestion: 'text-violet-600 bg-violet-50',
      ml_auto_applied: 'text-blue-600 bg-blue-50',
      ai_toggle_changed: 'text-blue-500 bg-blue-50',
    };
    return map[eventType] ?? 'text-slate-500 bg-slate-100';
  }

  getEventColorSolid(eventType: string): string {
    const map: Record<string, string> = {
      mode_change: 'bg-blue-600',
      ac_state_changed: 'bg-sky-500',
      firebase_ready: 'bg-emerald-500',
      boot: 'bg-slate-500',
      manual_override: 'bg-amber-500',
      ml_failure: 'bg-rose-500',
      ml_suggestion: 'bg-violet-600',
      ml_auto_applied: 'bg-blue-600',
      ai_toggle_changed: 'bg-blue-500',
    };
    return map[eventType] ?? 'bg-slate-500';
  }

  formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    });
  }

  formatRelativeTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hr ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}