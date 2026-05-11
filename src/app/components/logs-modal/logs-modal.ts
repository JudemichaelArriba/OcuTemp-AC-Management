import {
  Component, Input, Output, EventEmitter,
  OnChanges, SimpleChanges,
  ChangeDetectionStrategy, ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DecisionLog } from '../../models/logs.model';
import { LogService, LogCursor } from '../../services/logs.service';
import { formatEventType, formatSource, formatReason, formatMode } from '../../helpers/log-display.helper';
import { LogsCard } from '../logs-card/logs-card';

@Component({
  selector: 'app-logs-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, LogsCard],
  templateUrl: './logs-modal.html',
  styleUrl: './logs-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogsModal implements OnChanges {

  @Input() isOpen = false;
  @Output() closed = new EventEmitter<void>();

  logs: DecisionLog[] = [];
  availableDates: string[] = [];
  selectedDate = '';
  lastViewed: Date | null = null;

  isLoading = false;
  isLoadingMore = false;
  hasMore = false;
  private cursor: LogCursor | null = null;

  readonly formatEventType = formatEventType;
  readonly formatSource = formatSource;
  readonly formatReason = formatReason;
  readonly formatMode = formatMode;

  constructor(
    private logService: LogService,
    private cdr: ChangeDetectorRef,
  ) { }

  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    if (changes['isOpen'] && this.isOpen) {
      this.lastViewed = this.logService.getLastViewedAt();
      this.logService.markAllViewed();
      await Promise.all([this.loadAvailableDates(), this.loadFirstPage()]);
    }
  }

  async onDateChange(): Promise<void> {
    await this.loadFirstPage();
  }

  async loadMore(): Promise<void> {
    if (!this.hasMore || this.isLoadingMore || !this.cursor) return;
    this.isLoadingMore = true;
    this.cdr.markForCheck();
    try {
      const page = await this.logService.fetchPage(
        this.cursor,
        this.selectedDate || undefined
      );
      this.logs = [...this.logs, ...page.logs];
      this.hasMore = page.hasMore;
      this.cursor = page.nextCursor;
    } finally {
      this.isLoadingMore = false;
      this.cdr.markForCheck();
    }
  }

  close(): void {
    this.closed.emit();
  }

  private async loadFirstPage(): Promise<void> {
    this.isLoading = true;
    this.logs = [];
    this.cursor = null;
    this.hasMore = false;
    this.cdr.markForCheck();
    try {
      const page = await this.logService.fetchPage(null, this.selectedDate || undefined);
      this.logs = page.logs;
      this.hasMore = page.hasMore;
      this.cursor = page.nextCursor;
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  private async loadAvailableDates(): Promise<void> {
    this.availableDates = await this.logService.fetchAvailableDates();
    this.cdr.markForCheck();
  }

  isUnread(log: DecisionLog): boolean {
    return this.logService.isUnread(log, this.lastViewed);
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
}