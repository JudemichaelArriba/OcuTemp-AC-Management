import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export type DialogType = 'success' | 'error' | 'alert' | 'confirm';

export interface DialogConfig {
  type: DialogType;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  /** Optional third button, shown between cancel and confirm on `confirm` dialogs. */
  secondaryLabel?: string;
  onSecondary?: () => void;
}

export interface DialogChoice {
  label: string;
  action: () => void;
}

@Injectable({ providedIn: 'root' })
export class DialogService {

  readonly dialog$ = new Subject<DialogConfig | null>();
  open(config: DialogConfig): void {
    this.dialog$.next(config);
  }

  success(title: string, message: string, onConfirm?: () => void): void {
    this.open({ type: 'success', title, message, confirmLabel: 'Got it', onConfirm });
  }

  error(title: string, message: string, onConfirm?: () => void): void {
    this.open({ type: 'error', title, message, confirmLabel: 'OK', onConfirm });
  }

  alert(title: string, message: string, onConfirm?: () => void): void {
    this.open({ type: 'alert', title, message, confirmLabel: 'OK', onConfirm });
  }

  /**
   * @param onConfirm  
   * @param onCancel 
   */
  confirm(
    title: string,
    message: string,
    onConfirm: () => void,
    onCancel?: () => void,
    confirmLabel = 'Confirm',
    cancelLabel  = 'Cancel'
  ): void {
    this.open({ type: 'confirm', title, message, confirmLabel, cancelLabel, onConfirm, onCancel });
  }

  /** Confirm dialog with two distinct actions plus cancel. Keep labels short (3 buttons share one row). */
  choose(
    title: string,
    message: string,
    primary: DialogChoice,
    secondary: DialogChoice,
    cancelLabel = 'Cancel',
    onCancel?: () => void
  ): void {
    this.open({
      type: 'confirm',
      title,
      message,
      confirmLabel: primary.label,
      onConfirm: primary.action,
      secondaryLabel: secondary.label,
      onSecondary: secondary.action,
      cancelLabel,
      onCancel,
    });
  }


  close(): void {
    this.dialog$.next(null);
  }
}