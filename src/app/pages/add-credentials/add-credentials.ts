import { Component } from '@angular/core';
import { Auth } from '@angular/fire/auth';
import { Router } from '@angular/router';
import { UserService } from '../../services/user';
import { DialogService } from '../../services/dialog.service';
import { LoggerService } from '../../services/logger.service';

@Component({
  selector: 'app-add-credentials',
  standalone: true,
  templateUrl: './add-credentials.html'
})
export class AddCredentialsComponent {

  isSaving = false;

  constructor(
    private auth: Auth,
    private userService: UserService,
    private router: Router,
    private dialogService: DialogService,
    private logger: LoggerService
  ) { }

  async saveAccount(event: Event) {
    event.preventDefault();

    const form = event.target as HTMLFormElement;


    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const firstName = (form.querySelector('#firstname') as HTMLInputElement)?.value.trim();
    const lastName = (form.querySelector('#lastname') as HTMLInputElement)?.value.trim();

    const currentUser = this.auth.currentUser;

    if (!currentUser) {
      this.dialogService.alert('Not Authenticated', 'User not authenticated. Please log in again.');
      return;
    }

    try {
      this.isSaving = true;

      await this.userService.createUser({
        uid: currentUser.uid,
        email: currentUser.email ?? '',
        fullName: `${firstName} ${lastName}`,
        role: 'staff',
        approved: false,
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString()
      });

      this.isSaving = false;
      this.dialogService.success(
        'Account Created',
        'Account successfully created!',
        () => this.router.navigate(['/app/dashboard'])
      );

    } catch (err: any) {
      this.isSaving = false;


      if (err.code === 'auth/email-already-in-use') {
        this.dialogService.error('Add Credentials Failed', 'This email is already in use.');
      } else if (err.code === 'auth/invalid-email') {
        this.dialogService.error('Add Credentials Failed', 'The email is invalid.');
      } else {
        this.dialogService.error('Add Credentials Failed', 'Failed to save account. Please try again.');
      }
      this.logger.error('AddCredentials error:', err);

    }
  }
}
