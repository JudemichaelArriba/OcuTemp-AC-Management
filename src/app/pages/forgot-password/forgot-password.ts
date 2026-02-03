import { Component, ChangeDetectorRef } from '@angular/core';
import { Auth, sendPasswordResetEmail } from '@angular/fire/auth';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './forgot-password.html',
})
export class ForgotPasswordComponent {

  isSending = false;

  constructor(
    private auth: Auth,
    private cdr: ChangeDetectorRef
  ) {}

  async resetPassword(event: Event) {
    event.preventDefault();

    const form = event.target as HTMLFormElement;

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const email = (form.querySelector('#email') as HTMLInputElement).value.trim();


    this.isSending = true;
    this.cdr.detectChanges();

    try {
      await sendPasswordResetEmail(this.auth, email);

  
      this.isSending = false;
      this.cdr.detectChanges();

      setTimeout(() => {
        alert('Password reset link sent. Please check your email.');
        form.reset();
      }, 100);

    } catch (err: any) {

    
      this.isSending = false;
      this.cdr.detectChanges();

      let message = 'Failed to send reset email.';
      if (err.code === 'auth/user-not-found') {
        message = 'No account found with this email.';
      }

      setTimeout(() => {
        alert(message);
      }, 100);
    }
  }
}
