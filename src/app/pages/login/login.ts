import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.services';
import { DialogService } from '../../services/dialog.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.html',
  standalone: true,
  imports: [CommonModule, RouterModule],
})
export class LoginComponent implements OnInit {

  isLoggingIn = false;

  constructor(
    private authService: AuthService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private dialog: DialogService,
  ) {}

  ngOnInit(): void {}

  async login(event: Event): Promise<void> {
    event.preventDefault();

    const form = event.target as HTMLFormElement;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const email    = (form.querySelector('#email')    as HTMLInputElement).value.trim();
    const password = (form.querySelector('#password') as HTMLInputElement).value;

    this.isLoggingIn = true;
    this.cdr.detectChanges();

    try {
      const redirectTo = await this.authService.login(email, password);

      this.isLoggingIn = false;
      this.cdr.detectChanges();

        this.dialog.success(
        'Welcome back!',
        'You have signed in successfully.',
        () => this.router.navigate([redirectTo]) 
      );

    } catch (err: any) {
      this.isLoggingIn = false;
      this.cdr.detectChanges();

      if (err?.message?.startsWith('locked')) {
        const seconds = Number(err.message.split(':')[1]) || 0;
        this.dialog.alert(
          'Too Many Attempts',
          `Too many failed attempts. Please try again in ${seconds} seconds.`,
        );
      } else if (err?.message?.startsWith('lockout')) {
        const seconds = Number(err.message.split(':')[1]) || 0;
        this.dialog.alert(
          'Account Temporarily Locked',
          `Your account is locked. Please try again in ${seconds} seconds.`,
        );
      } else {
        const message = this.resolveLoginError(err);
        this.dialog.error('Sign In Failed', message);
      }
    }
  }


  private resolveLoginError(err: any): string {
    if (err?.message === 'not-approved') {
      return 'Your account is pending approval. Please contact Admin support.';
    }
    switch (err?.code) {
      case 'auth/user-not-found':    return 'No account found with that email address.';
      case 'auth/wrong-password':    return 'Incorrect password. Please try again.';
      case 'auth/invalid-credential': return 'Invalid credentials. Please check your details.';
      default:                        return 'Sign in failed. Please check your email and password.';
    }
  }
}