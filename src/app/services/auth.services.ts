import { Injectable, NgZone } from '@angular/core';
import { UserService } from './user';
import { Auth, signInWithEmailAndPassword, setPersistence, browserSessionPersistence } from '@angular/fire/auth';
import { AuthStateService } from './auth-state.service';
@Injectable({
  providedIn: 'root'
})
export class AuthService {

  constructor(
    private auth: Auth,
    private userService: UserService,
    private zone: NgZone,
        private authState: AuthStateService 
  ) {}

  /**
   * Logs in a user and returns the route to redirect to.
   * Uses browserSessionPersistence so login clears when the tab/browser closes.
   */
  async login(email: string, password: string): Promise<string> {
    try {
 
      await setPersistence(this.auth, browserSessionPersistence);

      const credential = await signInWithEmailAndPassword(this.auth, email, password);
      const uid = credential.user.uid;
      const existingUser = await this.userService.getUser(uid);
        if (existingUser) this.authState.setUser(existingUser);
      return existingUser ? '/app/dashboard' : '/add-credentials';

    } catch (err: any) {
      throw err; 
    }
  }
}
