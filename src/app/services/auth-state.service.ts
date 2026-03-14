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
  private userFetch: Promise<User | null> | null = null;
  private authUserId: string | null = null;

  constructor(
    private auth: Auth,
    private userService: UserService,
    private zone: NgZone
  ) {

    onAuthStateChanged(this.auth, async (firebaseUser) => {
      if (firebaseUser) {
        this.authUserId = firebaseUser.uid;
        this.userFetch = this.fetchAndCache(firebaseUser.uid);
        await this.userFetch;
      } else {
        this.authUserId = null;
        this.userFetch = null;
        this.zone.run(() => {
          this._currentUser.next(null);
        });
      }
    });
  }
  
  clearUser(): void {
    this.authUserId = null;
    this.userFetch = null;
    this.setUser(null as any);
  }
  setUser(user: User) {
    this._currentUser.next(user);
  }

  async getCurrentUserOnce(): Promise<User | null> {
    const authUser = this.auth.currentUser;
    if (!authUser) return null;
    if (this.authUserId !== authUser.uid || !this.userFetch) {
      this.authUserId = authUser.uid;
      this.userFetch = this.fetchAndCache(authUser.uid);
    }
    return this.userFetch;
  }

  private async fetchAndCache(uid: string): Promise<User | null> {
    try {
      const user = await this.userService.getUser(uid);
      this.zone.run(() => {
        this._currentUser.next(user ?? null);
      });
      return user ?? null;
    } catch (err) {
      console.error('Failed to fetch user', err);
      this.zone.run(() => {
        this._currentUser.next(null);
      });
      return null;
    }
  }
}
