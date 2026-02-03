import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { Auth, signInWithEmailAndPassword } from '@angular/fire/auth';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';


@Component({
  selector: 'app-login',
  templateUrl: './login.html',
  standalone: true,
  imports: [CommonModule, RouterModule]
})
export class LoginComponent implements OnInit {

  isLoggingIn = false; 
  private loginAttempts = 0;
  private lockoutTime = 0;
  private readonly MAX_ATTEMPTS = 5;
  private readonly LOCKOUT_DURATION = 60 * 1000;

  constructor(
    private auth: Auth, 
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {}

  async login(event: Event) {
    event.preventDefault();

    const now = Date.now();
    if (this.lockoutTime > now) {
      alert(`Too many failed attempts. Try again in ${Math.ceil((this.lockoutTime - now) / 1000)} seconds.`);
      return;
    }

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
      await signInWithEmailAndPassword(this.auth, email, password);

      this.loginAttempts = 0;
      
      this.isLoggingIn = false;
      this.cdr.detectChanges();
      
      setTimeout(() => {
        alert('Login successful!');
         this.router.navigate(['/app']);
      }, 100);
      
    } catch (err: any) {
      this.loginAttempts++;
      
      if (this.loginAttempts >= this.MAX_ATTEMPTS) {
        this.lockoutTime = Date.now() + this.LOCKOUT_DURATION;
        
   
        this.isLoggingIn = false;
        this.cdr.detectChanges();
        
        setTimeout(() => {
          alert(`Too many failed attempts. You are locked out for ${this.LOCKOUT_DURATION / 1000} seconds.`);
        }, 100);
        return;
      }

         this.isLoggingIn = false;
      this.cdr.detectChanges();
      
      let message = 'Login failed. Please check your email and password.';
      if (err.code === 'auth/user-not-found') message = 'User not found.';
      if (err.code === 'auth/wrong-password') message = 'Incorrect password.';
      if (err.code === 'auth/invalid-credential') message = 'Invalid credentials.';


   
      setTimeout(() => {
        alert(message);
      }, 100);
    }
  }
}