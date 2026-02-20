import { Component, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.services';
import { DialogService } from '../../services/dialog.service';

const NAME_PATTERN     = /^[a-zA-ZÀ-ÿ\s'-]+$/;
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

@Component({
  selector: 'app-signup',
  templateUrl: './signup.html',
  standalone: true,
  imports: [CommonModule, RouterModule],
})
export class SignupComponent {

  isSigningUp = false;

  constructor(
    private authService: AuthService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private dialog: DialogService,
  ) {}

  async signup(event: Event): Promise<void> {
    event.preventDefault();

    const form = event.target as HTMLFormElement;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const firstName       = (form.querySelector('#firstName')       as HTMLInputElement).value.trim();
    const lastName        = (form.querySelector('#lastName')        as HTMLInputElement).value.trim();
    const email           = (form.querySelector('#email')           as HTMLInputElement).value.trim();
    const password        = (form.querySelector('#password')        as HTMLInputElement).value;
    const confirmPassword = (form.querySelector('#confirmPassword') as HTMLInputElement).value;

    if (!NAME_PATTERN.test(firstName) || !NAME_PATTERN.test(lastName)) {
      this.dialog.alert(
        'Invalid Name',
        'Names may only contain letters, spaces, hyphens, or apostrophes.',
      );
      return;
    }

    if (password !== confirmPassword) {
      this.dialog.alert('Passwords Do Not Match', 'Please make sure both password fields match.');
      return;
    }

    if (!PASSWORD_PATTERN.test(password)) {
      this.dialog.alert(
        'Weak Password',
        'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number.',
      );
      return;
    }

    this.isSigningUp = true;
    this.cdr.detectChanges();

    try {
      await this.authService.signup(firstName, lastName, email, password);

      this.isSigningUp = false;
      this.cdr.detectChanges();

      this.dialog.success(
        'Account Created!',
        'Your account is pending admin approval. You will be able to sign in once it has been reviewed.',
        () => this.router.navigate(['/login']),
      );

    } catch (err: any) {
      this.isSigningUp = false;
      this.cdr.detectChanges();

      const message = this.resolveSignupError(err);
      this.dialog.error('Sign Up Failed', message);
    }
  }



  private resolveSignupError(err: any): string {
    switch (err?.code) {
      case 'auth/email-already-in-use': return 'This email address is already registered.';
      case 'auth/invalid-email':         return 'The email address entered is not valid.';
      case 'auth/weak-password':         return 'The password provided is too weak.';
      default:                           return 'Sign up failed. Please try again.';
    }
  }
}