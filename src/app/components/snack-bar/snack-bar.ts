import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { SnackBarMessage, SnackBarService, SnackBarType } from '../../services/snack-bar.service';

@Component({
  selector: 'app-snack-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './snack-bar.html',
  styleUrl: './snack-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SnackBar implements OnInit, OnDestroy {
  messages: SnackBarMessage[] = [];
  private animatingIds = new Set<string>();

  private subscription?: Subscription;
  private enterTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private snackBarService: SnackBarService,
    private cdr: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    this.subscription = this.snackBarService.messages$.subscribe((messages) => {
      this.syncMessages(messages);
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.clearTimers();
  }

  dismiss(id?: string): void {
    this.snackBarService.dismiss(id);
  }

  onAction(message: SnackBarMessage): void {
    try {
      message.onAction?.();
    } finally {
      this.dismiss(message.id);
    }
  }

  roleFor(type: SnackBarType): 'alert' | 'status' {
    return type === 'warning' || type === 'error' ? 'alert' : 'status';
  }

  iconName(message: SnackBarMessage): string {
    if (message.icon) return message.icon;

    switch (message.type) {
      case 'success':
        return 'check_circle';
      case 'warning':
        return 'warning';
      case 'error':
        return 'error';
      default:
        return 'info';
    }
  }

  surfaceClass(type: SnackBarType): string {
    switch (type) {
      case 'success':
        return 'border-emerald-300/40 shadow-emerald-500/10';
      case 'warning':
        return 'border-amber-300/40 shadow-amber-500/10';
      case 'error':
        return 'border-red-300/40 shadow-red-500/10';
      default:
        return 'border-sky-300/40 shadow-sky-500/10';
    }
  }

  surfaceStateClass(message: SnackBarMessage): string {
    const motionClass = this.isAnimating(message.id)
      ? 'translate-y-0 opacity-100 scale-100'
      : 'translate-y-6 opacity-0 scale-[0.96]';

    return `${this.surfaceClass(message.type)} ${motionClass}`;
  }

  glowClass(type: SnackBarType): string {
    switch (type) {
      case 'success':
        return 'from-emerald-400/20 via-emerald-300/10 to-transparent';
      case 'warning':
        return 'from-amber-400/20 via-amber-300/10 to-transparent';
      case 'error':
        return 'from-red-400/20 via-red-300/10 to-transparent';
      default:
        return 'from-sky-400/20 via-sky-300/10 to-transparent';
    }
  }

  iconWrapClass(type: SnackBarType): string {
    switch (type) {
      case 'success':
        return 'bg-emerald-400/15 text-emerald-500 ring-emerald-400/30 shadow-emerald-400/20';
      case 'warning':
        return 'bg-amber-400/15 text-amber-500 ring-amber-400/30 shadow-amber-400/20';
      case 'error':
        return 'bg-red-400/15 text-red-500 ring-red-400/30 shadow-red-400/20';
      default:
        return 'bg-sky-400/15 text-sky-500 ring-sky-400/30 shadow-sky-400/20';
    }
  }

  titleClass(type: SnackBarType): string {
    switch (type) {
      case 'success':
        return 'text-emerald-900';
      case 'warning':
        return 'text-amber-950';
      case 'error':
        return 'text-red-950';
      default:
        return 'text-slate-900';
    }
  }

  actionClass(type: SnackBarType): string {
    switch (type) {
      case 'success':
        return 'text-emerald-700 hover:bg-emerald-400/15 focus-visible:ring-emerald-300/60';
      case 'warning':
        return 'text-amber-700 hover:bg-amber-400/15 focus-visible:ring-amber-300/60';
      case 'error':
        return 'text-red-700 hover:bg-red-400/15 focus-visible:ring-red-300/60';
      default:
        return 'text-sky-700 hover:bg-sky-400/15 focus-visible:ring-sky-300/60';
    }
  }

  progressClass(type: SnackBarType): string {
    switch (type) {
      case 'success':
        return 'bg-gradient-to-r from-emerald-400 to-emerald-500';
      case 'warning':
        return 'bg-gradient-to-r from-amber-400 to-amber-500';
      case 'error':
        return 'bg-gradient-to-r from-red-400 to-red-500';
      default:
        return 'bg-gradient-to-r from-sky-400 to-sky-500';
    }
  }

  progressDuration(durationMs: number): string {
    return `${durationMs}ms`;
  }

  private syncMessages(messages: SnackBarMessage[]): void {
    const previousIds = new Set(this.messages.map((message) => message.id));
    const nextIds = new Set(messages.map((message) => message.id));

    this.clearRemovedMessageState(nextIds);
    this.messages = messages;

    this.messages.forEach((message) => {
      if (!previousIds.has(message.id)) {
        this.scheduleEnter(message.id);
      }
      this.ensureAutoDismissTimer(message);
    });

    this.cdr.markForCheck();
  }

  private scheduleEnter(id: string): void {
    clearTimeout(this.enterTimers.get(id));

    const timer = setTimeout(() => {
      this.animatingIds.add(id);
      this.enterTimers.delete(id);
      this.cdr.markForCheck();
    }, 20);

    this.enterTimers.set(id, timer);
  }

  private ensureAutoDismissTimer(message: SnackBarMessage): void {
    if (message.persistent || message.durationMs <= 0 || this.autoDismissTimers.has(message.id)) return;

    const timer = setTimeout(() => {
      this.autoDismissTimers.delete(message.id);
      this.dismiss(message.id);
    }, message.durationMs);

    this.autoDismissTimers.set(message.id, timer);
  }

  private isAnimating(id: string): boolean {
    return this.animatingIds.has(id);
  }

  private clearRemovedMessageState(nextIds: Set<string>): void {
    Array.from(this.enterTimers.entries()).forEach(([id, timer]) => {
      if (!nextIds.has(id)) {
        clearTimeout(timer);
        this.enterTimers.delete(id);
      }
    });

    Array.from(this.autoDismissTimers.entries()).forEach(([id, timer]) => {
      if (!nextIds.has(id)) {
        clearTimeout(timer);
        this.autoDismissTimers.delete(id);
      }
    });

    Array.from(this.animatingIds).forEach((id) => {
      if (!nextIds.has(id)) {
        this.animatingIds.delete(id);
      }
    });
  }

  private clearTimers(): void {
    this.enterTimers.forEach((timer) => clearTimeout(timer));
    this.autoDismissTimers.forEach((timer) => clearTimeout(timer));
    this.enterTimers.clear();
    this.autoDismissTimers.clear();
    this.animatingIds.clear();
  }
}
