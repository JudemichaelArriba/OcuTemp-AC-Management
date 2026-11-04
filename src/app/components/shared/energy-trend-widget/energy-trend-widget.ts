import {
  Component,
  Input,
  OnChanges,
  OnDestroy,
  ViewChild,
  ElementRef,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Injector,
  SimpleChanges,
  afterNextRender,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Tooltip,
  Filler,
  Legend,
  UpdateMode,
} from 'chart.js';

import { EnergyDaily } from '../../../models/energy.model';
import { getTodayKey } from '../../../services/energy-report.service';
import {
  EnergyTrendMode,
  EnergyTrendPoint,
  buildEnergyTrendSeries,
  computeTrendViewport,
  getTrendSlotLabel,
  getTrendTickIndexes,
  getVisibleCount,
  isSameTrendSeries,
} from '../../../helpers/energy-trend.helper';

Chart.register(
  LineController, LineElement, PointElement,
  LinearScale, Tooltip, Filler, Legend
);

interface TrendDatum {
  x: number;
  y: number;
}

const POINT_RADIUS = 3;
const POINT_HOVER_RADIUS = 5;
/** A lone point has no line to carry it, so it is drawn larger. */
const SINGLE_POINT_RADIUS = 6;
const SINGLE_POINT_HOVER_RADIUS = 8;
/** Tolerance for sub-pixel scroll offsets at high zoom levels. */
const SCROLL_END_TOLERANCE_PX = 1;

@Component({
  selector: 'app-energy-trend-widget',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './energy-trend-widget.html',
  styleUrl: './energy-trend-widget.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnergyTrendWidget implements OnChanges, OnDestroy {
  @Input() energyData: Record<string, Record<string, EnergyDaily>> = {};
  /** True until the first stream emission, so the empty state doesn't flash during load. */
  @Input() loading = false;

  @ViewChild('overallChartCanvas') overallChartCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('chartScroller') chartScroller!: ElementRef<HTMLDivElement>;

  filterMode: EnergyTrendMode = 'daily';
  hasData = false;
  isScrollable = false;
  contentWidthPercent = 100;

  private readonly cdr = inject(ChangeDetectorRef);
  private readonly injector = inject(Injector);

  private overallChart: Chart<'line', TrendDatum[]> | null = null;
  private series: readonly EnergyTrendPoint[] = [];
  private seriesTodayKey = '';
  private visibleCount = 0;
  private resizeObserver: ResizeObserver | null = null;
  private scrollFrame: number | null = null;
  private layoutPending = false;
  private jumpToLatestPending = false;
  private layoutUpdateMode: UpdateMode | undefined;

  private readonly filterIndex: Record<EnergyTrendMode, number> = {
    daily: 0,
    weekly: 1,
    monthly: 2,
    yearly: 3,
  };

  // Native passive listener: a template (scroll) binding would run change detection on every event.
  private readonly onScroll = (): void => {
    if (this.scrollFrame !== null) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.clearHover();
      this.applyViewport('none');
    });
  };

  constructor() {
    afterNextRender(() => this.initChart());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['energyData']) {
      this.refreshSeries(false);
    }
  }

  ngOnDestroy(): void {
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    this.chartScroller?.nativeElement.removeEventListener('scroll', this.onScroll);
    this.resizeObserver?.disconnect();
    this.overallChart?.destroy();
  }

  setFilter(mode: EnergyTrendMode): void {
    if (this.filterMode === mode) return;
    this.filterMode = mode;
    this.refreshSeries(true);
  }

  get sliderTranslate(): string {
    return `translateX(${this.filterIndex[this.filterMode] * 100}%)`;
  }

  private initChart(): void {
    const ctx = this.overallChartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    this.overallChart = this.createChart(ctx);

    const scroller = this.chartScroller.nativeElement;
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(scroller);
    }

    this.refreshSeries(true);
  }

  private createChart(ctx: CanvasRenderingContext2D): Chart<'line', TrendDatum[]> {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    return new Chart<'line', TrendDatum[]>(ctx, {
      type: 'line',
      data: {
        datasets: [
          {
            data: [],
            parsing: false,
            normalized: true,
            borderColor: '#2563EB',
            backgroundColor: (context) => {
              const chart = context.chart;
              const { ctx, chartArea } = chart;
              if (!chartArea) return 'rgba(37,99,235,0.08)';
              const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              gradient.addColorStop(0, 'rgba(37,99,235,0.15)');
              gradient.addColorStop(1, 'rgba(37,99,235,0.01)');
              return gradient;
            },
            fill: true,
            tension: 0.4,
            pointBackgroundColor: '#FFFFFF',
            pointBorderColor: '#2563EB',
            pointBorderWidth: 2,
            pointRadius: POINT_RADIUS,
            pointHoverRadius: POINT_HOVER_RADIUS,
            borderWidth: 2.5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : { duration: 800, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e293b',
            padding: 12,
            titleFont: { size: 12, weight: 'bold' },
            bodyFont: { size: 12 },
            cornerRadius: 8,
            displayColors: false,
            callbacks: {
              title: (items) => this.series[items[0]?.parsed.x ?? -1]?.tooltipTitle ?? '',
              label: (ctx) => `Consumption: ${Number(ctx.parsed.y).toFixed(3)} kWh`,
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            border: { display: false },
            grid: { color: '#f1f5f9' },
            ticks: {
              font: { size: 10, family: 'Inter' },
              color: '#64748b',
              padding: 10,
              callback: (v) => `${v} kWh`,
            },
          },
          x: {
            // Linear rather than category: category scales round min/max to whole points, which
            // would make scrolling jump a full period at a time.
            type: 'linear',
            // Keeps the fractional min/max exact; 'ticks' would widen them to the generated ticks.
            bounds: 'data',
            border: { display: false },
            grid: { display: false },
            // One tick per period in view, including the empty periods around centered data. The
            // generator would offset them from a fractional min.
            afterBuildTicks: (axis) => {
              axis.ticks = this.series.length
                ? getTrendTickIndexes(axis.min, axis.max).map((value) => ({ value }))
                : [];
            },
            ticks: {
              font: { size: 10, family: 'Inter' },
              color: '#64748b',
              padding: 10,
              maxRotation: 0,
              callback: (value) =>
                getTrendSlotLabel(this.series, Number(value), this.filterMode, this.seriesTodayKey),
            },
          },
        },
      },
    });
  }

  private refreshSeries(jumpToLatest: boolean): void {
    const chart = this.overallChart;
    if (!chart) return;

    const todayKey = getTodayKey();
    const next = buildEnergyTrendSeries(this.energyData, this.filterMode, todayKey);
    // Most stream emissions are telemetry changes that leave energy untouched.
    if (!jumpToLatest && isSameTrendSeries(this.series, next)) return;

    this.jumpToLatestPending ||= jumpToLatest || this.isAtLatest();
    this.series = next;
    this.seriesTodayKey = todayKey;

    const dataset = chart.data.datasets[0];
    dataset.data = next.map((point, index) => ({ x: index, y: point.kwh }));
    dataset.pointRadius = next.length === 1 ? SINGLE_POINT_RADIUS : POINT_RADIUS;
    dataset.pointHoverRadius = next.length === 1 ? SINGLE_POINT_HOVER_RADIUS : POINT_HOVER_RADIUS;

    // Fixed to the whole series because autoscaling only sees the visible window, which would make
    // the axis jump while scrolling.
    const yScale = chart.options.scales?.['y'];
    if (yScale) yScale.suggestedMax = next.reduce((max, point) => Math.max(max, point.kwh), 0);

    this.hasData = next.length > 0;
    this.visibleCount = this.measureVisibleCount();
    this.scheduleLayout(undefined);
  }

  private handleResize(): void {
    const visibleCount = this.measureVisibleCount();
    if (visibleCount === this.visibleCount) return;

    this.jumpToLatestPending ||= this.isAtLatest();
    this.visibleCount = visibleCount;
    this.scheduleLayout('none');
  }

  private measureVisibleCount(): number {
    return getVisibleCount(this.filterMode, this.chartScroller.nativeElement.clientWidth);
  }

  /** Resizes the scroll content, then positions and redraws the chart once that is laid out. */
  private scheduleLayout(updateMode: UpdateMode | undefined): void {
    const viewport = computeTrendViewport(this.series.length, this.visibleCount, 1);
    this.contentWidthPercent = viewport.contentWidthPercent;
    this.isScrollable = viewport.scrollable;
    this.layoutUpdateMode = updateMode;
    this.cdr.markForCheck();

    if (this.layoutPending) return;
    this.layoutPending = true;
    afterNextRender(
      () => {
        this.layoutPending = false;
        const scroller = this.chartScroller.nativeElement;
        if (this.jumpToLatestPending) {
          this.jumpToLatestPending = false;
          scroller.scrollLeft = scroller.scrollWidth;
        }
        this.applyViewport(this.layoutUpdateMode);
      },
      { injector: this.injector }
    );
  }

  /** Moves the chart's axis window to match the scroll position. */
  private applyViewport(updateMode: UpdateMode | undefined): void {
    const chart = this.overallChart;
    const xScale = chart?.options.scales?.['x'];
    if (!chart || !xScale) return;

    const scroller = this.chartScroller.nativeElement;
    const scrollRange = scroller.scrollWidth - scroller.clientWidth;
    const progress = scrollRange > 0 ? scroller.scrollLeft / scrollRange : 1;
    const { min, max } = computeTrendViewport(this.series.length, this.visibleCount, progress);

    xScale.min = min;
    xScale.max = max;
    chart.update(updateMode);
  }

  private isAtLatest(): boolean {
    const scroller = this.chartScroller.nativeElement;
    return scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft <= SCROLL_END_TOLERANCE_PX;
  }

  /** A tooltip would otherwise stay on screen while its point scrolls away beneath it. */
  private clearHover(): void {
    const chart = this.overallChart;
    if (!chart || chart.getActiveElements().length === 0) return;
    chart.setActiveElements([]);
    chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
  }
}
