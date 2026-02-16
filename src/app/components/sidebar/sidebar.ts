import { Component, inject, ViewEncapsulation, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AuthStateService } from '../../services/auth-state.service';
import { User } from '../../models/user.model';

@Component({
  selector: 'app-sidebar',
  templateUrl: './sidebar.html',
  standalone: true,
  imports: [CommonModule, RouterModule],
  encapsulation: ViewEncapsulation.None
})
export class SidebarComponent implements OnInit {
  private authState = inject(AuthStateService);
  currentUser: User | null = null;

  ngOnInit() {
    this.authState.currentUser$.subscribe(user => {
      this.currentUser = user;
    });
  }

  isAdmin(): boolean {
    return this.currentUser?.role === 'admin';
  }

  getUserInitials(): string {
    if (!this.currentUser?.fullName) return '';
    // Split name by space, take first letters
    const parts = this.currentUser.fullName.trim().split(' ');
    const initials = parts.map(part => part.charAt(0).toUpperCase());
    // Take first two letters (e.g., Jude Michael -> JM)
    return initials.slice(0, 2).join('');
  }
}
