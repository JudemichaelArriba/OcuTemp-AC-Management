import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterRenderEffect,
  input,
  signal,
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
  ChatQuestionFocus,
  ClimateSuggestionRow,
  EnergyReportPresentation,
  EnergyRoomDataStatus,
  EnergyRoomRow,
  EnergyTrendPoint,
  RecentEventRow,
  RoomCondition,
  RoomTelemetryRow,
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

type EnergyView = 'summary' | 'rooms' | 'trend' | 'source';
type EnergySort = 'rank' | 'room' | 'energy' | 'share' | 'runtime' | 'status';
type SortDirection = 'asc' | 'desc';

interface EnergyPanelState {
  readonly view: EnergyView;
  readonly query: string;
  readonly sort: EnergySort;
  readonly direction: SortDirection;
  readonly page: number;
}

interface EnergyChartSeries {
  readonly rankingRows: EnergyRoomRow[];
  readonly rankingLabels: string[];
  readonly rankingValues: number[];
  readonly trendLabels: string[];
  readonly trendValues: Array<number | null>;
}

interface EnergyRoomsCache {
  readonly stateKey: string;
  readonly rows: EnergyRoomRow[];
}

interface ScheduleDisplayRow {
  readonly roomName: string;
  readonly day: string | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly subject: string | null;
}

type EnergyChartKind = 'ranking' | 'trend';

const PAGE_SIZE = 20;
const DEFAULT_ENERGY_STATE: EnergyPanelState = {
  view: 'summary',
  query: '',
  sort: 'rank',
  direction: 'asc',
  page: 1,
};

@Component({
  selector: 'app-ocu-guide-report',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './ocu-guide-report.html',
  styleUrl: './ocu-guide-report.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OcuGuideReportComponent implements OnDestroy {
  readonly presentation = input.required<ChatPresentation>();
  readonly displayDirective = input.required<ChatDisplayDirective>();
  readonly questionFocus = input.required<ChatQuestionFocus>();
  readonly evidence = input<ChatEvidenceMetadata>();
  readonly turnId = input.required<string>();

  private readonly reportCharts = viewChildren<ElementRef<HTMLCanvasElement>>('reportChart');
  private readonly energyStates = signal<Record<string, EnergyPanelState>>({});
  private readonly charts: Chart[] = [];
  private readonly chartSeriesCache = new WeakMap<EnergyReportPresentation, EnergyChartSeries>();
  private readonly filteredRoomsCache = new WeakMap<EnergyReportPresentation, EnergyRoomsCache>();
  private readonly observedChartCanvases = new Set<HTMLCanvasElement>();
  private readonly visibleChartCanvases = new Set<HTMLCanvasElement>();
  private chartVisibilityObserver?: IntersectionObserver;
  private destroyed = false;
  private readonly dateTimeFormatter = new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  });

  constructor() {
    afterRenderEffect(() => {
      const presentation = this.presentation();
      const canvases = this.reportCharts();
      this.syncChartObservers(canvases);
      this.rebuildCharts(presentation, canvases);
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.chartVisibilityObserver?.disconnect();
    this.observedChartCanvases.clear();
    this.visibleChartCanvases.clear();
    this.destroyCharts();
  }

  energyState(id: string): EnergyPanelState {
    return this.energyStates()[id] ?? DEFAULT_ENERGY_STATE;
  }

  setEnergyView(id: string, view: EnergyView): void {
    this.patchEnergyState(id, { view });
  }

  updateEnergyQuery(id: string, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    this.patchEnergyState(id, { query: target.value, page: 1 });
  }

  filteredEnergyRooms(report: EnergyReportPresentation): EnergyRoomRow[] {
    const state = this.energyState(report.id);
    const query = state.query.trim().toLocaleLowerCase();
    const stateKey = `${query}\u0000${state.sort}\u0000${state.direction}`;
    const cached = this.filteredRoomsCache.get(report);
    if (cached?.stateKey === stateKey) return cached.rows;
    const candidates = query
      ? report.rooms.filter((row) => row.roomName.toLocaleLowerCase().includes(query))
      : [...report.rooms];

    const rows = candidates
      .map((row, originalIndex) => ({ row, originalIndex }))
      .sort((leftEntry, rightEntry) => {
        const leftMissing = this.isMissingSortValue(leftEntry.row, state.sort);
        const rightMissing = this.isMissingSortValue(rightEntry.row, state.sort);
        if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;

        const comparison = this.compareEnergyRows(leftEntry.row, rightEntry.row, state.sort);
        if (comparison !== 0) {
          return state.direction === 'asc' ? comparison : -comparison;
        }

        const roomComparison = leftEntry.row.roomName.localeCompare(
          rightEntry.row.roomName,
          undefined,
          { numeric: true },
        );
        return roomComparison || leftEntry.originalIndex - rightEntry.originalIndex;
      })
      .map(({ row }) => row);
    this.filteredRoomsCache.set(report, { stateKey, rows });
    return rows;
  }

  pagedEnergyRooms(report: EnergyReportPresentation): EnergyRoomRow[] {
    const rows = this.filteredEnergyRooms(report);
    const page = Math.min(this.energyState(report.id).page, this.energyTotalPages(report));
    return rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }

  energyTotalPages(report: EnergyReportPresentation): number {
    return Math.max(1, Math.ceil(this.filteredEnergyRooms(report).length / PAGE_SIZE));
  }

  energyPage(report: EnergyReportPresentation): number {
    return Math.min(this.energyState(report.id).page, this.energyTotalPages(report));
  }

  energyShowingStart(report: EnergyReportPresentation): number {
    const total = this.filteredEnergyRooms(report).length;
    return total === 0 ? 0 : (this.energyPage(report) - 1) * PAGE_SIZE + 1;
  }

  energyShowingEnd(report: EnergyReportPresentation): number {
    return Math.min(this.energyPage(report) * PAGE_SIZE, this.filteredEnergyRooms(report).length);
  }

  setEnergyPage(report: EnergyReportPresentation, page: number): void {
    const nextPage = Math.max(1, Math.min(page, this.energyTotalPages(report)));
    this.patchEnergyState(report.id, { page: nextPage });
  }

  recordedEnergyRooms(report: EnergyReportPresentation): EnergyRoomRow[] {
    return report.rooms.filter((row) => row.status === 'recorded' && row.estimatedKwh !== null);
  }

  recordedTrendPoints(report: EnergyReportPresentation): EnergyTrendPoint[] {
    return report.trend.filter((point) => point.estimatedKwh !== null);
  }

  scheduleRows(presentation: Extract<ChatPresentation, { readonly kind: 'room-telemetry' }>): ScheduleDisplayRow[] {
    return presentation.rooms.flatMap<ScheduleDisplayRow>((room) => (
      room.schedules.length > 0
        ? room.schedules.map((schedule) => ({ roomName: room.roomName, ...schedule }))
        : [{
            roomName: room.roomName,
            day: null,
            startTime: null,
            endTime: null,
            subject: null,
          }]
    ));
  }

  telemetryRowsForDisplay(
    presentation: Extract<ChatPresentation, { readonly kind: 'room-telemetry' }>,
  ): RoomTelemetryRow[] {
    switch (this.questionFocus()) {
      case 'current_temperature':
        return presentation.rooms.filter((room) => (
          room.measurementStatus === 'current' && room.temperature !== null
        ));
      case 'last_known_temperature':
        return presentation.rooms.filter((room) => room.temperature !== null);
      case 'current_humidity':
        return presentation.rooms.filter((room) => (
          room.measurementStatus === 'current' && room.humidity !== null
        ));
      case 'current_condition':
        return presentation.rooms.filter((room) => (
          room.measurementStatus === 'current' && room.condition !== 'unknown'
        ));
      case 'ac_power_status':
        return presentation.rooms.filter((room) => (
          room.measurementStatus === 'current' && room.acPower !== null
        ));
      case 'ai_auto_apply_status':
        return [...presentation.rooms].sort((left, right) => (
          Number(left.aiAutoApply === null) - Number(right.aiAutoApply === null)
        ));
      default:
        return presentation.rooms;
    }
  }

  telemetryMetricLabel(): string {
    switch (this.questionFocus()) {
      case 'current_temperature': return 'Current temperature';
      case 'last_known_temperature': return 'Latest / last-known temperature';
      case 'current_humidity': return 'Current humidity';
      case 'current_condition': return 'Current condition';
      case 'device_status': return 'Device status';
      case 'ac_power_status': return 'AC power';
      case 'ai_auto_apply_status': return 'AI auto-apply';
      default: return 'Verified state';
    }
  }

  telemetryMetricValue(row: RoomTelemetryRow): string {
    switch (this.questionFocus()) {
      case 'current_temperature':
      case 'last_known_temperature':
        return row.temperature === null ? 'Not reported' : `${row.temperature.toFixed(1)} °C`;
      case 'current_humidity':
        return row.humidity === null ? 'Not reported' : `${row.humidity.toFixed(1)}%`;
      case 'current_condition':
        return this.conditionLabel(row.condition);
      case 'device_status':
        if (row.deviceAssignmentStatus === 'not_assigned') return 'No assigned device';
        if (row.deviceAssignmentStatus === 'unavailable') return 'Device data unavailable';
        return `${row.onlineState.charAt(0).toUpperCase()}${row.onlineState.slice(1)}`;
      case 'ac_power_status':
        return row.acPower === null ? 'Not reported' : (row.acPower ? 'On' : 'Off');
      case 'ai_auto_apply_status':
        return row.aiAutoApply === null ? 'Not reported' : (row.aiAutoApply ? 'Enabled' : 'Disabled');
      default:
        return this.measurementStatusLabel(row);
    }
  }

  telemetryContextLabel(): string {
    if (this.questionFocus() === 'ai_auto_apply_status') return 'Device connection';
    return this.questionFocus() === 'last_known_temperature' ? 'Reading freshness' : 'Reading status';
  }

  telemetryContextValue(row: RoomTelemetryRow): string {
    if (this.questionFocus() !== 'ai_auto_apply_status') return this.measurementStatusLabel(row);
    if (row.deviceAssignmentStatus === 'not_assigned') return 'No assigned device';
    if (row.deviceAssignmentStatus === 'unavailable') return 'Device data unavailable';
    return row.onlineState === 'unknown'
      ? 'Not available'
      : `${row.onlineState.charAt(0).toUpperCase()}${row.onlineState.slice(1)}`;
  }

  scheduleDisplayTrackKey(row: ScheduleDisplayRow, index: number): string {
    return [row.roomName, row.day ?? '', row.startTime ?? '', row.endTime ?? '', row.subject ?? '', index].join('\u0000');
  }

  topEnergyRooms(report: EnergyReportPresentation): EnergyRoomRow[] {
    return this.energyChartSeries(report).rankingRows;
  }

  rankingChartHeight(report: EnergyReportPresentation): number {
    return Math.max(240, Math.min(4_800, this.recordedEnergyRooms(report).length * 28 + 56));
  }

  coveragePercent(report: EnergyReportPresentation): number {
    if (report.metrics.activeRooms === 0) return 0;
    return (report.metrics.roomsWithRecords / report.metrics.activeRooms) * 100;
  }

  temporalCoveragePercent(report: EnergyReportPresentation): number {
    return report.metrics.dataCoveragePercent;
  }

  formatRuntime(seconds: number | null): string {
    if (seconds === null) return '—';
    if (seconds > 0 && seconds < 60) return '<1m';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours === 0) return `${minutes}m`;
    return `${hours}h ${minutes}m`;
  }

  formatDateTime(value: string | null): string {
    if (!value) return 'Not reported';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : this.dateTimeFormatter.format(date);
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

  climateStatusLabel(status: ClimateSuggestionRow['status']): string {
    const labels: Record<ClimateSuggestionRow['status'], string> = {
      available: 'Suggestion available',
      no_suggestion: 'No suggestion',
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

  climateActionLabel(row: ClimateSuggestionRow): string {
    if (row.status !== 'available') return this.climateStatusLabel(row.status);
    if (row.applied === true) return 'Applied';
    if (row.autoApplyEnabled === true) return 'Auto-apply on';
    if (row.applied === false && row.autoApplyEnabled === false) return 'Review';
    return 'Not reported';
  }

  climateActionClass(row: ClimateSuggestionRow): string {
    if (row.status !== 'available' || row.applied === null || row.autoApplyEnabled === null) {
      return 'bg-slate-100 text-slate-600';
    }
    if (row.applied) return 'bg-emerald-50 text-emerald-700';
    if (row.autoApplyEnabled) return 'bg-blue-50 text-blue-700';
    return 'bg-amber-50 text-amber-800';
  }

  helpTopicLabel(topic: string): string {
    if (topic === 'ocu-guide') return 'OcuGuide';
    const words = topic.split('-').map((word) => word.trim()).filter(Boolean);
    if (words.length === 0) return 'OcuTemp help';
    return words
      .map((word) => `${word.charAt(0).toLocaleUpperCase('en-US')}${word.slice(1)}`)
      .join(' ');
  }

  presentationDomId(prefix: string, presentationId: string): string {
    return `${prefix}-${this.turnId()}-${presentationId}`.replace(/[^A-Za-z0-9_-]/g, '-');
  }

  eventTrackKey(event: RecentEventRow, index: number): string {
    return [
      event.updatedAt,
      event.roomName,
      event.eventType,
      event.mode ?? '',
      index,
    ].join('\u0000');
  }

  trendTrackKey(point: EnergyTrendPoint): string {
    return `${point.start}\u0000${point.end}\u0000${point.label}`;
  }

  scheduleTrackKey(
    schedule: RoomTelemetryRow['schedules'][number],
    index: number,
  ): string {
    return [schedule.day, schedule.startTime, schedule.endTime, schedule.subject, index].join('\u0000');
  }

  private patchEnergyState(id: string, patch: Partial<EnergyPanelState>): void {
    this.energyStates.update((states) => ({
      ...states,
      [id]: { ...DEFAULT_ENERGY_STATE, ...states[id], ...patch },
    }));
  }

  private compareEnergyRows(left: EnergyRoomRow, right: EnergyRoomRow, sort: EnergySort): number {
    switch (sort) {
      case 'room':
        return left.roomName.localeCompare(right.roomName, undefined, { numeric: true });
      case 'energy':
        return this.compareNullableNumbers(left.estimatedKwh, right.estimatedKwh);
      case 'share':
        return this.compareNullableNumbers(left.sharePercent, right.sharePercent);
      case 'runtime':
        return this.compareNullableNumbers(left.runtimeSeconds, right.runtimeSeconds);
      case 'status':
        return left.status.localeCompare(right.status);
      case 'rank':
        return this.compareNullableNumbers(left.rank, right.rank);
    }
  }

  private compareNullableNumbers(left: number | null, right: number | null): number {
    if (left === null || right === null) return 0;
    return left - right;
  }

  private isMissingSortValue(row: EnergyRoomRow, sort: EnergySort): boolean {
    switch (sort) {
      case 'rank': return row.rank === null;
      case 'energy': return row.estimatedKwh === null;
      case 'share': return row.sharePercent === null;
      case 'runtime': return row.runtimeSeconds === null;
      case 'status': return row.status !== 'recorded';
      case 'room':
        return false;
    }
  }

  private rebuildCharts(
    presentation: ChatPresentation,
    canvases: readonly ElementRef<HTMLCanvasElement>[],
  ): void {
    this.destroyCharts();
    const report = presentation.kind === 'energy-report'
      && presentation.availability === 'available'
      ? presentation
      : null;
    const reducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    for (const canvasRef of canvases) {
      const canvas = canvasRef.nativeElement;
      if (!this.visibleChartCanvases.has(canvas)) continue;
      if (canvas.dataset['presentationId'] !== report?.id) continue;
      const kind = canvas.dataset['chartKind'] as EnergyChartKind | undefined;
      if (!report || !kind) continue;
      this.charts.push(kind === 'ranking'
        ? this.createRankingChart(canvas, report, reducedMotion)
        : this.createTrendChart(canvas, report, reducedMotion));
    }
  }

  private createRankingChart(
    canvas: HTMLCanvasElement,
    report: EnergyReportPresentation,
    reducedMotion: boolean,
  ): Chart {
    const series = this.energyChartSeries(report);
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: series.rankingLabels,
        datasets: [{
          data: series.rankingValues,
          backgroundColor: series.rankingRows.map((row) => row.rank === 1 ? '#1d4ed8' : '#93c5fd'),
          borderRadius: 7,
          borderSkipped: false,
          barThickness: 14,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : { duration: 450 },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            backgroundColor: '#0f172a',
            padding: 10,
            callbacks: { label: (context) => `${Number(context.parsed.x).toFixed(2)} kWh estimated` },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            border: { display: false },
            grid: { color: '#e2e8f0' },
            ticks: { color: '#64748b', callback: (value) => `${value} kWh` },
          },
          y: {
            border: { display: false },
            grid: { display: false },
            ticks: { color: '#334155', font: { weight: 600 } },
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
    const series = this.energyChartSeries(report);
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: series.trendLabels,
        datasets: [{
          data: series.trendValues,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.10)',
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#2563eb',
          pointBorderWidth: 2,
          pointRadius: report.trend.length > 30 ? 0 : 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          fill: true,
          spanGaps: false,
          tension: 0.28,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : { duration: 450 },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            backgroundColor: '#0f172a',
            padding: 10,
            callbacks: {
              label: (context) => context.parsed.y === null
                ? 'No recorded data'
                : `${Number(context.parsed.y).toFixed(2)} kWh estimated`,
            },
          },
        },
        scales: {
          x: {
            border: { display: false },
            grid: { display: false },
            ticks: { color: '#64748b', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
          },
          y: {
            beginAtZero: true,
            border: { display: false },
            grid: { color: '#e2e8f0' },
            ticks: { color: '#64748b', callback: (value) => `${value} kWh` },
          },
        },
      },
    });
  }

  private destroyCharts(): void {
    for (const chart of this.charts.splice(0)) chart.destroy();
  }

  private syncChartObservers(canvases: readonly ElementRef<HTMLCanvasElement>[]): void {
    const currentCanvases = new Set(canvases.map((canvasRef) => canvasRef.nativeElement));
    for (const canvas of this.observedChartCanvases) {
      if (currentCanvases.has(canvas)) continue;
      this.chartVisibilityObserver?.unobserve(canvas);
      this.observedChartCanvases.delete(canvas);
      this.visibleChartCanvases.delete(canvas);
    }

    if (typeof IntersectionObserver === 'undefined') {
      this.visibleChartCanvases.clear();
      for (const canvas of currentCanvases) this.visibleChartCanvases.add(canvas);
      return;
    }

    const observer = this.chartVisibilityObserver ??= new IntersectionObserver((entries) => {
      if (this.destroyed) return;
      const renderedCanvases = new Set(
        this.reportCharts().map((canvasRef) => canvasRef.nativeElement),
      );
      for (const entry of entries) {
        const canvas = entry.target;
        if (!(canvas instanceof HTMLCanvasElement) || !renderedCanvases.has(canvas)) continue;
        if (entry.isIntersecting) this.visibleChartCanvases.add(canvas);
        else this.visibleChartCanvases.delete(canvas);
      }
      this.rebuildCharts(this.presentation(), this.reportCharts());
    }, { rootMargin: '240px 0px' });

    for (const canvas of currentCanvases) {
      if (this.observedChartCanvases.has(canvas)) continue;
      this.observedChartCanvases.add(canvas);
      observer.observe(canvas);
    }
  }

  private energyChartSeries(report: EnergyReportPresentation): EnergyChartSeries {
    const cached = this.chartSeriesCache.get(report);
    if (cached) return cached;

    const rankingRows = this.recordedEnergyRooms(report)
      .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) -
        (right.rank ?? Number.MAX_SAFE_INTEGER) || left.roomName.localeCompare(right.roomName));
    const series: EnergyChartSeries = {
      rankingRows,
      rankingLabels: rankingRows.map((row) => row.roomName),
      rankingValues: rankingRows.map((row) => row.estimatedKwh ?? 0),
      trendLabels: report.trend.map((point) => point.label),
      trendValues: report.trend.map((point) => point.estimatedKwh),
    };
    this.chartSeriesCache.set(report, series);
    return series;
  }
}
