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
import { Database, ref, set, serverTimestamp } from '@angular/fire/database';





@Injectable({
  providedIn: 'root'
})
export class AuthService {

  constructor(
    private auth: Auth,
    private db: Database,
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

    if (existingUser && existingUser.approved === false) {
      await this.auth.signOut(); 
      throw new Error('not-approved');
    }

        if (existingUser) this.authState.setUser(existingUser);
      return existingUser ? '/app/dashboard' : '/add-credentials';

    } catch (err: any) {
      throw err; 
    }
  }



  
  /**
   * Registers a new staff account.
   * Sets approved: false by default — admin must approve before the user can log in.
   * Saves the user record to Realtime Database.
   */
  async signup(
    firstName: string,
    lastName: string,
    email: string,
    password: string
  ): Promise<void> {
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
  }



        /**
       * Logs out the current user
       * Clears AuthState and Firebase session
       */
        async logout(): Promise<void> {
          try {
            await this.auth.signOut();

            // Clear local auth state
            this.authState.clearUser?.(); // if you have this method
            // or this.authState.setUser(null);

          } catch (error) {
            console.error('Logout failed:', error);
            throw error;
          }
        }
}
