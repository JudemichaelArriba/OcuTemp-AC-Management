import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthStateService } from '../../services/auth-state.service';
import { User } from '../../models/user.model';
import { Observable } from 'rxjs';


@Component({
  selector: 'app-settings-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
})

export class SettingsPage {
  currentUser$: Observable<User | null>;


  constructor(private auhtState: AuthStateService) {
    this.currentUser$ = this.auhtState.currentUser$;
  }

  getUserInitials(user?: User | null): string {
    if (!user?.fullName) return 'U';
    const parts = user.fullName.trim().split(' ');
    return parts.map(p => p.charAt(0).toUpperCase()).slice(0, 2).join('');
  }
}
