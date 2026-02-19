import { Component, inject, ViewEncapsulation, signal, HostListener } from '@angular/core';
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


  isOpen = signal(typeof window !== 'undefined' ? window.innerWidth >= 768 : true);

  @HostListener('window:resize', ['$event'])
  onResize(event: Event) {
    const width = (event.target as Window).innerWidth;
    if (width >= 768) {
      this.isOpen.set(true);
    } else {
      this.isOpen.set(false);
    }
  }

  toggleSidebar() {
    this.isOpen.update(v => !v);
  }

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