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
      alert('User not authenticated.');
      return;
    }

    try {
      this.isSaving = true;

      await this.userService.createUser({
        uid: currentUser.uid,
        email: currentUser.email,
        fullName: `${firstName} ${lastName}`,
        role: 'staff',
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString()
      });

      this.router.navigate(['/app/dashboard']); 

    } catch (error) {
      console.error(error);
      alert('Failed to save account.');
    } finally {
      this.isSaving = false;
    }
  }
}
