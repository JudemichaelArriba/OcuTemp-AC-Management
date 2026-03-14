import { inject, Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { Auth, onAuthStateChanged } from '@angular/fire/auth';
import { AuthStateService } from '../services/auth-state.service';

@Injectable({
  providedIn: 'root',
})
export class AdminGuard implements CanActivate {
  private auth = inject(Auth);
  private router = inject(Router);
  private authState = inject(AuthStateService);

  canActivate(): Promise<boolean> {
    return new Promise((resolve) => {
      onAuthStateChanged(this.auth, async (firebaseUser) => {
        if (!firebaseUser) {
          this.router.navigate(['/login']);
          return resolve(false);
        }

        const user = await this.authState.getCurrentUserOnce();
        if (user?.role === 'admin' && user?.approved === true) {
          resolve(true);
        } else {
          this.router.navigate(['/app/dashboard']);
          resolve(false);
        }
      });
    });
  }
}
