import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterRenderEffect,
  input,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';
import {
  ChatDisplayDirective,
  ChatEvidenceMetadata,
  ChatPresentation,
  ChatResponseContext,
  ClimateSuggestionRow,
  EnergyReportPresentation,
  EnergyRoomDataStatus,
  EnergyRoomRow,
  EnergyTrendPoint,
  ProjectedValue,
  RecentEventRow,
  RoomCondition,
  RoomDataRow,
  RoomTelemetryRow,
  ScheduleDataRow,
  SystemField,
} from '../../models/chat.models';

Chart.register(
  BarController,
  BarElement,
  CategoryScale,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
);

type EnergyChartKind = 'ranking' | 'trend';

interface RoomFieldColumn {
  readonly field: SystemField;
  readonly label: string;
}

@Component({
  selector: 'app-ocu-guide-report',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './ocu-guide-report.html',
  host: { class: 'block min-w-0 text-slate-900' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OcuGuideReportComponent implements OnDestroy {
  readonly presentation = input.required<ChatPresentation>();
  readonly displayDirective = input.required<ChatDisplayDirective>();
  readonly context = input<ChatResponseContext>();
  readonly evidence = input<ChatEvidenceMetadata>();
  readonly turnId = input.required<string>();

  private readonly chartCanvases = viewChildren<ElementRef<HTMLCanvasElement>>('reportChart');
  private readonly chartInstances = new Map<HTMLCanvasElement, Chart>();
  private readonly observedCanvases = new Set<HTMLCanvasElement>();
  private readonly visibleCanvases = new Set<HTMLCanvasElement>();
  private readonly roomFieldCache = new WeakMap<readonly RoomDataRow[], readonly RoomFieldColumn[]>();
  private chartObserver?: IntersectionObserver;
  private destroyed = false;
  private readonly dateTimeFormatter = new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  });

  constructor() {
    afterRenderEffect(() => {
      const canvases = this.chartCanvases().map((canvas) => canvas.nativeElement);
      this.syncChartObservers(canvases);
      this.syncCharts(canvases);
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.chartObserver?.disconnect();
    this.observedCanvases.clear();
    this.visibleCanvases.clear();
    for (const chart of this.chartInstances.values()) chart.destroy();
    this.chartInstances.clear();
  }

  roomFields(rows: readonly RoomDataRow[]): readonly RoomFieldColumn[] {
    const cached = this.roomFieldCache.get(rows);
    if (cached) return cached;
    const seen = new Set<SystemField>();
    const fields: RoomFieldColumn[] = [];
    for (const row of rows) {
      for (const value of row.values) {
        if (seen.has(value.field)) continue;
        seen.add(value.field);
        fields.push({ field: value.field, label: value.label });
      }
    }
    this.roomFieldCache.set(rows, fields);
    return fields;
  }

  projectedValue(row: RoomDataRow, field: SystemField): ProjectedValue | undefined {
    return row.values.find((value) => value.field === field);
  }

  firstRoomValues(
    presentation: Extract<ChatPresentation, { readonly kind: 'room-data' }>,
  ): readonly ProjectedValue[] {
    return presentation.rooms[0]?.values ?? [];
  }

  formatProjectedValue(value: ProjectedValue | undefined): string {
    if (!value) return 'Not available';
    if (value.value === null) return this.valueStateLabel(value.state);
    if (typeof value.value === 'boolean') return value.value ? 'Yes' : 'No';
    if (typeof value.value === 'number') {
      const formatted = new Intl.NumberFormat('en-PH', {
        maximumFractionDigits: value.unit === 'celsius' || value.unit === 'kwh' ? 2 : 1,
      }).format(value.value);
      switch (value.unit) {
        case 'celsius': return `${formatted} °C`;
        case 'percent': return `${formatted}%`;
        case 'kwh': return `${formatted} kWh`;
        case 'seconds': return this.formatRuntime(value.value);
        default: return formatted;
      }
    }
    if (value.unit === 'datetime') return this.formatDateTime(value.value);
    return value.value;
  }

  valueStateLabel(state: ProjectedValue['state']): string {
    const labels: Record<ProjectedValue['state'], string> = {
      current: 'Current',
      historical: 'Last known',
      configured: 'Configured',
      expired: 'Expired',
      unknown: 'Unknown',
      unavailable: 'Unavailable',
      not_applicable: 'Not applicable',
    };
    return labels[state];
  }

  valueStateClass(state: ProjectedValue['state']): string {
    const base = 'mt-1 inline-flex w-max rounded-full px-1.5 py-0.5 text-[0.66rem] font-semibold';
    if (state === 'current' || state === 'configured') return `${base} bg-emerald-50 text-emerald-700`;
    if (state === 'expired' || state === 'historical') return `${base} bg-amber-50 text-amber-700`;
    return `${base} bg-slate-100 text-slate-500`;
  }

  shouldShowState(value: ProjectedValue | undefined): boolean {
    return Boolean(value && value.state !== 'current' && value.state !== 'configured');
  }

  recordedEnergyRooms(report: EnergyReportPresentation): EnergyRoomRow[] {
    return report.rooms
      .filter((row) => row.status === 'recorded' && row.estimatedKwh !== null)
      .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER));
  }

  topEnergyRooms(report: EnergyReportPresentation): EnergyRoomRow[] {
    return this.recordedEnergyRooms(report).slice(0, 8);
  }

  formatRuntime(seconds: number | null): string {
    if (seconds === null) return 'Not available';
    if (seconds > 0 && seconds < 60) return '<1m';
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    if (hours === 0) return `${minutes}m`;
    return `${hours}h ${minutes}m`;
  }

  formatDateTime(value: string | null): string {
    if (!value) return 'Not reported';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Invalid timestamp' : this.dateTimeFormatter.format(date);
  }

  energyStatusLabel(status: EnergyRoomDataStatus): string {
    const labels: Record<EnergyRoomDataStatus, string> = {
      recorded: 'Recorded',
      no_records: 'No records',
      no_device: 'No device',
      device_unavailable: 'Device unavailable',
    };
    return labels[status];
  }

  conditionLabel(condition: RoomCondition): string {
    return condition === 'unknown'
      ? 'Unknown'
      : `${condition.charAt(0).toUpperCase()}${condition.slice(1)}`;
  }

  measurementStatusLabel(row: RoomTelemetryRow): string {
    switch (row.measurementStatus) {
      case 'current': return 'Current';
      case 'stale': return 'Last known (stale)';
      case 'offline': return 'Last known (offline)';
      case 'unavailable': return 'Unavailable';
    }
  }

  booleanLabel(value: boolean | null, trueLabel = 'Yes', falseLabel = 'No'): string {
    return value === null ? 'Not reported' : value ? trueLabel : falseLabel;
  }

  climateStatusLabel(status: ClimateSuggestionRow['status']): string {
    const labels: Record<ClimateSuggestionRow['status'], string> = {
      available: 'Suggestion available',
      no_suggestion: 'No suggestion',
      no_device: 'No device',
      device_unavailable: 'Device unavailable',
    };
    return labels[status];
  }

  helpTopicLabel(topic: string): string {
    const words = topic.split('-').map((word) => word.trim()).filter(Boolean);
    if (words.length === 0) return 'OcuTemp help';
    return words
      .map((word) => `${word.charAt(0).toLocaleUpperCase('en-US')}${word.slice(1)}`)
      .join(' ');
  }

  presentationDomId(prefix: string, presentationId: string): string {
    return `${prefix}-${this.turnId()}-${presentationId}`.replace(/[^A-Za-z0-9_-]/g, '-');
  }

  metricTrackKey(value: ProjectedValue, index: number): string {
    return `${value.field}\u0000${index}`;
  }

  roomTrackKey(row: RoomDataRow, index: number): string {
    return `${row.roomName}\u0000${index}`;
  }

  fieldTrackKey(column: RoomFieldColumn): string {
    return column.field;
  }

  scheduleTrackKey(row: ScheduleDataRow, index: number): string {
    return [row.roomName, row.day, row.startTime, row.endTime, row.subject, index].join('\u0000');
  }

  eventTrackKey(event: RecentEventRow, index: number): string {
    return [event.updatedAt, event.roomName, event.eventType, index].join('\u0000');
  }

  energyTrackKey(row: EnergyRoomRow, index: number): string {
    return `${row.roomName}\u0000${row.rank ?? ''}\u0000${index}`;
  }

  trendTrackKey(point: EnergyTrendPoint): string {
    return `${point.start}\u0000${point.end}`;
  }

  private syncChartObservers(canvases: readonly HTMLCanvasElement[]): void {
    const current = new Set(canvases);
    for (const canvas of this.observedCanvases) {
      if (current.has(canvas)) continue;
      this.chartObserver?.unobserve(canvas);
      this.observedCanvases.delete(canvas);
      this.visibleCanvases.delete(canvas);
      this.destroyChart(canvas);
    }

    if (typeof IntersectionObserver === 'undefined') {
      canvases.forEach((canvas) => this.visibleCanvases.add(canvas));
      return;
    }
    this.chartObserver ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const canvas = entry.target;
        if (!(canvas instanceof HTMLCanvasElement)) continue;
        if (entry.isIntersecting) this.visibleCanvases.add(canvas);
        else this.visibleCanvases.delete(canvas);
      }
      if (!this.destroyed) this.syncCharts(this.chartCanvases().map((item) => item.nativeElement));
    }, { rootMargin: '160px 0px' });

    for (const canvas of canvases) {
      if (this.observedCanvases.has(canvas)) continue;
      this.observedCanvases.add(canvas);
      this.chartObserver.observe(canvas);
    }
  }

  private syncCharts(canvases: readonly HTMLCanvasElement[]): void {
    const current = new Set(canvases);
    for (const canvas of this.chartInstances.keys()) {
      if (!current.has(canvas) || !this.visibleCanvases.has(canvas)) this.destroyChart(canvas);
    }

    const presentation = this.presentation();
    if (presentation.kind !== 'energy-report' || presentation.availability !== 'available') return;
    for (const canvas of canvases) {
      if (!this.visibleCanvases.has(canvas) || this.chartInstances.has(canvas)) continue;
      if (canvas.dataset['presentationId'] !== presentation.id) continue;
      const kind = canvas.dataset['chartKind'] as EnergyChartKind | undefined;
      if (!kind) continue;
      const reducedMotion = typeof window !== 'undefined'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.chartInstances.set(
        canvas,
        kind === 'ranking'
          ? this.createRankingChart(canvas, presentation, reducedMotion)
          : this.createTrendChart(canvas, presentation, reducedMotion),
      );
    }
  }

  private destroyChart(canvas: HTMLCanvasElement): void {
    this.chartInstances.get(canvas)?.destroy();
    this.chartInstances.delete(canvas);
  }

  private createRankingChart(
    canvas: HTMLCanvasElement,
    report: EnergyReportPresentation,
    reducedMotion: boolean,
  ): Chart {
    const rows = this.topEnergyRooms(report);
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map((row) => row.roomName.length > 18 ? `${row.roomName.slice(0, 17)}…` : row.roomName),
        datasets: [{
          data: rows.map((row) => row.estimatedKwh ?? 0),
          backgroundColor: rows.map((row) => row.rank === 1 ? '#1d4ed8' : '#67e8f9'),
          hoverBackgroundColor: rows.map((row) => row.rank === 1 ? '#1e40af' : '#22d3ee'),
          borderRadius: 999,
          borderSkipped: false,
          barPercentage: 0.55,
          categoryPercentage: 0.8,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : { duration: 350 },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            backgroundColor: '#0f172a',
            bodyFont: { weight: 600 },
            cornerRadius: 8,
            padding: 10,
            callbacks: {
              title: (items) => rows[items[0]?.dataIndex ?? -1]?.roomName ?? '',
              label: (context) => `${Number(context.parsed.x).toFixed(2)} kWh estimated`,
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            border: { display: false },
            grid: { color: '#dbeafe', drawTicks: false },
            ticks: {
              color: '#64748b',
              maxTicksLimit: 4,
              padding: 8,
              precision: 0,
            },
          },
          y: {
            border: { display: false },
            grid: { display: false },
            ticks: {
              color: '#334155',
              font: { size: 11, weight: 600 },
              padding: 10,
              autoSkip: false,
            },
          },
        },
      },
    });
  }

  private createTrendChart(
    canvas: HTMLCanvasElement,
    report: EnergyReportPresentation,
    reducedMotion: boolean,
  ): Chart {
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: report.trend.map((point) => point.label),
        datasets: [{
          data: report.trend.map((point) => point.estimatedKwh),
          borderColor: '#0284c7',
          backgroundColor: 'rgb(14 165 233 / .1)',
          pointBackgroundColor: '#fff',
          pointBorderColor: '#0284c7',
          pointBorderWidth: 2,
          pointRadius: 0,
          pointHitRadius: 12,
          pointHoverRadius: 4,
          fill: true,
          spanGaps: false,
          tension: .32,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : { duration: 350 },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            backgroundColor: '#0f172a',
            bodyFont: { weight: 600 },
            cornerRadius: 8,
            padding: 10,
            intersect: false,
            mode: 'index',
            callbacks: {
              label: (context) => context.parsed.y === null
                ? 'No recorded value'
                : `${context.parsed.y.toFixed(2)} kWh estimated`,
            },
          },
        },
        scales: {
          x: {
            border: { display: false },
            grid: { display: false },
            ticks: {
              color: '#64748b',
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 5,
              padding: 8,
            },
          },
          y: {
            beginAtZero: true,
            border: { display: false },
            grid: { color: '#dbeafe', drawTicks: false },
            ticks: {
              color: '#64748b',
              maxTicksLimit: 4,
              padding: 8,
              precision: 0,
            },
          },
        },
      },
    });
  }
}
