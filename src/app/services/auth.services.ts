import { Injectable } from '@angular/core';
import { Auth, signInWithEmailAndPassword } from '@angular/fire/auth';

@Injectable({
  providedIn: 'root'
})
export class AuthService {

  private loginAttempts = 0;
  private lockoutTime = 0;
  private readonly MAX_ATTEMPTS = 5;
  private readonly LOCKOUT_DURATION = 60 * 1000;

  constructor(private auth: Auth) {}

  async login(email: string, password: string): Promise<void> {
    const now = Date.now();
    if (this.lockoutTime > now) {
      throw new Error(`locked:${Math.ceil((this.lockoutTime - now) / 1000)}`);
    }

    try {
      await signInWithEmailAndPassword(this.auth, email, password);
      this.loginAttempts = 0;
    } catch (err: any) {
      this.loginAttempts++;
      if (this.loginAttempts >= this.MAX_ATTEMPTS) {
        this.lockoutTime = Date.now() + this.LOCKOUT_DURATION;
        throw new Error(`lockout:${this.LOCKOUT_DURATION / 1000}`);
      }


      throw err;
    }
  }
}
