import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { Room } from '../../models/room.model';

@Component({
  selector: 'app-room-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './room-card.html',
  styleUrl: './room-card.css',
  host: { class: 'block' },
})
export class RoomCard {
  @Input({ required: true }) room!: Room;

  get hasTelemetry(): boolean {
    return this.room.temperature !== undefined || this.room.humidity !== undefined;
  }

  get scheduleCount(): number {
    return this.room.schedules?.length ?? 0;
  }

  get statusBadgeClass(): string {
    return this.room.status === 'active'
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-slate-100 text-slate-600';
  }

  get temperatureText(): string {
    if (this.room.temperature === undefined) return '--';
    return `${this.room.temperature.toFixed(1)}°C`;
  }

  get humidityText(): string {
    if (this.room.humidity === undefined) return '--';
    return `${this.room.humidity.toFixed(1)}%`;
  }
}
