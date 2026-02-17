import { Component, OnInit, NgZone, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UserService } from '../../services/user';
import { User } from '../../models/user.model';
import { UserCardComponent } from '../../components/user-card/user-card';

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, UserCardComponent],
  templateUrl: './user-management.html',
  styleUrls: ['./user-management.css'],
})
export class UserManagement implements OnInit {
  users: User[] = [];
  isLoading = true;
  isSuccess = false;
  skeletonRows = Array(4);

  constructor(private userService: UserService, private cdr: ChangeDetectorRef) {}

  async ngOnInit() {
    try {
      const data = await this.userService.getStaffUsers();
      console.log('Users fetched:', data);
      this.users = data;
      this.isSuccess = true;
    } catch (error) {
      console.error('Failed to load staff users:', error);
      this.isSuccess = false;
    } finally {
      this.isLoading = false;
      this.cdr.detectChanges(); 
    }
  }
}