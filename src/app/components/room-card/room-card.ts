import { CommonModule } from '@angular/common';
import { Component, Input, Output, EventEmitter, signal, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { Room } from '../../models/room.model';
import { Router } from '@angular/router';
import { Device } from '../../models/esp.model';
import { DeviceService, DeviceOnlineState, getDeviceOnlineState } from '../../services/device.service';
import { AuthStateService } from '../../services/auth-state.service';
import { DialogService } from '../../services/dialog.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-room-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './room-card.html',
  styleUrl: './room-card.css',
  host: { class: 'block' },
})
export class RoomCard implements OnInit, OnDestroy {
  @Input({ required: true }) room!: Room;
  @Input() allowDelete: boolean = false;

  @Output() deleteRequest = new EventEmitter<Room>();

  isDropdownOpen = signal(false);
  isForcingOff = signal(false);
  isSavingAiAutoApply = signal(false);
  canToggleAiAutoApply = signal(false);

  private _device: Device | null = null;
  private unsubscribeDevice?: () => void;
  private authSubscription?: Subscription;
  private statusInterval?: ReturnType<typeof setInterval>;
  private destroyed = false;

  constructor(
    private router: Router,
    private deviceService: DeviceService,
    private authState: AuthStateService,
    private dialogService: DialogService,
    private cdr: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    this.authSubscription = this.authState.currentUser$.subscribe((user) => {
      this.canToggleAiAutoApply.set(
        user?.approved === true && (user?.role === 'admin' || user?.role === 'staff')
      );
      this.cdr.markForCheck();
    });

    if (!this.room.device) return;

    this.unsubscribeDevice = this.deviceService.streamDevice(this.room.device, (device) => {
      if (this.destroyed) return;
      this._device = device;
      this.cdr.markForCheck();
    });

    this.statusInterval = setInterval(() => {
      if (!this.destroyed) this.cdr.markForCheck();
    }, 60_000);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.unsubscribeDevice?.();
    this.authSubscription?.unsubscribe();
    clearInterval(this.statusInterval);
  }

  get deviceOnlineState(): DeviceOnlineState {
    if (!this.room.device) return 'unknown';
    return getDeviceOnlineState(this._device?.status?.lastSeen);
  }

  get deviceOnlineStateDotClass(): string {
    switch (this.deviceOnlineState) {
      case 'online': return 'bg-emerald-400';
      case 'stale': return 'bg-amber-400 animate-pulse';
      case 'offline': return 'bg-red-400';
      default: return 'bg-slate-300';
    }
  }

  get deviceOnlineStateLabelClass(): string {
    switch (this.deviceOnlineState) {
      case 'online': return 'text-emerald-600';
      case 'stale': return 'text-amber-600';
      case 'offline': return 'text-red-500';
      default: return 'text-slate-400';
    }
  }

  get isDeviceOffline(): boolean {
    return this.room.device != null && this.deviceOnlineState === 'offline';
  }

  get aiAutoApplyEnabled(): boolean {
    return this._device?.control?.aiAutoApply === true;
  }

  get aiAutoApplyToggleDisabled(): boolean {
    return (
      !this.room.device ||
      this._device === null ||
      !this.canToggleAiAutoApply() ||
      this.isSavingAiAutoApply()
    );
  }

  get aiAutoApplyStatusText(): string {
    if (!this.room.device) return 'No device';
    if (this._device === null) return 'Syncing';
    return this.aiAutoApplyEnabled ? 'AI On' : 'AI Off';
  }

  get aiAutoApplyAriaLabel(): string {
    return `${this.aiAutoApplyEnabled ? 'Disable' : 'Enable'} AI auto apply for ${this.room.roomName}`;
  }

  toggleDropdown() { this.isDropdownOpen.update((v) => !v); }
  closeDropdown() { this.isDropdownOpen.set(false); }

  viewDetails() {
    this.closeDropdown();
    this.router.navigate(['app/room-details', this.room.uid]);
  }

  async forcePowerOff() {
    if (!this.room.device || this.room.power === false || this.isForcingOff()) return;
    this.closeDropdown();
    this.isForcingOff.set(true);
    try {
      await this.deviceService.sendForcedOff(this.room.device);
    } catch (err) {
    } finally {
      this.isForcingOff.set(false);
    }
  }

  async toggleAiAutoApply(event: Event): Promise<void> {
    event.stopPropagation();
    if (this.aiAutoApplyToggleDisabled || !this.room.device) return;

    this.isSavingAiAutoApply.set(true);
    try {
      await this.deviceService.setAiAutoApplyEnabled(this.room.device, !this.aiAutoApplyEnabled);
    } catch (err) {
      this.dialogService.error('AI Toggle Failed', 'Unable to update AI auto-apply. Please try again.');
    } finally {
      this.isSavingAiAutoApply.set(false);
      this.cdr.markForCheck();
    }
  }

  requestDelete() {
    this.closeDropdown();
    this.deleteRequest.emit(this.room);
  }

  get isRoomOff(): boolean { return this.room.power !== true; }

  get hasTelemetry(): boolean {
    return (
      this.room.temperature !== undefined ||
      this.room.humidity !== undefined ||
      this.room.occupancy !== undefined
    );
  }

  get scheduleCount(): number { return this.room.schedules?.length ?? 0; }

  get statusBadgeClass(): string {
    return this.room.power === true
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-slate-100 text-slate-600';
  }

  get statusText(): string { return this.room.power === true ? 'on' : 'off'; }

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
