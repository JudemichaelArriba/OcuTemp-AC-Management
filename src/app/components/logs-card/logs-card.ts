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
    mode_change:      'text-indigo-600 bg-indigo-100/80',
    ac_state_changed: 'text-sky-500   bg-sky-100/80',
    firebase_ready:   'text-teal-600  bg-teal-100/80',
    boot:             'text-slate-500 bg-slate-200/80',
    manual_override:  'text-blue-700  bg-blue-200/80',
    ml_failure:       'text-rose-500  bg-rose-100/80',
    ml_suggestion:    'text-violet-500 bg-violet-100/80',
    ml_auto_applied:  'text-blue-600  bg-blue-100/80',
    ai_toggle_changed:'text-cyan-600  bg-cyan-100/80',
  };
  return map[eventType] ?? 'text-slate-500 bg-slate-200/80';
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