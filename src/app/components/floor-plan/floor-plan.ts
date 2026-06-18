import {
  Component, Input, Output, EventEmitter, ElementRef, OnChanges,
  SimpleChanges, ViewChild, ChangeDetectionStrategy, Renderer2,
  ChangeDetectorRef, NgZone, AfterViewInit, OnDestroy, OnInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { Room } from '../../models/room.model';
import { Device } from '../../models/esp.model';
import {
  FLOOR_PLAN_STATE_CLASSES,
  FloorPlanRoomState,
  getFloorPlanRoomState,
} from '../../helpers/floor-plan-state';
import {
  DeviceOnlineState,
  DeviceService,
  getDeviceOnlineState,
} from '../../services/device.service';
import { AuthStateService } from '../../services/auth-state.service';
import { DialogService } from '../../services/dialog.service';

interface VBox { x: number; y: number; w: number; h: number; }

export interface FloorPlanCellSelection {
  cellId: string;
  room?: Room;
  state: FloorPlanRoomState;
}

export interface RoomOverlay {
  cellId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  room: Room;
  state: FloorPlanRoomState;
  showTooltip: boolean;
}

@Component({
  selector: 'app-floor-plan',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './floor-plan.html',
  styleUrls: ['./floor-plan.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FloorPlanComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy {
  @Input() rooms: Room[] = [];
  @Input() editMode = false;

  @Output() roomSelected = new EventEmitter<Room | undefined>();
  @Output() floorPlanCellSelected = new EventEmitter<FloorPlanCellSelection>();
  @Output() floorPlanCellEditRequested = new EventEmitter<FloorPlanCellSelection>();

  @ViewChild('svgEl', { static: true }) svgEl!: ElementRef<SVGSVGElement>;

  private static readonly DEVICE_STATUS_REFRESH_MS = 60_000;

  private readonly DEFAULT: VBox = { x: 0, y: 0, w: 622, h: 820 };
  vb: VBox = { ...this.DEFAULT };

  activeCellId: string | null = null;
  activeRoom: Room | undefined;
  activeState: FloorPlanRoomState | null = null;
  isPanning = false;
  canToggleAiAutoApply = false;
  isSavingAiAutoApply = false;

  overlays: RoomOverlay[] = [];

  private deviceMap: Record<string, Device> = {};
  private deviceIdsKey = '';
  private unsubscribeDevices?: () => void;
  private authSubscription?: Subscription;
  private statusInterval?: ReturnType<typeof setInterval>;
  private destroyed = false;
  private panStart = { x: 0, y: 0 };
  private panStartVb: VBox = { ...this.DEFAULT };
  private panMoved = false;
  private viewReady = false;
  private animFrame: number | null = null;
  private wheelHandler!: (e: WheelEvent) => void;

  get viewBoxString(): string {
    return `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`;
  }

  get zoomPercent(): number {
    return Math.round((this.DEFAULT.w / this.vb.w) * 100);
  }

  get activeDisplayName(): string {
    return this.activeRoom?.roomName ?? this.activeCellId?.replace(/-/g, ' ') ?? 'Unassigned cell';
  }

  get activeStatusText(): string {
    if (!this.activeRoom) return 'Unassigned';
    return this.activeRoom.power === true ? 'ON' : 'OFF';
  }

  get activeTemperatureText(): string {
    if (this.activeRoom?.temperature === undefined) return '--';
    return `${this.activeRoom.temperature.toFixed(1)}C`;
  }

  get activeHumidityText(): string {
    if (this.activeRoom?.humidity === undefined) return '--';
    return `${this.activeRoom.humidity.toFixed(1)}%`;
  }

  get activeOccupancyText(): string {
    if (this.activeRoom?.occupancy === undefined) return '--';
    return this.activeRoom.occupancy ? 'Occupied' : 'Vacant';
  }

  get activeMlSuggestionReasonText(): string {
    const reason = this.activeRoom?.pendingMlSuggestion?.reason;
    return reason ? reason.replace(/_/g, ' ') : 'suggestion pending';
  }

  get activeDevice(): Device | undefined {
    return this.activeRoom?.device ? this.deviceMap[this.activeRoom.device] : undefined;
  }

  get activeDeviceOnlineState(): DeviceOnlineState {
    if (!this.activeRoom?.device) return 'unknown';
    return getDeviceOnlineState(this.activeDevice?.status?.lastSeen);
  }

  get activeDeviceOnlineStateText(): string {
    if (!this.activeRoom?.device) return 'No device';
    switch (this.activeDeviceOnlineState) {
      case 'online': return 'Online';
      case 'stale': return 'Stale';
      case 'offline': return 'Offline';
      default: return 'Unknown';
    }
  }

  get activeDeviceOnlineStateDotClass(): string {
    switch (this.activeDeviceOnlineState) {
      case 'online': return 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.75)]';
      case 'stale': return 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.75)] animate-pulse';
      case 'offline': return 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.75)]';
      default: return 'bg-slate-300';
    }
  }

  get activeDeviceOnlineStateLabelClass(): string {
    switch (this.activeDeviceOnlineState) {
      case 'online': return 'text-emerald-600';
      case 'stale': return 'text-amber-600';
      case 'offline': return 'text-red-500';
      default: return 'text-slate-400';
    }
  }

  get activeDeviceIdText(): string {
    return this.activeRoom?.device || 'Not linked';
  }

  get aiAutoApplyEnabled(): boolean {
    return this.activeDevice?.control?.aiAutoApply === true;
  }

  get aiAutoApplyToggleDisabled(): boolean {
    return (
      !this.activeRoom?.device ||
      this.activeDevice === undefined ||
      !this.canToggleAiAutoApply ||
      this.isSavingAiAutoApply
    );
  }

  get aiAutoApplyStatusText(): string {
    if (!this.activeRoom?.device) return 'No device';
    if (this.activeDevice === undefined) return 'Syncing';
    return this.aiAutoApplyEnabled ? 'AI On' : 'AI Off';
  }

  get aiAutoApplyAriaLabel(): string {
    const roomName = this.activeRoom?.roomName ?? 'this room';
    return `${this.aiAutoApplyEnabled ? 'Disable' : 'Enable'} AI auto apply for ${roomName}`;
  }

  constructor(
    private renderer: Renderer2,
    private el: ElementRef,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private deviceService: DeviceService,
    private authState: AuthStateService,
    private dialogService: DialogService
  ) { }

  ngOnInit(): void {
    this.authSubscription = this.authState.currentUser$.subscribe((user) => {
      this.canToggleAiAutoApply =
        user?.approved === true && (user?.role === 'admin' || user?.role === 'staff');
      this.cdr.markForCheck();
    });

    this.statusInterval = setInterval(() => {
      if (!this.destroyed) this.cdr.markForCheck();
    }, FloorPlanComponent.DEVICE_STATUS_REFRESH_MS);

    this.syncDeviceStream();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['rooms']) {
      this.syncDeviceStream();
      this.syncFloorPlanState();
      if (this.activeCellId) {
        this.activeRoom = this.findAssignedRoomForCell(this.activeCellId);
        this.activeState = getFloorPlanRoomState(this.activeRoom);
        this.roomSelected.emit(this.activeRoom);
      }
    }
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.wheelHandler = (e: WheelEvent) => this.ngZone.run(() => this.onWheel(e));
    this.svgEl.nativeElement.addEventListener('wheel', this.wheelHandler, { passive: false });
    this.syncFloorPlanState();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.unsubscribeDevices?.();
    this.authSubscription?.unsubscribe();
    clearInterval(this.statusInterval);

    if (this.wheelHandler) {
      this.svgEl.nativeElement.removeEventListener('wheel', this.wheelHandler);
    }
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
  }

  onMapClick(event: MouseEvent): void {
    if (this.panMoved) return;
    const roomGroup = this.findAssignableRoomGroup(event.target as Element);
    if (roomGroup) {
      const cellId = roomGroup.getAttribute('data-cell-id');
      if (cellId) {
        this.activateRoom(cellId, roomGroup as SVGGElement);
      }
    } else {
      this.resetView();
    }
  }

  activateRoomFromOverlay(event: MouseEvent, cellId: string): void {
    event.stopPropagation();
    const group = this.queryCell(cellId) as SVGGElement | null;
    if (group) {
      this.activateRoom(cellId, group);
    }
  }

  private findAssignableRoomGroup(target: Element): Element | null {
    let el: Element | null = target;
    while (el && el.tagName.toLowerCase() !== 'svg') {
      if (el.tagName.toLowerCase() === 'g' && el.hasAttribute('data-cell-id')) {
        const id = el.getAttribute('data-cell-id');
        if (id && this.isAssignableCellId(id)) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  private isAssignableCellId(id: string): boolean {
    const skip = new Set(['0', '1', '3-Story-Building']);
    if (skip.has(id)) return false;
    return /^[A-Z][A-Za-z0-9-]*$/.test(id);
  }

  private activateRoom(cellId: string, group: SVGGElement): void {
    if (this.activeCellId) {
      const prev = this.queryCell(this.activeCellId);
      if (prev) this.renderer.removeClass(prev, 'room-active');
    }

    const matched = this.findAssignedRoomForCell(cellId);
    const state = getFloorPlanRoomState(matched);

    this.activeCellId = cellId;
    this.activeRoom = matched;
    this.activeState = state;
    this.renderer.addClass(group, 'room-active');
    this.cdr.markForCheck();

    try {
      const bbox = group.getBBox();
      if (bbox && bbox.width > 0 && bbox.height > 0) {
        const pad = 55;
        this.animateTo({ x: bbox.x - pad, y: bbox.y - pad, w: bbox.width + pad * 2, h: bbox.height + pad * 2 });
      }
    } catch {

    }

    const selection = this.buildSelection(cellId, matched);
    this.roomSelected.emit(matched);
    this.floorPlanCellSelected.emit(selection);

    if (this.editMode) {
      this.floorPlanCellEditRequested.emit(selection);
    }
  }

  zoomIn(event: Event): void {
    event.stopPropagation();
    const cx = this.vb.x + this.vb.w / 2, cy = this.vb.y + this.vb.h / 2;
    const nw = Math.max(this.vb.w * 0.65, 60), nh = Math.max(this.vb.h * 0.65, 80);
    this.animateTo({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh });
  }

  zoomOut(event: Event): void {
    event.stopPropagation();
    const cx = this.vb.x + this.vb.w / 2, cy = this.vb.y + this.vb.h / 2;
    const nw = Math.min(this.vb.w / 0.65, this.DEFAULT.w * 1.5);
    const nh = Math.min(this.vb.h / 0.65, this.DEFAULT.h * 1.5);
    this.animateTo({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh });
  }

  resetView(event?: Event): void {
    event?.stopPropagation();
    if (this.activeCellId) {
      const prev = this.queryCell(this.activeCellId);
      if (prev) this.renderer.removeClass(prev, 'room-active');
    }
    this.activeCellId = null;
    this.activeRoom = undefined;
    this.activeState = null;
    this.roomSelected.emit(undefined);
    this.animateTo({ ...this.DEFAULT });
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = this.svgEl.nativeElement.getBoundingClientRect();
    const mx = ((event.clientX - rect.left) / rect.width) * this.vb.w + this.vb.x;
    const my = ((event.clientY - rect.top) / rect.height) * this.vb.h + this.vb.y;
    const factor = event.deltaY > 0 ? 1.18 : 0.82;
    const nw = Math.min(Math.max(this.vb.w * factor, 60), this.DEFAULT.w * 1.8);
    const nh = Math.min(Math.max(this.vb.h * factor, 80), this.DEFAULT.h * 1.8);
    this.vb = {
      x: mx - (mx - this.vb.x) * (nw / this.vb.w),
      y: my - (my - this.vb.y) * (nh / this.vb.h),
      w: nw, h: nh
    };
    this.cdr.markForCheck();
  }

  onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    this.panMoved = false;
    this.isPanning = true;
    this.panStart = { x: event.clientX, y: event.clientY };
    this.panStartVb = { ...this.vb };
    this.cdr.markForCheck();
    event.preventDefault();
  }

  onMouseMove(event: MouseEvent): void {
    if (!this.isPanning || event.buttons !== 1) return;
    const dx = event.clientX - this.panStart.x;
    const dy = event.clientY - this.panStart.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this.panMoved = true;
    if (!this.panMoved) return;
    const rect = this.svgEl.nativeElement.getBoundingClientRect();
    this.vb = {
      ...this.panStartVb,
      x: this.panStartVb.x - dx * (this.vb.w / rect.width),
      y: this.panStartVb.y - dy * (this.vb.h / rect.height)
    };
    this.cdr.markForCheck();
  }

  onMouseUp(): void {
    this.isPanning = false;
    this.cdr.markForCheck();
  }

  async toggleAiAutoApply(event: Event): Promise<void> {
    event.stopPropagation();
    if (this.aiAutoApplyToggleDisabled || !this.activeRoom?.device) return;

    this.isSavingAiAutoApply = true;
    this.cdr.markForCheck();

    try {
      await this.deviceService.setAiAutoApplyEnabled(
        this.activeRoom.device,
        !this.aiAutoApplyEnabled
      );
    } catch (err) {
      this.dialogService.error('AI Toggle Failed', 'Unable to update AI auto-apply. Please try again.');
    } finally {
      this.isSavingAiAutoApply = false;
      this.cdr.markForCheck();
    }
  }

  private syncDeviceStream(): void {
    const deviceIds = Array.from(
      new Set(
        this.rooms
          .map((room) => room.device?.trim())
          .filter((deviceId): deviceId is string => !!deviceId)
      )
    ).sort();
    const nextKey = deviceIds.join('|');

    if (nextKey === this.deviceIdsKey) return;

    this.deviceIdsKey = nextKey;
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = undefined;
    this.deviceMap = {};

    if (deviceIds.length === 0) {
      this.cdr.markForCheck();
      return;
    }

    this.unsubscribeDevices = this.deviceService.streamDevicesByIds(deviceIds, (devices) => {
      if (this.destroyed) return;
      this.deviceMap = devices;
      this.cdr.markForCheck();
    });
  }

  private animateTo(target: VBox): void {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    const start = { ...this.vb };
    const dur = 430;
    const t0 = performance.now();
    const ease = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    this.ngZone.runOutsideAngular(() => {
      const step = (now: number) => {
        const p = Math.min((now - t0) / dur, 1);
        const e = ease(p);
        this.vb = {
          x: start.x + (target.x - start.x) * e,
          y: start.y + (target.y - start.y) * e,
          w: start.w + (target.w - start.w) * e,
          h: start.h + (target.h - start.h) * e,
        };
        this.cdr.markForCheck();
        this.animFrame = p < 1 ? requestAnimationFrame(step) : null;
      };
      this.animFrame = requestAnimationFrame(step);
    });
  }

  private syncFloorPlanState(): void {
    if (!this.viewReady) return;

    const cells = Array.from(
      this.el.nativeElement.querySelectorAll('g[data-cell-id]')
    ) as SVGGElement[];

    const newOverlays: RoomOverlay[] = [];

    cells.forEach((cell) => {
      const cellId = cell.getAttribute('data-cell-id') ?? '';
      if (!this.isAssignableCellId(cellId)) return;

      this.renderer.addClass(cell, 'floorplan-cell');
      this.renderer.removeClass(cell, 'floorplan-assigned');
      this.renderer.removeClass(cell, 'room-on');
      this.renderer.removeClass(cell, 'room-off');
      FLOOR_PLAN_STATE_CLASSES.forEach((className) => this.renderer.removeClass(cell, className));

      const room = this.findAssignedRoomForCell(cellId);

      if (!room) {
        this.renderer.addClass(cell, 'floorplan-state-no-telemetry');
        return;
      }

      const state = getFloorPlanRoomState(room);
      this.renderer.addClass(cell, 'floorplan-assigned');
      this.renderer.addClass(cell, state.className);

      if (room.power === true) {
        this.renderer.addClass(cell, 'room-on');
      } else {
        this.renderer.addClass(cell, 'room-off');
      }

      try {
        const bbox = cell.getBBox();
        newOverlays.push({
          cellId,
          x: bbox.x,
          y: bbox.y,
          width: bbox.width,
          height: bbox.height,
          room,
          state,
          showTooltip: false
        });
      } catch (e) {

      }
    });

    this.overlays = newOverlays;
    this.cdr.detectChanges();
  }

  private buildSelection(cellId: string, room?: Room): FloorPlanCellSelection {
    return {
      cellId,
      room,
      state: getFloorPlanRoomState(room),
    };
  }


  private findAssignedRoomForCell(cellId: string): Room | undefined {
    return this.rooms.find((room) =>
      room.floorPlanCellId === cellId
    );
  }

  private queryCell(cellId: string): Element | null {
    return this.el.nativeElement.querySelector(`[data-cell-id="${cellId.replace(/"/g, '\\"')}"]`);
  }

  getBadgeColorClass(visualState: string | undefined): string {
    switch (visualState) {
      case 'comfortable':
        return 'bg-[#10b981] shadow-[0_0_8px_rgba(16,185,129,0.8)] border-emerald-400';
      case 'slightly-warm':
        return 'bg-[#fbbf24] shadow-[0_0_8px_rgba(251,191,36,0.8)] border-amber-300';
      case 'warm':
        return 'bg-[#f59e0b] shadow-[0_0_8px_rgba(245,158,11,0.8)] border-orange-400';
      case 'hot':
        return 'bg-[#f97316] shadow-[0_0_8px_rgba(249,115,22,0.8)] border-orange-500';
      case 'very-hot':
        return 'bg-[#ef4444] shadow-[0_0_8px_rgba(239,68,68,0.8)] border-red-400';
      case 'off':
        return 'bg-slate-400 border-slate-300 shadow-none';
      default:
        return 'bg-slate-300 border-slate-200 shadow-none';
    }
  }
}
