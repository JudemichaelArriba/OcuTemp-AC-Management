import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthStateService } from '../../services/auth-state.service';
import { User } from '../../models/user.model';
import { Observable } from 'rxjs';
import { UserService } from '../../services/user';
import { LoggerService } from '../../services/logger.service';
import { DialogService } from '../../services/dialog.service';
import { AuthService } from '../../services/auth.services';
import { PASSWORD_PATTERN, PASSWORD_HELP_TEXT } from '../../helpers/auth-validation';


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
  isPasswordEditing = false;
  isPasswordSaving = false;
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';


  constructor(
    private auhtState: AuthStateService,
    private userService: UserService,
    private logger: LoggerService,
    private dialogService: DialogService,
    private authService: AuthService
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

    if (trimmed.length > 50) {
      this.dialogService.error('Validation Error', 'Full name must be 50 characters or less.');
      return;
    }

    if (!/^[a-zA-Z0-9\s\-]+$/.test(trimmed)) {
      this.dialogService.error('Validation Error', 'Full name has invalid characters.');
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
          this.logger.error('Failed to update name');
          this.dialogService.error('Update Failed', 'Something went wrong. Please try again.');
        } finally {
          this.isSaving = false;
        }
      }

    );

  }


  startPasswordEdit() {
    if (this.isPasswordEditing) return;
    this.isPasswordEditing = true;
  }

  cancelPasswordEdit() {
    this.isPasswordEditing = false;
    this.currentPassword = '';
    this.newPassword = '';
    this.confirmPassword = '';

  }


 private mapAuthError(err: any): string {
  const code =
    err?.code ||
    err?.customData?._tokenResponse?.error?.message ||
    err?.message;

  switch (code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'INVALID_PASSWORD':
    case 'INVALID_LOGIN_CREDENTIALS':
      return 'Current password is incorrect.';
    case 'auth/weak-password':
      return 'New password is too weak.';
    case 'auth/requires-recent-login':
      return 'Please log out and log back in, then try again.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Try again later.';
    default:
      return 'Something went wrong. Please try again.';
  }
}





  savePassword() {
    if (this.isPasswordSaving) return;


    const current = this.currentPassword;
    const next = this.newPassword;
    const confirm = this.confirmPassword;


    if (!current && !next && !confirm) {
      this.dialogService.alert('No Changes', 'Enter your password details first.');
      return;
    }

    if (!current || !next || !confirm) {
      this.dialogService.error('Validation Error', 'All password fields are required.');
      return;
    }

    if (!PASSWORD_PATTERN.test(next)) {
      this.dialogService.error('Weak Password', PASSWORD_HELP_TEXT);
      return;
    }

    if (next !== confirm) {
      this.dialogService.error('Validation Error', 'New passwords do not match.');
      return;
    }
    if (current === next) {
      this.dialogService.error('Validation Error', 'New password must be different from the current password.');
      return;
    }



    this.dialogService.confirm(
      'Confirm update',
      'Save your updated password?',
      async () => {

        this.isPasswordSaving = true;
        try {
          await this.authService.changePassword(current, next);
          this.cancelPasswordEdit();
          this.dialogService.success('Updated', 'Your password was updated successfully.');
        } catch (err: any) {
          this.dialogService.error('Update Failed', this.mapAuthError(err));
        } finally {
          this.isPasswordSaving = false;
        }

      }
    );
  }

}
