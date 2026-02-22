import { Component, inject, ViewEncapsulation, signal, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { Auth, signOut } from '@angular/fire/auth';
import { AuthStateService } from '../../services/auth-state.service';
import { DialogService } from '../../services/dialog.service';
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
  private dialogService = inject(DialogService);
  private auth = inject(Auth);
  private router = inject(Router);

  currentUser$ = this.authState.currentUser$;

  isOpen = signal(typeof window !== 'undefined' ? window.innerWidth >= 768 : true);

  @HostListener('window:resize', ['$event'])
  onResize(event: Event) {
    const width = (event.target as Window).innerWidth;
    this.isOpen.set(width >= 768);
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
    return parts.map(p => p.charAt(0).toUpperCase()).slice(0, 2).join('');
  }

    onLogoutClick(): void {
      this.dialogService.confirm(
        'Sign Out',
        'Are you sure you want to sign out of your account?',
        async () => {
          try {
            await signOut(this.auth);

    
            this.authState.clearUser;

            this.router.navigate(['/login']);

          } catch (error) {
            console.error('Logout failed:', error);
            this.dialogService.error(
              'Logout Failed',
              'Something went wrong while signing out.'
            );
          }
        },
        undefined,
        'Sign Out',
        'Cancel'
      );
    }

}