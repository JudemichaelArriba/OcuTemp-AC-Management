import { inject, Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { Auth, onAuthStateChanged } from '@angular/fire/auth';
import { UserService } from '../services/user';

@Injectable({
  providedIn: 'root',
})
export class ApprovedGuard implements CanActivate {
  private auth = inject(Auth);
  private router = inject(Router);
  private userService = inject(UserService);

  canActivate(): Promise<boolean> {
    return new Promise((resolve) => {
      onAuthStateChanged(this.auth, async (firebaseUser) => {
        if (!firebaseUser) {
          this.router.navigate(['/login']);
          return resolve(false);
        }

        try {
          const user = await this.userService.getUser(firebaseUser.uid);
          if (user?.approved === true) {
            resolve(true);
          } else {
            this.router.navigate(['/add-credentials']);
            resolve(false);
          }
        } catch {
          this.router.navigate(['/login']);
          resolve(false);
        }
      });
    });
  }
}
