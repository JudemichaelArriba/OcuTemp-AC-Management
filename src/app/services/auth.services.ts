import { Injectable, NgZone } from '@angular/core';
import { UserService } from './user';
import { Auth, signInWithEmailAndPassword, setPersistence, browserSessionPersistence } from '@angular/fire/auth';

@Injectable({
  providedIn: 'root'
})
export class AuthService {

  constructor(
    private auth: Auth,
    private userService: UserService,
    private zone: NgZone
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
      
      return existingUser ? '/app/dashboard' : '/add-credentials';

    } catch (err: any) {
      throw err; 
    }
  }
}
