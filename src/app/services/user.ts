import { Injectable } from '@angular/core';
import { Database, ref, get, set, update, query, orderByChild, equalTo } from '@angular/fire/database';
import { User } from '../models/user.model';
import { LoggerService } from './logger.service';

@Injectable({
  providedIn: 'root'
})
export class UserService {

  constructor(private db: Database, private logger: LoggerService) { }

  async getUser(uid: string): Promise<User | null> {
    try {
      const userRef = ref(this.db, `users/${uid}`);
      const snapshot = await get(userRef);
      if (snapshot.exists()) return snapshot.val() as User;
      return null;
    } catch (err) {
      this.logger.error('Failed to fetch user record', err, {
        service: 'UserService',
        action: 'getUser',
        uid,
      });
      throw err;
    }
  }

  async createUser(user: User): Promise<void> {
    try {
      const userRef = ref(this.db, `users/${user.uid}`);
      await set(userRef, user);
    } catch (err) {
      this.logger.error('Failed to create user record', err, {
        service: 'UserService',
        action: 'createUser',
        uid: user.uid,
      });
      throw err;
    }
  }

  async getStaffUsers(): Promise<User[]> {
    try {
      const usersRef = ref(this.db, 'users');
      const staffQuery = query(usersRef, orderByChild('role'), equalTo('staff'));
      const snapshot = await get(staffQuery);

      if (!snapshot.exists()) return [];

      const users: User[] = [];
      snapshot.forEach((child) => {
        users.push({ uid: child.key!, ...child.val() });
      });
      return users;
    } catch (err) {
      this.logger.error('Failed to fetch staff users', err, {
        service: 'UserService',
        action: 'getStaffUsers',
      });
      throw err;
    }
  }

  /**
   * Sets approved: true (approve)
   * or approved: false (restrict) for a user.
   */
  async setApproval(uid: string, approved: boolean): Promise<void> {
    try {
      const userRef = ref(this.db, `users/${uid}`);
      await update(userRef, { approved });
    } catch (err) {
      this.logger.error('Failed to update user approval', err, {
        service: 'UserService',
        action: 'setApproval',
        uid,
        approved,
      });
      throw err;
    }
  }

  /**
   *Updates the fullName field of a user.
   */
  async updateUserFullName(uid: string, fullName: string): Promise<void> {
    try {
      const userRef = ref(this.db, `users/${uid}`);
      await update(userRef, { fullName: fullName });
    } catch (err) {
      this.logger.error('Failed to update user full name', err, {
        service: 'UserService',
        action: 'updateUserFullName',
        uid,
      });
      throw err;
    }
  }
}
