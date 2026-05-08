import { Injectable, NgZone } from '@angular/core';
import { UserService } from './user';
import {
  Auth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  setPersistence,
  browserSessionPersistence
} from '@angular/fire/auth';
import { AuthStateService } from './auth-state.service';
import { Database, ref, set } from '@angular/fire/database';
import { LoggerService } from './logger.service';
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'firebase/auth';

@Injectable({
  providedIn: 'root'
})
export class AuthService {

  constructor(
    private auth: Auth,
    private db: Database,
    private userService: UserService,
    private zone: NgZone,
    private authState: AuthStateService,
    private logger: LoggerService
  ) { }

  /**
   * Logs in a user.
   * Only logs to Sentry if the error is a system failure (network, etc).
   */
  async login(email: string, password: string): Promise<string> {
    try {
      await setPersistence(this.auth, browserSessionPersistence);

      const credential = await signInWithEmailAndPassword(this.auth, email, password);
      const uid = credential.user.uid;
      const existingUser = await this.userService.getUser(uid);

      if (existingUser && existingUser.role && existingUser.role !== 'admin' && existingUser.role !== 'staff') {
        await this.auth.signOut();
        throw new Error('Invalid credentials. Please check your details.');
      }

      if (existingUser && existingUser.approved === false) {
        await this.auth.signOut();
        throw new Error('not-approved');
      }

      if (existingUser) this.authState.setUser(existingUser);
      return existingUser ? '/app/dashboard' : '/add-credentials';

    } catch (err: any) {
      const isUserError = [
        'auth/user-not-found',
        'auth/wrong-password',
        'auth/invalid-credential',
        'not-approved'
      ].includes(err?.code || err?.message);

      if (!isUserError) {
        this.logger.error('Login system error:', err);
      }
      
      throw err;
    }
  }

  /**
   * Registers a new staff account.
   */
  async signup(
    firstName: string, 
    lastName: string, 
    email: string, 
    password: string
  ): Promise<void> {
    try {
      const credential = await createUserWithEmailAndPassword(this.auth, email, password);
      const uid = credential.user.uid;

      const newUser = {
        uid,
        email,
        fullName: `${firstName} ${lastName}`,
        role: 'staff',
        approved: false,
        createdAt: new Date().toISOString()
      };

      await set(ref(this.db, `users/${uid}`), newUser);
      await this.auth.signOut();
    } catch (err: any) {
      if (err?.code !== 'auth/email-already-in-use') {
        this.logger.error('Signup process failed:', err);
      }
      throw err;
    }
  }

  /**
   * Logs out the current user.
   */
  async logout(): Promise<void> {
    try {
      await this.auth.signOut();
      this.authState.clearUser?.();
    } catch (error) {
      this.logger.error('Logout failed:', error);
      throw error;
    }
  }

  /**
   * Re-authenticates and updates password.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    try {
      const user = this.auth.currentUser;
      if (!user) {
        throw new Error('User not authenticated');
      }

      const credential = EmailAuthProvider.credential(user.email!, currentPassword);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPassword);
    } catch (err: any) {
      if (err?.code !== 'auth/wrong-password' && err?.code !== 'auth/invalid-credential') {
        this.logger.error('Change Password system failure:', err);
      }
      throw err;
    }
  }
}