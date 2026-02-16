import { Injectable } from '@angular/core';
import { Database, ref, get, set } from '@angular/fire/database';
import { User } from '../models/user.model';

@Injectable({
  providedIn: 'root'
})
export class UserService {

  constructor(private db: Database) {}

  async getUser(uid: string): Promise<User | null> {
    const userRef = ref(this.db, `users/${uid}`);
    const snapshot = await get(userRef);

    if (snapshot.exists()) {
      return snapshot.val() as User;
    }

    return null;
  }

  async createUser(user: User): Promise<void> {
    const userRef = ref(this.db, `users/${user.uid}`);
    await set(userRef, user);
  }
}
