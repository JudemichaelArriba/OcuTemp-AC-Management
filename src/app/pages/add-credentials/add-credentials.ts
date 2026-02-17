import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Auth } from '@angular/fire/auth';
import { Router } from '@angular/router';
import { UserService } from '../../services/user';

@Component({
  selector: 'app-add-credentials',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './add-credentials.html'
})
export class AddCredentialsComponent {

  isSaving = false;

  constructor(
    private auth: Auth,
    private userService: UserService,
    private router: Router
  ) {}

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
      alert('User not authenticated. Please log in again.');
      return;
    }

    try {
      this.isSaving = true;

      await this.userService.createUser({
        uid: currentUser.uid,
        email: currentUser.email ?? '',
        fullName: `${firstName} ${lastName}`,
        role: 'staff',
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString()
      });

      this.isSaving = false;
      alert('Account successfully created!');
      this.router.navigate(['/app/dashboard']); 

    } catch (err: any) {
      this.isSaving = false;

  
      if (err.code === 'auth/email-already-in-use') {
        alert('This email is already in use.');
      } else if (err.code === 'auth/invalid-email') {
        alert('The email is invalid.');
      } else {
        alert('Failed to save account. Please try again.');
      }

      console.error('AddCredentials error:', err);
    }
  }
}
