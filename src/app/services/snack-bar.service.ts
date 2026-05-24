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
  private static readonly MAX_VISIBLE = 3;
  private static readonly DEFAULT_DURATION_MS = 6500;

  private readonly messagesSubject = new BehaviorSubject<SnackBarMessage[]>([]);
  readonly messages$ = this.messagesSubject.asObservable();

  private readonly currentSubject = new BehaviorSubject<SnackBarMessage | null>(null);
  readonly current$ = this.currentSubject.asObservable();

  private visibleMessages: SnackBarMessage[] = [];
  private queuedMessages: SnackBarMessage[] = [];
  private nextId = 0;

  show(config: SnackBarConfig): SnackBarMessage {
    const duplicate = this.findDuplicate(config.dedupeKey);
    if (duplicate) return duplicate;

    const message = this.createMessage(config);

    if (this.visibleMessages.length < SnackBarService.MAX_VISIBLE) {
      this.visibleMessages = [message, ...this.visibleMessages];
      this.emitState();
    } else {
      this.queuedMessages.push(message);
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
    if (id) {
      const visibleIndex = this.visibleMessages.findIndex((message) => message.id === id);

      if (visibleIndex >= 0) {
        this.visibleMessages = this.visibleMessages.filter((message) => message.id !== id);
        this.promoteQueuedMessages();
        this.emitState();
        return;
      }

      this.queuedMessages = this.queuedMessages.filter((message) => message.id !== id);
      return;
    }

    if (this.visibleMessages.length === 0) {
      this.emitState();
      return;
    }

    this.visibleMessages = this.visibleMessages.slice(1);
    this.promoteQueuedMessages();
    this.emitState();
  }

  clear(): void {
    this.visibleMessages = [];
    this.queuedMessages = [];
    this.emitState();
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
    return (
      this.visibleMessages.find((message) => message.dedupeKey === key) ??
      this.queuedMessages.find((message) => message.dedupeKey === key)
    );
  }

  private promoteQueuedMessages(): void {
    while (
      this.visibleMessages.length < SnackBarService.MAX_VISIBLE &&
      this.queuedMessages.length > 0
    ) {
      const next = this.queuedMessages.shift();
      if (next) {
        this.visibleMessages = [next, ...this.visibleMessages];
      }
    }
  }

  private emitState(): void {
    const visibleSnapshot = [...this.visibleMessages];
    this.messagesSubject.next(visibleSnapshot);
    this.currentSubject.next(visibleSnapshot[0] ?? null);
  }
}
