import { Component, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.services';

@Component({
  selector: 'app-signup',
  templateUrl: './signup.html',
  standalone: true,
  imports: [CommonModule, RouterModule]
})
export class SignupComponent {

  isSigningUp = false;

  constructor(
    private authService: AuthService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  async signup(event: Event) {
    event.preventDefault();

    const form = event.target as HTMLFormElement;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const firstName     = (form.querySelector('#firstName') as HTMLInputElement).value.trim();
    const lastName      = (form.querySelector('#lastName') as HTMLInputElement).value.trim();
    const email         = (form.querySelector('#email') as HTMLInputElement).value.trim();
    const password      = (form.querySelector('#password') as HTMLInputElement).value;
    const confirmPassword = (form.querySelector('#confirmPassword') as HTMLInputElement).value;


    const namePattern = /^[a-zA-ZÀ-ÿ\s'-]+$/;
    if (!namePattern.test(firstName) || !namePattern.test(lastName)) {
      alert('Names may only contain letters, spaces, hyphens, or apostrophes.');
      return;
    }

    if (password !== confirmPassword) {
      alert('Passwords do not match.');
      return;
    }

   
    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    if (!strongPassword.test(password)) {
      alert('Password must be at least 8 characters and include uppercase, lowercase, and a number.');
      return;
    }

    this.isSigningUp = true;
    this.cdr.detectChanges();

    try {
      await this.authService.signup(firstName, lastName, email, password);

      this.isSigningUp = false;
      this.cdr.detectChanges();

      alert('Account created! Your account is pending approval. Please wait for an admin to approve it before signing in.');
      this.router.navigate(['/login']);

    } catch (err: any) {
      this.isSigningUp = false;
      this.cdr.detectChanges();

      let message = 'Sign up failed. Please try again.';
      if (err.code === 'auth/email-already-in-use') message = 'This email is already registered.';
      if (err.code === 'auth/invalid-email')        message = 'Invalid email address.';
      if (err.code === 'auth/weak-password')        message = 'Password is too weak.';
      alert(message);
    }
  }
}