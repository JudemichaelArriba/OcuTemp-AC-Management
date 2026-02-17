import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { User } from '../../models/user.model';

@Component({
  selector: 'app-user-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './user-card.html',
      host: { style: 'display: contents' }
})
export class UserCardComponent {
  @Input() user!: User;

  getInitials(name?: string): string {
    if (!name) return '??';
    return name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  }

  getAvatarGradient(name?: string): string {
    const gradients = [
      'from-blue-500 to-blue-600 shadow-blue-500/30',
      'from-emerald-500 to-emerald-600 shadow-emerald-500/30',
      'from-purple-500 to-purple-600 shadow-purple-500/30',
      'from-rose-500 to-rose-600 shadow-rose-500/30',
      'from-amber-500 to-amber-600 shadow-amber-500/30',
      'from-cyan-500 to-cyan-600 shadow-cyan-500/30',
    ];
    if (!name) return gradients[0];
    const index = name.charCodeAt(0) % gradients.length;
    return gradients[index];
  }

  getRoleBadgeClass(role?: string): string {
    return role === 'admin'
      ? 'bg-purple-100 text-purple-700'
      : 'bg-blue-100 text-blue-700';
  }

  formatLastLogin(lastLoginAt?: string): { text: string; isRecent: boolean } {
    if (!lastLoginAt) return { text: 'Never', isRecent: false };
    const date = new Date(lastLoginAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 5) return { text: 'Just now', isRecent: true };
    if (diffMins < 60) return { text: `${diffMins} mins ago`, isRecent: true };
    if (diffHours < 24) return { text: `${diffHours} hours ago`, isRecent: false };
    return { text: `${diffDays} day${diffDays > 1 ? 's' : ''} ago`, isRecent: false };
  }
}