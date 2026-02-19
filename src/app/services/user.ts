import { Injectable } from '@angular/core';
import { Database, ref, get, set, update, query, orderByChild, equalTo } from '@angular/fire/database';
import { User } from '../models/user.model';

@Injectable({
  providedIn: 'root'
})
export class UserService {

  constructor(private db: Database) {}

  async getUser(uid: string): Promise<User | null> {
    const userRef = ref(this.db, `users/${uid}`);
    const snapshot = await get(userRef);
    if (snapshot.exists()) return snapshot.val() as User;
    return null;
  }

  async createUser(user: User): Promise<void> {
    const userRef = ref(this.db, `users/${user.uid}`);
    await set(userRef, user);
  }

  async getStaffUsers(): Promise<User[]> {
    const usersRef = ref(this.db, 'users');
    const staffQuery = query(usersRef, orderByChild('role'), equalTo('staff'));
    const snapshot = await get(staffQuery);

    if (!snapshot.exists()) return [];

    const users: User[] = [];
    snapshot.forEach((child) => {
      users.push({ uid: child.key!, ...child.val() });
    });
    return users;
  }

   /**
   * Sets approved: true (approve)
   * or approved: false (restrict) for a user.
   */
  async setApproval(uid: string, approved: boolean): Promise<void> {
    const userRef = ref(this.db, `users/${uid}`);
    await update(userRef, { approved });
  }
}