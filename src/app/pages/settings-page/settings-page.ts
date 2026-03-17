import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthStateService } from '../../services/auth-state.service';
import { User } from '../../models/user.model';
import { Observable } from 'rxjs';
import { UserService } from '../../services/user';
import { LoggerService } from '../../services/logger.service';
import { DialogService } from '../../services/dialog.service';

@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
})

export class SettingsPage {
  currentUser$: Observable<User | null>;
  isEditing = false;
  fullNameDraft = '';
  isSaving = false;

  constructor(
    private auhtState: AuthStateService,
    private userService: UserService,
    private logger: LoggerService,
    private dialogService: DialogService
  ) {
    this.currentUser$ = this.auhtState.currentUser$;
  }

  getUserInitials(user?: User | null): string {
    if (!user?.fullName) return 'U';
    const parts = user.fullName.trim().split(' ');
    return parts.map(p => p.charAt(0).toUpperCase()).slice(0, 2).join('');
  }


  startEdit(userFullname: string | null | undefined) {
    if (this.isSaving) return;
    this.fullNameDraft = userFullname ?? "";
    this.isEditing = true;
  }

  cancelEdit() {
    this.isEditing = false;
  }

  async saveChanges(user: User | null) {

    if (!user) return;
    const trimmed = this.fullNameDraft.trim();
    const current = user.fullName?.trim() ?? '';


    if (trimmed === current) {
      this.dialogService.alert('No Changes', 'You have not made any changes to save.');
      return;
    }

    if (!trimmed) {
      this.dialogService.error('Validation Error', 'Full name cannot be empty.');
      return;
    }

    this.dialogService.confirm(
      'Confirm update',
      'Save your updated full name?',
      async () => {

        this.isSaving = true;
        try {
          await this.userService.updateUserFullName(user.uid, trimmed);
          this.auhtState.setUser({ ...user, fullName: trimmed });
          this.isEditing = false;

          this.dialogService.success('Updated', 'Your name was updated successfully.');
        } catch (err) {
          this.logger.error('Failed to update name', err);
          this.dialogService.error('Update Failed', 'Something went wrong. Please try again.');
        } finally {
          this.isSaving = false;
        }
      }

    );

  }
}
