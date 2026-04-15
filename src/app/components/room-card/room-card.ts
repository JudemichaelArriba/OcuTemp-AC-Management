import { CommonModule } from '@angular/common';
import { Component, Input, signal } from '@angular/core';
import { Room } from '../../models/room.model';
import { Router } from '@angular/router';
import { DeviceService } from '../../services/device.service';

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

  isDropdownOpen = signal(false);
  isForcingOff = signal(false);

  constructor(
    private router: Router,
    private deviceService: DeviceService,
  ) {}

  toggleDropdown() {
    this.isDropdownOpen.update((v) => !v);
  }

  closeDropdown() {
    this.isDropdownOpen.set(false);
  }

  viewDetails() {
    this.closeDropdown();
    this.router.navigate(['app/room-details', this.room.uid]);
  }

  async forcePowerOff() {
    // Guard: no device linked, already off, or request in flight
    if (!this.room.device || this.room.power === false || this.isForcingOff()) return;

    this.closeDropdown();
    this.isForcingOff.set(true);

    try {
      await this.deviceService.sendForcedOff(this.room.device);
    } catch (err) {
      console.error('[RoomCard] sendForcedOff failed:', err);
    } finally {
      this.isForcingOff.set(false);
    }
  }

  // ── Derived display helpers ──────────────────────────────────────────────

  get isRoomOff(): boolean {
    return this.room.power !== true;
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