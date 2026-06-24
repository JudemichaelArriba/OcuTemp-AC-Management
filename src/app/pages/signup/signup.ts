import { Component, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { RouterModule } from '@angular/router';
import { AuthService } from '../../services/auth.services';
import { DialogService } from '../../services/dialog.service';
import { PASSWORD_PATTERN } from '../../helpers/auth-validation';
import { RateLimiter } from '../../helpers/rate-limiter';

type SignupPhase = 'idle' | 'creating' | 'awaitingVerification' | 'resending' | 'checkingVerification' | 'finalizing';

@Component({
  selector: 'app-signup',
  templateUrl: './signup.html',
  standalone: true,
  imports: [RouterModule],
})
export class SignupComponent implements OnDestroy {

  phase: SignupPhase = 'idle';
  resendCooldown = 0;
  verificationEmailSent = false;

  pendingEmail = '';
  private pendingFirstName = '';
  private pendingLastName = '';

  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private resendTimer: ReturnType<typeof setInterval> | null = null;

  private readonly rateLimiter = new RateLimiter('signup_attempts', 5, 300_000);

  constructor(
    private authService: AuthService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private dialog: DialogService,
  ) { }

  get isSigningUp(): boolean {
    return this.phase === 'creating';
  }

  get awaitingVerification(): boolean {
    return this.phase === 'awaitingVerification'
      || this.phase === 'resending'
      || this.phase === 'checkingVerification'
      || this.phase === 'finalizing';
  }

  get isCompletingSignup(): boolean {
    return this.phase === 'finalizing';
  }

  get isResendingVerification(): boolean {
    return this.phase === 'resending';
  }

  get isCheckingVerification(): boolean {
    return this.phase === 'checkingVerification';
  }

  ngOnDestroy(): void {
    this.clearPolling();
    this.clearResendTimer();
  }

  async signup(event: Event): Promise<void> {
    event.preventDefault();

    if (this.rateLimiter.isBlocked()) {
      const minutes = Math.ceil(this.rateLimiter.remainingMs() / 60_000);
      this.dialog.alert(
        'Too Many Attempts',
        `Too many sign-up attempts from this device. Please wait ${minutes} minute${minutes !== 1 ? 's' : ''} before trying again.`,
      );
      return;
    }

    const form = event.target as HTMLFormElement;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const firstName = (form.querySelector('#firstName') as HTMLInputElement).value.trim();
    const lastName = (form.querySelector('#lastName') as HTMLInputElement).value.trim();
    const email = (form.querySelector('#email') as HTMLInputElement).value.trim();
    const password = (form.querySelector('#password') as HTMLInputElement).value;
    const confirmPassword = (form.querySelector('#confirmPassword') as HTMLInputElement).value;

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

    this.clearPolling();
    this.setPhase('creating');
    this.rateLimiter.record();

    let verificationStarted = false;

    try {
      const { resumed, verificationEmailSent } = await this.authService.signup(firstName, lastName, email, password);

      this.pendingFirstName = firstName;
      this.pendingLastName = lastName;
      this.pendingEmail = email;
      this.verificationEmailSent = verificationEmailSent;
      verificationStarted = true;

      this.setPhase('awaitingVerification');
      this.startPolling();

      if (resumed && verificationEmailSent) {
        this.dialog.alert(
          'Verification Pending',
          'This email was registered but never verified. A new verification link has been sent to your inbox.',
        );
      } else if (!verificationEmailSent) {
        this.dialog.alert(
          'Verification Email Not Sent',
          'Your account was created, but Firebase could not send the verification email. Please use Resend to try again.',
        );
      }

    } catch (err: any) {
      const message = this.resolveSignupError(err);
      this.dialog.error('Sign Up Failed', message);
    } finally {
      if (!verificationStarted && this.phase === 'creating') {
        this.setPhase('idle');
      }
    }
  }

  async resendVerification(): Promise<void> {
    if (this.resendCooldown > 0 || this.isResendingVerification || this.isCompletingSignup) return;

    this.setPhase('resending');

    try {
      await this.authService.resendVerificationEmail();
      this.verificationEmailSent = true;
      this.startResendCooldown(60);
      this.dialog.success('Verification Email Sent', 'A new verification link has been sent to your inbox.');
    } catch (err: any) {
      if (err?.code === 'auth/email-already-verified') {
        await this.finishSignup();
        return;
      }

      this.dialog.error('Verification Email Failed', this.resolveVerificationEmailError(err));
    } finally {
      if (this.phase === 'resending') {
        this.setPhase('awaitingVerification');
      }
    }
  }



  private startPolling(): void {
    this.clearPolling();

    this.pollInterval = setInterval(async () => {
      if (this.isCompletingSignup || this.isCheckingVerification) return;

      try {
        const verified = await this.authService.checkEmailVerified();
        if (verified) {
          this.clearPolling();
          await this.finishSignup();
        }
      } catch (err: any) {
        if (err?.code === 'auth/no-current-user') {
          this.clearPolling();
          this.setPhase('idle');
          this.dialog.error(
            'Verification Session Expired',
            'Your verification session expired. Please create the account again or sign in if you already verified your email.',
          );
        }
      }
    }, 3000);
  }

  private async finishSignup(): Promise<void> {
    if (this.isCompletingSignup) return;

    this.clearPolling();
    this.setPhase('finalizing');

    let completed = false;

    try {
      await this.authService.completeSignup(
        this.pendingFirstName,
        this.pendingLastName,
        this.pendingEmail
      );

      completed = true;
      this.rateLimiter.reset();
      this.clearPendingSignup();
      this.setPhase('idle');

      this.dialog.success(
        'Account Created!',
        'Your account is pending admin approval. You will be able to sign in once it has been reviewed.',
        () => this.router.navigate(['/login']),
      );

    } catch (err: any) {
      if (err?.code === 'auth/email-not-verified') {
        this.setPhase('awaitingVerification');
        this.startPolling();
      } else if (err?.code === 'auth/no-current-user') {
        this.setPhase('idle');
      } else {
        this.setPhase('awaitingVerification');
      }

      this.dialog.error('Sign Up Failed', this.resolveFinishSignupError(err));
    } finally {
      if (!completed && this.phase === 'finalizing') {
        this.setPhase('awaitingVerification');
      }
    }
  }

  private setPhase(phase: SignupPhase): void {
    this.phase = phase;
    this.cdr.detectChanges();
  }

  private clearPendingSignup(): void {
    this.pendingFirstName = '';
    this.pendingLastName = '';
    this.pendingEmail = '';
    this.verificationEmailSent = false;
  }

  private clearPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private clearResendTimer(): void {
    if (this.resendTimer) {
      clearInterval(this.resendTimer);
      this.resendTimer = null;
    }
  }

  private startResendCooldown(seconds: number): void {
    this.clearResendTimer();
    this.resendCooldown = seconds;
    this.resendTimer = setInterval(() => {
      this.resendCooldown--;
      this.cdr.detectChanges();
      if (this.resendCooldown <= 0) {
        this.clearResendTimer();
      }
    }, 1000);
  }

  private resolveSignupError(err: any): string {
    switch (err?.code) {
      case 'auth/email-already-in-use': return 'This email address is already registered.';
      case 'auth/invalid-email': return 'The email address entered is not valid.';
      case 'auth/operation-not-allowed': return 'Email/password sign-up is not enabled for this project.';
      case 'auth/too-many-requests': return 'Too many sign-up attempts. Please wait a moment and try again.';
      case 'auth/network-request-failed': return 'Network error. Please check your connection and try again.';
      case 'auth/weak-password': return 'The password provided is too weak.';
      default: return 'Sign up failed. Please try again.';
    }
  }

  private resolveVerificationEmailError(err: any): string {
    switch (err?.code) {
      case 'auth/no-current-user': return 'Your verification session expired. Please create the account again or sign in if you already verified your email.';
      case 'auth/email-already-verified': return 'Your email is already verified. Finalizing your account now.';
      case 'auth/too-many-requests': return 'Too many verification emails were requested. Please wait before trying again.';
      case 'auth/network-request-failed': return 'Network error. Please check your connection and try again.';
      case 'auth/unauthorized-domain': return 'This app domain is not authorized in Firebase Authentication settings.';
      default: return 'We could not send a verification email. Please try again.';
    }
  }


  private resolveFinishSignupError(err: any): string {
    switch (err?.code) {
      case 'auth/email-not-verified': return 'Your email is not verified yet. Please click the verification link first.';
      case 'auth/no-current-user': return 'Your verification session expired. Please create the account again or sign in if you already verified your email.';
      case 'PERMISSION_DENIED': return 'Your email was verified, but the app could not save your account due to database permissions.';
      default: return 'Your email was verified, but we could not save your account. Please contact support.';
    }
  }
}