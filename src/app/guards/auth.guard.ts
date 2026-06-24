import { inject, Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { Auth, authState } from '@angular/fire/auth';
import { firstValueFrom } from 'rxjs';
import { AuthStateService } from '../services/auth-state.service';

@Injectable({ providedIn: 'root' })
export class AuthGuard implements CanActivate {
  private auth = inject(Auth);
  private router = inject(Router);
  private authState = inject(AuthStateService);

  async canActivate(): Promise<boolean> {
    const firebaseUser = await firstValueFrom(authState(this.auth));
    if (!firebaseUser) {
      void this.router.navigate(['/login']);
      return false;
    }
    if (firebaseUser.emailVerified) return true;
    const user = await this.authState.getCurrentUserOnce();
    if (user?.role === 'admin') return true;
    void this.router.navigate(['/login']);
    return false;
  }
}