import { Component, inject, ViewEncapsulation, signal, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { Auth, signOut } from '@angular/fire/auth';
import { AuthStateService } from '../../services/auth-state.service';
import { DialogService } from '../../services/dialog.service';
import { User } from '../../models/user.model';
import { LoggerService } from '../../services/logger.service';
import { HelpChatModal } from '../help-chat-modal/help-chat-modal';

@Component({
  selector: 'app-sidebar',
  templateUrl: './sidebar.html',
  standalone: true,
  imports: [CommonModule, RouterModule, HelpChatModal],
  encapsulation: ViewEncapsulation.None
})
export class SidebarComponent {
  private authState = inject(AuthStateService);
  private dialogService = inject(DialogService);
  private auth = inject(Auth);
  private router = inject(Router);

  constructor(
    private logger: LoggerService
  ) { }

  currentUser$ = this.authState.currentUser$;
  isMobile = signal(typeof window !== 'undefined' ? window.innerWidth < 768 : false);
  isOpen = signal(typeof window !== 'undefined' ? window.innerWidth >= 768 : true);
  helpChatVisible = signal(false);


  @HostListener('window:resize', ['$event'])
  onResize(event: Event) {
    const width = (event.target as Window).innerWidth;
    this.isMobile.set(width < 768);
    if (width >= 768) {
      this.isOpen.set(true);
    } else {
      this.isOpen.set(false);
    }
  }

  toggleSidebar() {
    this.isOpen.update(v => !v);
  }

  openHelpChat(): void {
    this.helpChatVisible.set(true);
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


          this.authState.clearUser();

          this.router.navigate(['/login']);

        } catch (error) {
          this.logger.error('Logout failed:', error);
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
