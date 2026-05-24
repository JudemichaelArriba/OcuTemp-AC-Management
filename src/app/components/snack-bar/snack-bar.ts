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
  item: SnackBarMessage | null = null;
  visible = false;
  animating = false;

  private subscription?: Subscription;
  private enterTimer?: ReturnType<typeof setTimeout>;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private autoDismissTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private snackBarService: SnackBarService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.subscription = this.snackBarService.current$.subscribe((message) => {
      if (message) {
        this.present(message);
      } else {
        this.hide();
      }
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.clearTimers();
  }

  get visibleItem(): SnackBarMessage | null {
    return this.visible ? this.item : null;
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

  surfaceStateClass(type: SnackBarType): string {
    const motionClass = this.animating
      ? 'translate-y-0 opacity-100 scale-100'
      : 'translate-y-6 opacity-0 scale-[0.96]';

    return `${this.surfaceClass(type)} ${motionClass}`;
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

  private present(message: SnackBarMessage): void {
    this.clearTimers();
    this.item = message;
    this.visible = true;
    this.animating = false;
    this.cdr.markForCheck();

    this.enterTimer = setTimeout(() => {
      this.animating = true;
      this.cdr.markForCheck();
    }, 20);

    if (!message.persistent && message.durationMs > 0) {
      this.autoDismissTimer = setTimeout(() => {
        this.dismiss(message.id);
      }, message.durationMs);
    }
  }

  private hide(): void {
    this.clearTimers();
    this.animating = false;
    this.cdr.markForCheck();

    this.hideTimer = setTimeout(() => {
      this.visible = false;
      this.item = null;
      this.cdr.markForCheck();
    }, 280);
  }

  private clearTimers(): void {
    clearTimeout(this.enterTimer);
    clearTimeout(this.hideTimer);
    clearTimeout(this.autoDismissTimer);
    this.enterTimer = undefined;
    this.hideTimer = undefined;
    this.autoDismissTimer = undefined;
  }
}