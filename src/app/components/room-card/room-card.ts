import { CommonModule } from '@angular/common';
import { Component, Input, signal } from '@angular/core';
import { Room } from '../../models/room.model';
import { Router } from '@angular/router';


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


  constructor(private router: Router) { }

  isDropdownOpen = signal(false);
  toggleDropdown() {
    this.isDropdownOpen.update(v => !v);
  }

  closeDropdown() {
    this.isDropdownOpen.set(false);
  }



  viewDetails() {
    this.closeDropdown();
    this.router.navigate(['app/room-details', this.room.uid]);
  }

  get hasTelemetry(): boolean {
    return (
      this.room.temperature !== undefined ||
      this.room.humidity !== undefined ||
      this.room.occupancy !== undefined
    );
  }

  get scheduleCount(): number {
    return this.room.schedules?.length ?? 0;
  }

  get statusBadgeClass(): string {
    return this.room.power === true
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-slate-100 text-slate-600';
  }

  get statusText(): string {
    return this.room.power === true ? 'on' : 'off';
  }

  get temperatureText(): string {
    if (this.room.temperature === undefined) return '--';
    return `${this.room.temperature.toFixed(1)}°C`;
  }

  get humidityText(): string {
    if (this.room.humidity === undefined) return '--';
    return `${this.room.humidity.toFixed(1)}%`;
  }

  get occupancyText(): string {

    if (this.room.occupancy === undefined) return '--';
    return this.room.occupancy ? 'Occupied' : 'Unoccupied';
  }
}
