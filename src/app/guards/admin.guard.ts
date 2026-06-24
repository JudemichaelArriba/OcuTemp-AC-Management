import { inject, Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { Auth, authState } from '@angular/fire/auth';
import { firstValueFrom } from 'rxjs';
import { AuthStateService } from '../services/auth-state.service';

@Injectable({ providedIn: 'root' })
export class AdminGuard implements CanActivate {
  private auth = inject(Auth);
  private router = inject(Router);
  private authState = inject(AuthStateService);

  async canActivate(): Promise<boolean> {
    const firebaseUser = await firstValueFrom(authState(this.auth));
    if (!firebaseUser) {
      void this.router.navigate(['/login']);
      return false;
    }
    const user = await this.authState.getCurrentUserOnce();
    if (user?.role === 'admin' && user?.approved === true) return true;
    if (!firebaseUser.emailVerified) {
      void this.router.navigate(['/login']);
      return false;
    }
    void this.router.navigate(['/app/dashboard']);
    return false;
  }
}