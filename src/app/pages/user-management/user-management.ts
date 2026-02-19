import { 
  Component, 
  OnInit, 
  ChangeDetectionStrategy, 
  ChangeDetectorRef 
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UserService } from '../../services/user';
import { User } from '../../models/user.model';
import { UserCardComponent } from '../../components/user-card/user-card';

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, FormsModule, UserCardComponent],
  templateUrl: './user-management.html',
  styleUrls: ['./user-management.css'],
  changeDetection: ChangeDetectionStrategy.OnPush 
})
export class UserManagement implements OnInit {

  users: User[] = [];
  filteredUsers: User[] = [];
  searchQuery = '';
  isLoading = true;
  isSuccess = false;
  skeletonRows = Array(4);

  private searchTimeout: any;

  constructor(
    private userService: UserService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    try {
      const data = await this.userService.getStaffUsers();

      this.users = data;
      this.filteredUsers = data;
      this.isSuccess = true;

    } catch (error) {
      console.error('Failed to load staff users:', error);
      this.isSuccess = false;
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }


  onSearch() {
    clearTimeout(this.searchTimeout);

    this.searchTimeout = setTimeout(() => {
      const query = this.searchQuery.trim().toLowerCase();

      if (!query) {
        this.filteredUsers = this.users;
      } else {
        this.filteredUsers = this.users.filter(user =>
          user.fullName?.toLowerCase().includes(query) ||
          user.email?.toLowerCase().includes(query) ||
          user.role?.toLowerCase().includes(query)
        );
      }

      this.cdr.markForCheck();
    }, 200); 
  }


  trackByUserId(index: number, user: User): string {
    return user.uid;
  }
}
