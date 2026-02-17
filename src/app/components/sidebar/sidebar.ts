import { Component, inject, ViewEncapsulation } from '@angular/core';
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
export class SidebarComponent {
  private authState = inject(AuthStateService);


  currentUser$ = this.authState.currentUser$;

  isAdmin(user?: User): boolean {
    return user?.role === 'admin';
  }

  getUserInitials(user?: User): string {
    if (!user?.fullName) return '';
    const parts = user.fullName.trim().split(' ');
    const initials = parts.map(part => part.charAt(0).toUpperCase());
    return initials.slice(0, 2).join('');
  }
}
