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
  ChatPresentation,
  ChatTurnResponse,
  ClimateSuggestionRow,
  EnergyReportPresentation,
  EnergyRoomDataStatus,
  EnergyRoomRow,
  RoomCondition,
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
  readonly response = input.required<ChatTurnResponse>();

  private readonly reportCharts = viewChildren<ElementRef<HTMLCanvasElement>>('reportChart');
  private readonly energyStates = signal<Record<string, EnergyPanelState>>({});
  private readonly charts: Chart[] = [];
  private readonly dateTimeFormatter = new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  });

  constructor() {
    afterRenderEffect(() => {
      const response = this.response();
      const canvases = this.reportCharts();
      this.rebuildCharts(response.presentations, canvases);
    });
  }

  ngOnDestroy(): void {
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

  toggleEnergySort(id: string, sort: EnergySort): void {
    const current = this.energyState(id);
    const direction: SortDirection = current.sort === sort
      ? (current.direction === 'asc' ? 'desc' : 'asc')
      : (sort === 'room' || sort === 'status' ? 'asc' : 'desc');
    this.patchEnergyState(id, { sort, direction, page: 1 });
  }

  sortLabel(id: string, sort: EnergySort): string {
    const current = this.energyState(id);
    if (current.sort !== sort) return 'Not sorted';
    return current.direction === 'asc' ? 'Sorted ascending' : 'Sorted descending';
  }

  sortIcon(id: string, sort: EnergySort): string {
    const current = this.energyState(id);
    if (current.sort !== sort) return 'unfold_more';
    return current.direction === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }

  filteredEnergyRooms(report: EnergyReportPresentation): EnergyRoomRow[] {
    const state = this.energyState(report.id);
    const query = state.query.trim().toLocaleLowerCase();
    const rows = query
      ? report.rooms.filter((row) => row.roomName.toLocaleLowerCase().includes(query))
      : [...report.rooms];

    return rows.sort((left, right) => {
      const comparison = this.compareEnergyRows(left, right, state.sort);
      return state.direction === 'asc' ? comparison : -comparison;
    });
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

  topEnergyRooms(report: EnergyReportPresentation): EnergyRoomRow[] {
    return this.recordedEnergyRooms(report)
      .sort((left, right) => (right.estimatedKwh ?? 0) - (left.estimatedKwh ?? 0))
      .slice(0, 10);
  }

  coveragePercent(report: EnergyReportPresentation): number {
    if (report.metrics.activeRooms === 0) return 0;
    return (report.metrics.roomsWithRecords / report.metrics.activeRooms) * 100;
  }

  climateDelta(row: ClimateSuggestionRow): number | null {
    if (row.currentRoomTemp === null || row.suggestedTemp === null) return null;
    return row.suggestedTemp - row.currentRoomTemp;
  }

  formatDelta(row: ClimateSuggestionRow): string {
    const delta = this.climateDelta(row);
    if (delta === null) return 'Not available';
    if (delta === 0) return 'No change';
    return `${delta > 0 ? '+' : ''}${delta.toFixed(1)} °C`;
  }

  formatRuntime(seconds: number | null): string {
    if (seconds === null) return '—';
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

  conditionLabel(condition: RoomCondition): string {
    return condition === 'unknown'
      ? 'Unknown'
      : `${condition.charAt(0).toUpperCase()}${condition.slice(1)}`;
  }

  trackPresentation(_: number, presentation: ChatPresentation): string {
    return presentation.id;
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
        return this.compareNullableNumbers(left.rank, right.rank, true);
    }
  }

  private compareNullableNumbers(
    left: number | null,
    right: number | null,
    nullsLast = false,
  ): number {
    if (left === null && right === null) return 0;
    if (left === null) return nullsLast ? 1 : -1;
    if (right === null) return nullsLast ? -1 : 1;
    return left - right;
  }

  private rebuildCharts(
    presentations: readonly ChatPresentation[],
    canvases: readonly ElementRef<HTMLCanvasElement>[],
  ): void {
    this.destroyCharts();
    const energyReports = presentations.filter(
      (presentation): presentation is EnergyReportPresentation => presentation.kind === 'energy-report',
    );
    const reducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    energyReports.forEach((report, index) => {
      const rankingCanvas = canvases[index * 2]?.nativeElement;
      const trendCanvas = canvases[index * 2 + 1]?.nativeElement;
      if (rankingCanvas) this.charts.push(this.createRankingChart(rankingCanvas, report, reducedMotion));
      if (trendCanvas) this.charts.push(this.createTrendChart(trendCanvas, report, reducedMotion));
    });
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
        labels: rows.map((row) => row.roomName),
        datasets: [{
          data: rows.map((row) => row.estimatedKwh ?? 0),
          backgroundColor: rows.map((_, index) => index === 0 ? '#1d4ed8' : '#93c5fd'),
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
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: report.trend.map((point) => point.label),
        datasets: [{
          data: report.trend.map((point) => point.estimatedKwh),
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.10)',
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#2563eb',
          pointBorderWidth: 2,
          pointRadius: report.trend.length > 30 ? 0 : 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          fill: true,
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
            callbacks: { label: (context) => `${Number(context.parsed.y).toFixed(2)} kWh estimated` },
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
}
