import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.services';

@Component({
  selector: 'app-login',
  templateUrl: './login.html',
  standalone: true,
  imports: [CommonModule, RouterModule]
})
export class LoginComponent implements OnInit {

  isLoggingIn = false;

  constructor(
    private authService: AuthService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {}

  async login(event: Event) {
  event.preventDefault();

  const form = event.target as HTMLFormElement;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const email = (form.querySelector('#email') as HTMLInputElement).value.trim();
  const password = (form.querySelector('#password') as HTMLInputElement).value;

  this.isLoggingIn = true;
  this.cdr.detectChanges();

  try {
    // Get the target route from AuthService
    const redirectTo = await this.authService.login(email, password);

    this.isLoggingIn = false;
    this.cdr.detectChanges();

    // Show alert first
    alert('Login successful!');

    // Redirect AFTER user clicks OK
    this.router.navigate([redirectTo]);

  } catch (err: any) {
    this.isLoggingIn = false;
    this.cdr.detectChanges();

    if (err.message.startsWith('locked')) {
      const seconds = err.message.split(':')[1];
      alert(`Too many failed attempts. Try again in ${seconds} seconds.`);
    } else if (err.message.startsWith('lockout')) {
      const seconds = err.message.split(':')[1];
      alert(`You are locked out for ${seconds} seconds.`);
    } else {
      let message = 'Login failed. Please check your email and password.';
      if (err.code === 'auth/user-not-found') message = 'User not found.';
      if (err.code === 'auth/wrong-password') message = 'Incorrect password.';
      if (err.code === 'auth/invalid-credential') message = 'Invalid credentials.';
      alert(message);
    }
  }
}

}
