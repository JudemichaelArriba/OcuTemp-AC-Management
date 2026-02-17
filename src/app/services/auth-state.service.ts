import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { User } from '../models/user.model';
import { Auth } from '@angular/fire/auth';
import { UserService } from './user';
import { onAuthStateChanged } from 'firebase/auth';

@Injectable({ providedIn: 'root' })
export class AuthStateService {
  private _currentUser = new BehaviorSubject<User | null>(null);
  currentUser$ = this._currentUser.asObservable();

  constructor(
    private auth: Auth,
    private userService: UserService,
    private zone: NgZone
  ) {

    onAuthStateChanged(this.auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const user = await this.userService.getUser(firebaseUser.uid);
          this.zone.run(() => {
            this._currentUser.next(user ?? null);
          });
        } catch (err) {
          console.error('Failed to fetch user', err);
          this.zone.run(() => {
            this._currentUser.next(null);
          });
        }
      } else {
        this.zone.run(() => {
          this._currentUser.next(null);
        });
      }
    });
  }

  setUser(user: User) {
    this._currentUser.next(user);
  }
}
