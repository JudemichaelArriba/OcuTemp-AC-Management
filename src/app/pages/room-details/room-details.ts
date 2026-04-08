import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { RoomService } from '../../services/room.service';
import { DeviceService, DeviceTelemetry } from '../../services/device.service';
import { Room } from '../../models/room.model';
import { RoomEditModal } from '../../components/room-edit-modal/room-edit-modal';
import { DialogService } from '../../services/dialog.service';
import { AuthStateService } from '../../services/auth-state.service';
import { LoggerService } from '../../services/logger.service';

@Component({
  selector: 'app-room-details',
  standalone: true,
  imports: [CommonModule, FormsModule, RoomEditModal],
  templateUrl: './room-details.html',
  styleUrl: './room-details.css',
})
export class RoomDetails implements OnInit, OnDestroy {
  room: Room | null = null;
  deviceData: DeviceTelemetry | null = null;
  loading = true;
  error: string | null = null;
  isEditModalOpen = false;

  private unsubscribeRooms?: () => void;
  private unsubscribeDevices?: () => void;
  private loadingTimeoutId?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private currentDeviceId: string | null = null;


  canManualOverride = false;
  overrideTemp = 24;
  overrideDurationMinutes = 60;
  isSavingOverride = false;
  private overrideInitialized = false;
  private currentUserId: string | null = null;


  readonly overrideMinTemp = 16;
  readonly overrideMaxTemp = 30;
  readonly overrideMinMinutes = 15;
  readonly overrideMaxMinutes = 480;


  readonly durationPresets = [
    { label: '30 min', value: 30 },
    { label: '1 hour', value: 60 },
    { label: '2 hours', value: 120 },
    { label: '4 hours', value: 240 },
  ];


  private readonly ARC_CX = 110;
  private readonly ARC_CY = 112;
  private readonly ARC_R = 88;
  private readonly ARC_VW = 220;   
  private readonly ARC_VH = 128;   
  readonly arcLength = Math.PI * 88; 

  isDraggingTemp = false;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private roomService: RoomService,
    private deviceService: DeviceService,
    private cdr: ChangeDetectorRef,
    private dialogService: DialogService,
    private authState: AuthStateService,
    private logger: LoggerService
  ) { }

  ngOnInit() {
    const uid = this.route.snapshot.paramMap.get('uid');
    if (!uid) {
      this.error = 'Room ID not found';
      this.loading = false;
      this.refreshView();
      return;
    }

    this.loadCurrentUser();

    this.loadingTimeoutId = setTimeout(() => {
      if (this.loading) {
        this.error = 'Loading timed out. Please refresh and try again.';
        this.loading = false;
        this.refreshView();
      }
    }, 12000);

    this.unsubscribeRooms = this.roomService.streamRoomById(uid, (foundRoom) => {
      if (foundRoom) {
        this.error = null;
        this.room = foundRoom;
        this.loading = false;
        this.clearLoadingTimeout();
        this.refreshView();

        const nextDeviceId = foundRoom.device || null;
        if (nextDeviceId !== this.currentDeviceId) {
          this.currentDeviceId = nextDeviceId;
          this.deviceData = null;
          this.overrideInitialized = false;
          this.overrideTemp = 24;
          this.overrideDurationMinutes = 60;
          this.unsubscribeDevices?.();
          this.unsubscribeDevices = undefined;
          if (nextDeviceId) this.streamDeviceData(nextDeviceId);
        } else if (nextDeviceId && !this.unsubscribeDevices) {
          this.streamDeviceData(nextDeviceId);
        }
      } else {
        this.error = 'Room not found';
        this.loading = false;
        this.clearLoadingTimeout();
        this.refreshView();
      }
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.unsubscribeRooms?.();
    this.unsubscribeDevices?.();
    this.clearLoadingTimeout();
  }


  private async loadCurrentUser(): Promise<void> {
    try {
      const user = await this.authState.getCurrentUserOnce();
      this.currentUserId = user?.uid ?? null;
      this.canManualOverride =
        user?.approved === true && (user?.role === 'admin' || user?.role === 'staff');
      this.refreshView();
    } catch (err) {
      this.logger.error('Failed to load current user:', err);
    }
  }

  private streamDeviceData(deviceId: string) {
    this.unsubscribeDevices = this.deviceService.streamDevice(deviceId, (device) => {
      this.deviceData = device;


      if (!this.overrideInitialized) {
        const suggestedTemp = device?.control?.targetTemp ?? device?.acState?.currentTemp;
        if (typeof suggestedTemp === 'number') {
          this.overrideTemp = Math.max(
            this.overrideMinTemp,
            Math.min(this.overrideMaxTemp, suggestedTemp)
          );
        }
        this.overrideInitialized = true;
      }

      this.refreshView();
    });
  }

  private clearLoadingTimeout(): void {
    if (this.loadingTimeoutId) {
      clearTimeout(this.loadingTimeoutId);
      this.loadingTimeoutId = undefined;
    }
  }

  private refreshView(): void {
    if (!this.destroyed) this.cdr.detectChanges();
  }


  goBack() { this.router.navigate(['/app/room-management']); }
  editRoom() { if (!this.room || this.loading) return; this.isEditModalOpen = true; this.refreshView(); }
  onEditModalClosed(): void { this.isEditModalOpen = false; this.refreshView(); }
  onRoomUpdated(updated: Room): void { this.room = updated; this.isEditModalOpen = false; this.refreshView(); }

  get statusBadgeClass(): string {
    return this.room?.power === true
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-slate-100 text-slate-600';
  }

  get statusText(): string { return this.room?.power === true ? 'ON' : 'OFF'; }

  get acPowerText(): string {
    if (!this.deviceData?.acState?.power)
      return this.deviceData?.acState?.power === false ? 'OFF' : '--';
    return 'ON';
  }

  get overrideIsActive(): boolean {
    return this.deviceData?.control?.overrideActive === true;
  }

  private parseOverrideUntil(): Date | null {
    const value = this.deviceData?.control?.overrideUntil;
    if (!value) return null;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed);
  }

  get overrideIsExpired(): boolean {
    const until = this.parseOverrideUntil();
    if (!until) return false;
    return until.getTime() < Date.now();
  }

  get overrideStatusText(): string {
    if (!this.overrideIsActive) return 'INACTIVE';
    if (this.overrideIsExpired) return 'EXPIRED';
    return 'ACTIVE';
  }

  get overrideStatusBadgeClass(): string {
    if (this.overrideIsActive && !this.overrideIsExpired) return 'bg-emerald-100 text-emerald-700';
    if (this.overrideIsActive && this.overrideIsExpired) return 'bg-amber-100 text-amber-700';
    return 'bg-slate-100 text-slate-600';
  }

  get overrideUntilPreview(): string | null {
    const duration = Number(this.overrideDurationMinutes);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return new Date(Date.now() + duration * 60_000).toISOString();
  }


  private get tempRatio(): number {
    const range = this.overrideMaxTemp - this.overrideMinTemp || 1;
    return (this.overrideTemp - this.overrideMinTemp) / range;
  }


  get arcDashOffset(): number {
    return this.arcLength * (1 - this.tempRatio);
  }

  get thumbPos(): { x: number; y: number } {
   
    const angle = Math.PI * (1 - this.tempRatio);
    return {
      x: this.ARC_CX + this.ARC_R * Math.cos(angle),
      y: this.ARC_CY - this.ARC_R * Math.sin(angle),
    };
  }


  get tempTicks(): Array<{
    temp: number;
    x1: number; y1: number;
    x2: number; y2: number;
    isMajor: boolean;
    active: boolean;
  }> {
    const range = this.overrideMaxTemp - this.overrideMinTemp;
    const cx = this.ARC_CX;
    const cy = this.ARC_CY;
    const innerR = this.ARC_R + 6;   
    const minorEnd = this.ARC_R + 11;
    const majorEnd = this.ARC_R + 16;

    return Array.from({ length: range + 1 }, (_, i) => {
      const temp = this.overrideMinTemp + i;
      const t = i / range;
      const angle = Math.PI * (1 - t);
      const isMajor = temp % 5 === 0 || temp === this.overrideMinTemp || temp === this.overrideMaxTemp;
      const outerR = isMajor ? majorEnd : minorEnd;
      return {
        temp,
        x1: cx + innerR * Math.cos(angle),
        y1: cy - innerR * Math.sin(angle),
        x2: cx + outerR * Math.cos(angle),
        y2: cy - outerR * Math.sin(angle),
        isMajor,
        active: temp <= this.overrideTemp,
      };
    });
  }


  onTempPointerDown(event: PointerEvent): void {
    const svg = event.currentTarget as SVGSVGElement;

    svg.setPointerCapture(event.pointerId);
    this.isDraggingTemp = true;
    this.applyTempFromPointer(event, svg);
    event.preventDefault();
  }

  onTempPointerMove(event: PointerEvent): void {
    if (!this.isDraggingTemp) return;
    const svg = event.currentTarget as SVGSVGElement;
    this.applyTempFromPointer(event, svg);
    event.preventDefault();
  }

  onTempPointerUp(): void {
    this.isDraggingTemp = false;
  }


  private applyTempFromPointer(event: PointerEvent, svg: SVGSVGElement): void {
    const rect = svg.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (this.ARC_VW / rect.width);
    const y = (event.clientY - rect.top) * (this.ARC_VH / rect.height);
    const dx = x - this.ARC_CX;
    const dy = this.ARC_CY - y;
    let angle = Math.atan2(dy, dx);
    angle = Math.max(0, Math.min(Math.PI, angle));
    const t = 1 - angle / Math.PI;

    this.overrideTemp = Math.round(
      this.overrideMinTemp + t * (this.overrideMaxTemp - this.overrideMinTemp)
    );
    this.refreshView();
  }


  setOverrideDuration(minutes: number): void {
    this.overrideDurationMinutes = minutes;
    this.refreshView();
  }

  adjustDuration(delta: number): void {
    const next = this.overrideDurationMinutes + delta;
    this.overrideDurationMinutes = Math.max(
      this.overrideMinMinutes,
      Math.min(this.overrideMaxMinutes, next)
    );
    this.refreshView();
  }


  applyManualOverride(): void {
    if (this.isSavingOverride) return;
    if (!this.room?.device) {
      this.dialogService.error('No Device', 'This room has no assigned device.');
      return;
    }
    if (!this.canManualOverride) {
      this.dialogService.error('Not Allowed', 'Only approved staff or admins can set manual override.');
      return;
    }

    const targetTemp = Number(this.overrideTemp);
    const duration = Math.round(Number(this.overrideDurationMinutes));

    if (!Number.isFinite(targetTemp) || targetTemp < this.overrideMinTemp || targetTemp > this.overrideMaxTemp) {
      this.dialogService.error('Invalid Temperature', `Set a temperature between ${this.overrideMinTemp} and ${this.overrideMaxTemp}.`);
      return;
    }
    if (!Number.isFinite(duration) || duration < this.overrideMinMinutes || duration > this.overrideMaxMinutes) {
      this.dialogService.error('Invalid Duration', `Set a duration between ${this.overrideMinMinutes} and ${this.overrideMaxMinutes} minutes.`);
      return;
    }

    const overrideUntil = new Date(Date.now() + duration * 60_000).toISOString();

    this.dialogService.confirm(
      'Enable Manual Override',
      `Set AC to ${targetTemp}°C for ${duration} minutes?`,
      async () => {
        this.isSavingOverride = true;
        this.refreshView();
        try {
          await this.deviceService.applyManualOverride(this.room!.device!, {
            targetTemp,
            overrideUntil,
            requestedBy: this.currentUserId ?? undefined,
            roomUid: this.room!.uid,
          });
          this.dialogService.success('Override Enabled', 'Manual override has been activated.');
        } catch (err) {
          this.logger.error('Failed to apply manual override:', err);
          this.dialogService.error('Override Failed', 'Unable to set manual override. Please try again.');
        } finally {
          this.isSavingOverride = false;
          this.refreshView();
        }
      },
      undefined,
      'Enable Override',
      'Cancel'
    );
  }

  clearManualOverride(): void {
    if (this.isSavingOverride) return;
    if (!this.room?.device) return;
    if (!this.canManualOverride) return;

    this.dialogService.confirm(
      'Disable Manual Override',
      'This will return control to schedules.',
      async () => {
        this.isSavingOverride = true;
        this.refreshView();
        try {
          await this.deviceService.clearManualOverride(this.room!.device!, this.currentUserId ?? undefined);
          this.dialogService.success('Override Disabled', 'Manual override has been turned off.');
        } catch (err) {
          this.logger.error('Failed to clear manual override:', err);
          this.dialogService.error('Disable Failed', 'Unable to clear manual override. Please try again.');
        } finally {
          this.isSavingOverride = false;
          this.refreshView();
        }
      },
      undefined,
      'Disable Override',
      'Cancel'
    );
  }



  get environmentalTemperature(): number | null {
    if (this.room?.device && this.deviceData?.temperature !== undefined) return this.deviceData.temperature;
    return this.room?.temperature ?? null;
  }

  get environmentalHumidity(): number | null {
    if (this.room?.device && this.deviceData?.humidity !== undefined) return this.deviceData.humidity;
    return this.room?.humidity ?? null;
  }

  get environmentalOccupancy(): boolean | null {
    if (this.room?.device && this.deviceData?.occupancy !== undefined) return this.deviceData.occupancy;
    return this.room?.occupancy ?? null;
  }
}