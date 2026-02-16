import { Injectable, NgZone } from '@angular/core';
import { UserService } from './user';

import { Auth, signInWithEmailAndPassword } from '@angular/fire/auth';


@Injectable({
  providedIn: 'root'
})
export class AuthService {

  constructor(
    private auth: Auth,
    private userService: UserService,
    private zone: NgZone
  ) {}

  async login(email: string, password: string): Promise<string> {
    return new Promise((resolve, reject) => {
      
      this.zone.runOutsideAngular(async () => {
        try {
          const credential = await signInWithEmailAndPassword(this.auth, email, password);
          const uid = credential.user.uid;
          const existingUser = await this.userService.getUser(uid);

        
          this.zone.run(() => {
            resolve(existingUser ? '/app/dashboard' : '/add-credentials');
          });
        } catch (err: any) {
          this.zone.run(() => reject(err));
        }
      });
    });
  }
}
