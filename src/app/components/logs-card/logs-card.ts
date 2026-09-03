import {
  Component, Input, Output, EventEmitter,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DecisionLog } from '../../models/logs.model';
import {
  formatEventType,
  formatSource,
  getEventColor,
  getEventIcon,
} from '../../helpers/log-display.helper';

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
  @Input() variant: 'full' | 'compact' = 'full';
  @Output() clicked = new EventEmitter<void>();

  readonly formatEventType = formatEventType;
  readonly formatSource = formatSource;
  readonly getEventIcon = getEventIcon;
  readonly getEventColor = getEventColor;

  get isUnread(): boolean {
    return this.log?.read !== true;
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
