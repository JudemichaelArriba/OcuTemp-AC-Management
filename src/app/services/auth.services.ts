import { Injectable, NgZone } from '@angular/core';
import { UserService } from './user';
import {
  Auth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  setPersistence,
  browserSessionPersistence,
  sendEmailVerification,
  updateProfile,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  User as FirebaseUser,
  UserCredential
} from '@angular/fire/auth';
import { AuthStateService } from './auth-state.service';
import { Database, ref, set, update } from '@angular/fire/database';
import { LoggerService } from './logger.service';

type SignupResult = {
  resumed: boolean;
  verificationEmailSent: boolean;
};

function authFlowError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

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

  async login(email: string, password: string): Promise<string> {
    try {
      await setPersistence(this.auth, browserSessionPersistence);

      const credential = await signInWithEmailAndPassword(this.auth, email, password);
      const uid = credential.user.uid;
      const existingUser = await this.userService.getUser(uid);
      const isAdmin = existingUser?.role === 'admin';

      if (existingUser && existingUser.role && existingUser.role !== 'admin' && existingUser.role !== 'staff') {
        await this.auth.signOut();
        throw new Error('Invalid credentials. Please check your details.');
      }

      if (existingUser && existingUser.approved === false) {
        await this.auth.signOut();
        throw new Error('not-approved');
      }

      if (!credential.user.emailVerified && !isAdmin) {
        await this.auth.signOut();
        throw new Error('email-not-verified');
      }

      if (existingUser && !existingUser.emailVerified) {
        await update(ref(this.db, `users/${uid}`), { emailVerified: true });
      }

      if (existingUser) this.authState.setUser({ ...existingUser, emailVerified: true });
      return existingUser ? '/app/dashboard' : '/add-credentials';

    } catch (err: any) {
      const isUserError = [
        'auth/user-not-found',
        'auth/wrong-password',
        'auth/invalid-credential',
        'not-approved',
        'email-not-verified'
      ].includes(err?.code || err?.message);

      if (!isUserError) {
        this.logger.error('Login system error:', err);
      }

      throw err;
    }
  }

  /**
   * Step 1: Creates the Firebase Auth account, sets display name, sends verification email.
   * Does NOT write to RTDB - avoids token timing permission errors.
   * Returns { resumed: true } if an orphaned unverified account was recovered.
   */
  async signup(
    firstName: string,
    lastName: string,
    email: string,
    password: string
  ): Promise<SignupResult> {
    let credential: UserCredential;

    try {
      credential = await createUserWithEmailAndPassword(this.auth, email, password);
    } catch (err: any) {
      if (err?.code === 'auth/email-already-in-use') {
        return await this.recoverOrphanedSignup(email, password);
      }

      this.logger.error('Signup account creation failed:', err);
      throw err;
    }

    try {
      await updateProfile(credential.user, {
        displayName: `${firstName} ${lastName}`
      });
    } catch (err: any) {
      this.logger.error('Signup profile update failed:', err);
    }

    const verificationEmailSent = await this.trySendVerificationEmail(
      credential.user,
      'Signup verification email failed:'
    );

    return { resumed: false, verificationEmailSent };
  }

  /**
   * Handles orphaned accounts: Auth exists, email unverified, no RTDB record.
   * This happens when a user signed up but left before verifying their email.
   */
  private async recoverOrphanedSignup(email: string, password: string): Promise<SignupResult> {
    try {
      const credential = await signInWithEmailAndPassword(this.auth, email, password);

      if (credential.user.emailVerified) {
        await this.auth.signOut();
        throw authFlowError('auth/email-already-in-use', 'email-already-in-use');
      }

      const existingRecord = await this.userService.getUser(credential.user.uid);
      if (existingRecord) {
        await this.auth.signOut();
        throw authFlowError('auth/email-already-in-use', 'email-already-in-use');
      }

      const verificationEmailSent = await this.trySendVerificationEmail(
        credential.user,
        'Recovered signup verification email failed:'
      );

      return { resumed: true, verificationEmailSent };

    } catch (err: any) {
      if (err?.code === 'auth/wrong-password' || err?.code === 'auth/invalid-credential') {
        throw authFlowError('auth/email-already-in-use', 'email-already-in-use');
      }
      throw err;
    }
  }

  private async trySendVerificationEmail(user: FirebaseUser, logMessage: string): Promise<boolean> {
    try {
      await sendEmailVerification(user);
      return true;
    } catch (err: any) {
      this.logger.error(logMessage, err);
      return false;
    }
  }

  /**
   * Step 2: Called only after email is verified via polling.
   * Writes the user record to RTDB then signs out.
   */
  async completeSignup(
    firstName: string,
    lastName: string,
    email: string
  ): Promise<void> {
    try {
      const user = this.auth.currentUser;
      if (!user) throw authFlowError('auth/no-current-user', 'User session lost. Please sign up again.');

      await user.reload();
      if (!user.emailVerified) {
        throw authFlowError('auth/email-not-verified', 'email-not-verified');
      }

      const newUser = {
        uid: user.uid,
        email,
        fullName: `${firstName} ${lastName}`,
        role: 'staff',
        approved: false,
        emailVerified: true,
        createdAt: new Date().toISOString()
      };

      await set(ref(this.db, `users/${user.uid}`), newUser);
      await this.auth.signOut();
    } catch (err: any) {
      this.logger.error('Signup step 2 failed:', err);
      throw err;
    }
  }

  /**
   * Reloads the Firebase Auth user to get the latest emailVerified status.
   */
  async checkEmailVerified(): Promise<boolean> {
    const user = this.auth.currentUser;
    if (!user) {
      throw authFlowError('auth/no-current-user', 'Verification session expired.');
    }

    await user.reload();
    return user.emailVerified;
  }

  /**
   * Resends the verification email to the currently signed-in unverified user.
   */
  async resendVerificationEmail(): Promise<void> {
    const user = this.auth.currentUser;
    if (!user) {
      throw authFlowError('auth/no-current-user', 'Verification session expired.');
    }

    await user.reload();
    if (user.emailVerified) {
      throw authFlowError('auth/email-already-verified', 'email-already-verified');
    }

    try {
      await sendEmailVerification(user);
    } catch (err: any) {
      this.logger.error('Resend verification email failed:', err);
      throw err;
    }
  }

  async logout(): Promise<void> {
    try {
      await this.auth.signOut();
      this.authState.clearUser?.();
    } catch (error) {
      this.logger.error('Logout failed:', error);
      throw error;
    }
  }

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
