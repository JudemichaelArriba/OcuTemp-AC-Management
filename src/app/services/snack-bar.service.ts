import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type SnackBarType = 'info' | 'success' | 'warning' | 'error';

export interface SnackBarConfig {
  title: string;
  message?: string;
  type?: SnackBarType;
  durationMs?: number;
  persistent?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  dedupeKey?: string;
  icon?: string;
}

export type SnackBarShortcutConfig = Omit<SnackBarConfig, 'title' | 'message' | 'type'>;

export interface SnackBarMessage extends Required<Pick<SnackBarConfig, 'title' | 'type' | 'durationMs' | 'persistent'>> {
  id: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  dedupeKey?: string;
  icon?: string;
}

@Injectable({ providedIn: 'root' })
export class SnackBarService {
  private static readonly DEFAULT_DURATION_MS = 6500;

  private readonly currentSubject = new BehaviorSubject<SnackBarMessage | null>(null);
  readonly current$ = this.currentSubject.asObservable();

  private current: SnackBarMessage | null = null;
  private queue: SnackBarMessage[] = [];
  private nextId = 0;

  show(config: SnackBarConfig): SnackBarMessage {
    const duplicate = this.findDuplicate(config.dedupeKey);
    if (duplicate) return duplicate;

    const message = this.createMessage(config);

    if (!this.current) {
      this.setCurrent(message);
    } else {
      this.queue.push(message);
    }

    return message;
  }

  info(title: string, message?: string, options: SnackBarShortcutConfig = {}): SnackBarMessage {
    return this.show({ ...options, title, message, type: 'info' });
  }

  success(title: string, message?: string, options: SnackBarShortcutConfig = {}): SnackBarMessage {
    return this.show({ ...options, title, message, type: 'success' });
  }

  warning(title: string, message?: string, options: SnackBarShortcutConfig = {}): SnackBarMessage {
    return this.show({ ...options, title, message, type: 'warning' });
  }

  error(title: string, message?: string, options: SnackBarShortcutConfig = {}): SnackBarMessage {
    return this.show({ ...options, title, message, type: 'error' });
  }

  dismiss(id?: string): void {
    if (id && this.current?.id !== id) {
      this.queue = this.queue.filter((message) => message.id !== id);
      return;
    }

    if (!this.current) {
      this.currentSubject.next(null);
      return;
    }

    this.setCurrent(this.queue.shift() ?? null);
  }

  clear(): void {
    this.queue = [];
    this.setCurrent(null);
  }

  private createMessage(config: SnackBarConfig): SnackBarMessage {
    const title = config.title.trim();

    return {
      id: `snack-${Date.now()}-${this.nextId++}`,
      title: title || 'Notification',
      message: config.message?.trim() || undefined,
      type: config.type ?? 'info',
      durationMs: config.durationMs ?? SnackBarService.DEFAULT_DURATION_MS,
      persistent: config.persistent ?? false,
      actionLabel: config.actionLabel?.trim() || undefined,
      onAction: config.onAction,
      dedupeKey: config.dedupeKey?.trim() || undefined,
      icon: config.icon?.trim() || undefined,
    };
  }

  private findDuplicate(dedupeKey?: string): SnackBarMessage | undefined {
    const key = dedupeKey?.trim();
    if (!key) return undefined;
    if (this.current?.dedupeKey === key) return this.current;
    return this.queue.find((message) => message.dedupeKey === key);
  }

  private setCurrent(message: SnackBarMessage | null): void {
    this.current = message;
    this.currentSubject.next(message);
  }
}
