import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  afterNextRender,
  inject,
  viewChild,
} from '@angular/core';
import { MODE_DRAWS, resolvePreset } from 'thinking-orbs/engine';

const ORB_PRESET_SIZE = 64;
const ORB_RENDER_SIZE = 52;
const ORB_SPEED = 1.65;
const ORB_COLOR = '#2563eb';

@Component({
  selector: 'app-thinking-orb',
  standalone: true,
  template: `
    <canvas
      #orbCanvas
      class="block size-13 shrink-0 motion-reduce:opacity-80"
      width="52"
      height="52"
      aria-hidden="true">
    </canvas>
  `,
  host: { class: 'block size-13 shrink-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThinkingOrbComponent {
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('orbCanvas');
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);
  private frameId: number | null = null;
  private intersectionObserver?: IntersectionObserver;
  private motionQuery?: MediaQueryList;
  private visible = true;
  private pageVisible = true;
  private reducedMotion = false;
  private destroyed = false;
  private startedAt = 0;

  constructor() {
    afterNextRender({ write: () => this.initialize() });
    this.destroyRef.onDestroy(() => this.destroy());
  }

  private initialize(): void {
    const canvas = this.canvas().nativeElement;
    const context = canvas.getContext('2d');
    if (!context) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const renderScale = ORB_RENDER_SIZE / ORB_PRESET_SIZE;
    canvas.width = Math.round(ORB_RENDER_SIZE * pixelRatio);
    canvas.height = Math.round(ORB_RENDER_SIZE * pixelRatio);
    context.setTransform(
      pixelRatio * renderScale,
      0,
      0,
      pixelRatio * renderScale,
      0,
      0,
    );

    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.motionQuery.matches;
    const onMotionChange = (event: MediaQueryListEvent): void => {
      this.reducedMotion = event.matches;
      this.syncAnimation(context);
    };
    const onVisibilityChange = (): void => {
      this.pageVisible = document.visibilityState === 'visible';
      this.syncAnimation(context);
    };
    this.motionQuery.addEventListener('change', onMotionChange);
    document.addEventListener('visibilitychange', onVisibilityChange);

    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(([entry]) => {
        this.visible = entry?.isIntersecting ?? true;
        this.syncAnimation(context);
      });
      this.intersectionObserver.observe(canvas);
    }

    this.destroyRef.onDestroy(() => {
      this.motionQuery?.removeEventListener('change', onMotionChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
    this.syncAnimation(context);
  }

  private syncAnimation(context: CanvasRenderingContext2D): void {
    this.cancelFrame();
    if (this.destroyed || !this.visible || !this.pageVisible) return;
    if (this.reducedMotion) {
      this.drawFrame(context, 0);
      return;
    }

    this.startedAt = performance.now();
    this.zone.runOutsideAngular(() => {
      const animate = (timestamp: number): void => {
        if (this.destroyed || !this.visible || !this.pageVisible || this.reducedMotion) return;
        this.drawFrame(context, (timestamp - this.startedAt) / 1_000);
        this.frameId = requestAnimationFrame(animate);
      };
      this.frameId = requestAnimationFrame(animate);
    });
  }

  private drawFrame(context: CanvasRenderingContext2D, elapsedSeconds: number): void {
    const preset = resolvePreset('connecting', ORB_PRESET_SIZE);
    context.clearRect(0, 0, ORB_PRESET_SIZE, ORB_PRESET_SIZE);
    context.save();
    MODE_DRAWS[preset.mode](
      context,
      ORB_PRESET_SIZE,
      elapsedSeconds * preset.speed * ORB_SPEED,
      false,
      preset.opts,
    );
    context.globalCompositeOperation = 'source-in';
    context.globalAlpha = 1;
    context.fillStyle = ORB_COLOR;
    context.fillRect(0, 0, ORB_PRESET_SIZE, ORB_PRESET_SIZE);
    context.restore();
  }

  private cancelFrame(): void {
    if (this.frameId === null) return;
    cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  private destroy(): void {
    this.destroyed = true;
    this.cancelFrame();
    this.intersectionObserver?.disconnect();
  }
}
