import {
  Component, Input, Output, EventEmitter,
  OnChanges, SimpleChanges,
  ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DecisionLog } from '../../models/logs.model';
import { LogService, LogCursor } from '../../services/logs.service';
import { LogsCard } from '../logs-card/logs-card';
import { LogsDetailsModal } from '../logs-details-modal/logs-details-modal';
import { LoggerService } from '../../services/logger.service';

@Component({
  selector: 'app-logs-modal',
  standalone: true,
  imports: [CommonModule, LogsCard, LogsDetailsModal],
  templateUrl: './logs-modal.html',
  styleUrl: './logs-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsModal implements OnChanges {

  @Input() isOpen = false;
  @Input() initialLog: DecisionLog | null = null;
  @Output() closed = new EventEmitter<void>();

  visible = false;
  animating = false;

  logs: DecisionLog[] = [];
  selectedLog: DecisionLog | null = null;
  isDetailsOpen = false;

  isLoading = false;
  isLoadingMore = false;
  hasMore = false;
  private cursor: LogCursor | null = null;

  constructor(
    private logService: LogService,
    private logger: LoggerService,
    private cdr: ChangeDetectorRef,
  ) { }

  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    if (changes['isOpen']) {
      if (this.isOpen) {
        this.openModal();
        await this.loadFirstPage();

        if (this.initialLog) {
          await this.openDetails(this.resolveLog(this.initialLog));
        }
      } else {
        this.closeDetails();
        this.animateOut();
      }
      return;
    }

    if (changes['initialLog'] && this.isOpen && this.initialLog) {
      await this.openDetails(this.resolveLog(this.initialLog));
    }
  }

  async loadMore(): Promise<void> {
    if (!this.hasMore || this.isLoadingMore || !this.cursor) return;
    this.isLoadingMore = true;
    this.cdr.markForCheck();

    try {
      const page = await this.logService.fetchPage(this.cursor);
      this.logs = [...this.logs, ...page.logs];
      this.hasMore = page.hasMore;
      this.cursor = page.nextCursor;
    } finally {
      this.isLoadingMore = false;
      this.cdr.markForCheck();
    }
  }

  async openDetails(log: DecisionLog): Promise<void> {
    const selected = this.resolveLog(log);
    this.selectedLog = selected;
    this.isDetailsOpen = true;
    this.cdr.markForCheck();

    if (selected.read === true) return;

    try {
      await this.logService.markAsRead(selected.id);
      this.applyReadState(selected.id);
    } catch (error) {
      this.logger.error('Failed to mark log as read', error, {
        component: 'LogsModal',
        action: 'markLogAsRead',
        logId: selected.id,
      });
    } finally {
      this.cdr.markForCheck();
    }
  }

  closeDetails(): void {
    this.isDetailsOpen = false;
    this.selectedLog = null;
    this.cdr.markForCheck();
  }

  close(): void {
    this.closeDetails();
    this.animateOut(() => this.closed.emit());
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('logs-backdrop')) {
      this.close();
    }
  }

  get groupedLogs(): { dateKey: string; logs: DecisionLog[] }[] {
    const map = new Map<string, DecisionLog[]>();
    for (const log of this.logs) {
      const key = log.updatedAt.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(log);
    }
    return [...map.entries()].map(([dateKey, logs]) => ({ dateKey, logs }));
  }

  formatDateLabel(dateKey: string): string {
    const todayKey = new Date().toISOString().slice(0, 10);
    const yesterdayKey = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    if (dateKey === todayKey) return 'Today';
    if (dateKey === yesterdayKey) return 'Yesterday';
    return new Date(`${dateKey}T00:00:00`).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
  }

  private openModal(): void {
    this.visible = true;
    this.animating = false;
    this.selectedLog = null;
    this.isDetailsOpen = false;
    this.cdr.markForCheck();
    requestAnimationFrame(() => {
      setTimeout(() => {
        this.animating = true;
        this.cdr.markForCheck();
      }, 10);
    });
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

  private async loadFirstPage(): Promise<void> {
    this.isLoading = true;
    this.logs = [];
    this.cursor = null;
    this.hasMore = false;
    this.cdr.markForCheck();

    try {
      const page = await this.logService.fetchPage(null);
      this.logs = page.logs;
      this.hasMore = page.hasMore;
      this.cursor = page.nextCursor;
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  private resolveLog(log: DecisionLog): DecisionLog {
    return this.logs.find(item => item.id === log.id) ?? log;
  }

  private applyReadState(logId: string): void {
    this.logs = this.logs.map(log => log.id === logId ? { ...log, read: true } : log);

    if (this.selectedLog?.id === logId) {
      this.selectedLog = { ...this.selectedLog, read: true };
    }
  }
}
