// floor-plan.component.ts
import {
  Component, Input, Output, EventEmitter, ElementRef, OnChanges,
  SimpleChanges, ViewChild, ChangeDetectionStrategy, Renderer2,
  ChangeDetectorRef, NgZone, AfterViewInit, OnDestroy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Room } from '../../models/room.model';

interface VBox { x: number; y: number; w: number; h: number; }

@Component({
  selector: 'app-floor-plan',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './floor-plan.html',
  styleUrls: ['./floor-plan.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FloorPlanComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() rooms: Room[] = [];
  @Output() roomSelected = new EventEmitter<Room>();
  @ViewChild('svgEl', { static: true }) svgEl!: ElementRef<SVGSVGElement>;

  private readonly DEFAULT: VBox = { x: 0, y: 0, w: 622, h: 820 };
  vb: VBox = { ...this.DEFAULT };

  activeRoomId: string | null = null;
  isPanning = false;

  private panStart = { x: 0, y: 0 };
  private panStartVb: VBox = { ...this.DEFAULT };
  private panMoved = false;
  private animFrame: number | null = null;
  private wheelHandler!: (e: WheelEvent) => void;

  get viewBoxString(): string {
    return `${this.vb.x} ${this.vb.y} ${this.vb.w} ${this.vb.h}`;
  }

  get zoomPercent(): number {
    return Math.round((this.DEFAULT.w / this.vb.w) * 100);
  }

  constructor(
    private renderer: Renderer2,
    private el: ElementRef,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['rooms'] && this.rooms.length > 0) {
      this.syncTelemetryColors();
    }
  }

  ngAfterViewInit(): void {
    this.wheelHandler = (e: WheelEvent) => this.ngZone.run(() => this.onWheel(e));
    this.svgEl.nativeElement.addEventListener('wheel', this.wheelHandler, { passive: false });
  }

  ngOnDestroy(): void {
    this.svgEl.nativeElement.removeEventListener('wheel', this.wheelHandler);
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
  }

  onMapClick(event: MouseEvent): void {
    if (this.panMoved) return; 
    const roomGroup = this.findNamedRoomGroup(event.target as Element);
    if (roomGroup) {
      const cellId = roomGroup.getAttribute('data-cell-id')!;
      this.activateRoom(cellId, roomGroup as SVGGElement);
    } else {
      this.resetView();
    }
  }

  private findNamedRoomGroup(target: Element): Element | null {
    let el: Element | null = target;
    while (el && el.tagName.toLowerCase() !== 'svg') {
      if (el.tagName.toLowerCase() === 'g' && el.hasAttribute('data-cell-id')) {
        const id = el.getAttribute('data-cell-id')!;
        if (this.isNamedRoom(id)) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  private isNamedRoom(id: string): boolean {
    const skip = new Set(['0', '1', '3-Story-Building']);
    if (skip.has(id)) return false;
    return /^[A-Z][a-z]/.test(id);
  }

  private activateRoom(cellId: string, group: SVGGElement): void {
    if (this.activeRoomId) {
      const prev = this.el.nativeElement.querySelector(`[data-cell-id="${this.activeRoomId}"]`);
      if (prev) this.renderer.removeClass(prev, 'room-active');
    }
    this.activeRoomId = cellId;
    this.renderer.addClass(group, 'room-active');
    this.cdr.markForCheck();

    try {
      const bbox = group.getBBox();
      if (bbox.width > 0 && bbox.height > 0) {
        const pad = 55;
        this.animateTo({ x: bbox.x - pad, y: bbox.y - pad, w: bbox.width + pad * 2, h: bbox.height + pad * 2 });
      }
    } catch { }

    const normalId = cellId.replace(/-/g, ' ').toLowerCase();
    const matched = this.rooms.find(r =>
      r.roomName.toLowerCase() === normalId ||
      r.roomName.replace(/\s+/g, '-') === cellId ||
      r.uid === cellId
    );
    if (matched) this.roomSelected.emit(matched);
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
    if (this.activeRoomId) {
      const prev = this.el.nativeElement.querySelector(`[data-cell-id="${this.activeRoomId}"]`);
      if (prev) this.renderer.removeClass(prev, 'room-active');
    }
    this.activeRoomId = null;
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

  private syncTelemetryColors(): void {
    this.rooms.forEach(room => {
      const safeId = room.roomName.replace(/\s+/g, '-');
      const roomEl = this.el.nativeElement.querySelector(`[data-cell-id="${safeId}"]`);
      if (!roomEl) return;
      this.renderer.removeClass(roomEl, 'climate-optimal');
      this.renderer.removeClass(roomEl, 'climate-cooling');
      if (room.temperature && room.temperature > 25) {
        this.renderer.addClass(roomEl, 'climate-cooling');
      } else if (room.power) {
        this.renderer.addClass(roomEl, 'climate-optimal');
      }
    });
  }
}