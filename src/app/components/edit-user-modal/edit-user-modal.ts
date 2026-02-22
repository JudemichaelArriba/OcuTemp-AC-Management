import {
  Component, Input, Output, EventEmitter,
  OnChanges, SimpleChanges, ChangeDetectionStrategy, ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { User } from '../../models/user.model';
import { UserService } from '../../services/user';
import { DialogService } from '../../services/dialog.service';

@Component({
  selector: 'app-edit-user-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './edit-user-modal.html',
  styleUrl: './edit-user-modal.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditUserModal implements OnChanges {
  @Input() user: User | null = null;
  @Output() closed = new EventEmitter<void>();
  @Output() userUpdated = new EventEmitter<User>();

  editFirstName = '';
  editLastName = '';
  isSaving = false;

  visible = false;
  animating = false;

  constructor(
    private userService: UserService,
    private dialogService: DialogService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['user']) {
      if (this.user) {
        const parts = (this.user.fullName || '').trim().split(' ');
        this.editFirstName = parts[0] || '';
        this.editLastName = parts.slice(1).join(' ') || '';
        this.openModal();
      } else {

        this.animateOut();
      }
    }
  }

  private openModal(): void {
    this.visible = true;
    this.animating = false;
    this.isSaving = false;
    this.cdr.markForCheck();
    requestAnimationFrame(() => {
      setTimeout(() => {
        this.animating = true;
        this.cdr.markForCheck();
      }, 20);
    });
  }

  private animateOut(afterDone?: () => void): void {
    this.animating = false;
    this.cdr.markForCheck();
    setTimeout(() => {
      this.visible = false;
      this.cdr.markForCheck();
      afterDone?.();
    }, 280);
  }

  close(): void {
    if (this.isSaving) return;
    this.animateOut(() => this.closed.emit());
  }

  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('eu-backdrop')) {
      this.close();
    }
  }

  getRoleBadgeClass(role?: string): string {
    return role === 'admin'
      ? 'bg-purple-100 text-purple-700 border-purple-200'
      : 'bg-blue-100 text-blue-700 border-blue-200';
  }

  async onSave(): Promise<void> {
    if (!this.user || this.isSaving) return;

    const trimmedFirst = this.editFirstName.trim();
    const trimmedLast = this.editLastName.trim();


    const originalParts = (this.user.fullName || '').trim().split(' ');
    const originalFirst = originalParts[0] || '';
    const originalLast = originalParts.slice(1).join(' ') || '';


    if (trimmedFirst === originalFirst && trimmedLast === originalLast) {
      this.dialogService.alert('No Changes', 'You have not made any changes to save.');
      return;
    }

    if (!trimmedFirst) {
      this.dialogService.error('Validation Error', 'First name is required.');
      return;
    }


    const namePattern = /^[a-zA-Z\s'\-]+$/;
    if (!namePattern.test(trimmedFirst) || (trimmedLast && !namePattern.test(trimmedLast))) {
      this.dialogService.error('Invalid Input', 'Name may only contain letters, spaces, hyphens, and apostrophes.');
      return;
    }

    this.isSaving = true;
    this.cdr.markForCheck();

    try {
      const newFullName = [trimmedFirst, trimmedLast].filter(Boolean).join(' ');


      await this.userService.updateUserFullName(this.user.uid, newFullName);

      const updatedUser: User = { ...this.user, fullName: newFullName };


      this.animateOut(() => {
        this.userUpdated.emit(updatedUser);
        this.closed.emit();
        setTimeout(() => {
          this.dialogService.success(
            'User Updated',
            `${newFullName}'s name has been saved successfully.`
          );
        }, 50);
      });

    } catch (err) {
      console.error('Failed to update user:', err);
      this.isSaving = false;
      this.cdr.markForCheck();
      this.dialogService.error('Update Failed', 'Something went wrong. Please try again.');
    }
  }
}