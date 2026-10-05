import {
  Component,
  Input,
  OnChanges,
  OnDestroy,
  AfterViewInit,
  ViewChild,
  ElementRef,
  ChangeDetectionStrategy,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  Chart,
  BarController,
  BarElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
} from 'chart.js';

import { Room } from '../../../models/room.model';
import { EnergyDaily } from '../../../models/energy.model';
import {
  getTodayKey,
  getLast7DayKeys,
  getLast5YearKeys,
  sumKwhByDateForDevice,
  sumKwhByWeekForDevice,
  sumKwhByMonthForDevice,
  sumKwhByYearForDevice,
} from '../../../services/energy-report.service';
import { buildEnergyRoomEntries, groupEnergyByRoom } from '../../../helpers/room-energy.helper';

Chart.register(BarController, BarElement, LinearScale, CategoryScale, Tooltip, Legend);


type FilterMode = 'daily' | 'weekly' | 'monthly' | 'yearly';

const BAR_PALETTE = [
  '#06b6d4',
  '#0284c7',
  '#2563eb', 
  '#3b82f6', 
  '#4f46e5', 
  '#1d4ed8', 
  '#1e40af',
  '#0f172a', 
];

const BAR_PALETTE_HOVER = [
  '#0891b2',
  '#0369a1', 
  '#1d4ed8', 
  '#2563eb', 
  '#4338ca', 
  '#1e40af', 
  '#172554', 
  '#020617', 
];

@Component({
  selector: 'app-energy-room-widget',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './energy-room-widget.html',
  styleUrl: './energy-room-widget.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnergyRoomWidget implements AfterViewInit, OnChanges, OnDestroy {
  @Input() energyData: Record<string, Record<string, EnergyDaily>> = {};
  @Input() rooms: Room[] = [];
  /**
   * `'active'` (dashboard): one bar per active room. `'all'` (Energy Reports): also inactive,
   * deleted and unassigned rows that used energy. Energy is attributed by each entry's roomUid.
   */
  @Input() mode: 'active' | 'all' = 'active';

  @ViewChild('roomChartCanvas') roomChartCanvas!: ElementRef<HTMLCanvasElement>;

  filterMode: FilterMode = 'daily';
  private roomChart: Chart | null = null;
  private isViewInit = false;


  private readonly filterIndex: Record<FilterMode, number> = {
    daily: 0,
    weekly: 1,
    monthly: 2,
    yearly: 3,
  };

  ngAfterViewInit(): void {
    this.isViewInit = true;
    this.buildChart();
    this.tryRender();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.isViewInit && (changes['energyData'] || changes['rooms'] || changes['mode'])) {
      this.tryRender();
    }
  }

  ngOnDestroy(): void {
    this.roomChart?.destroy();
  }

  setFilter(mode: FilterMode): void {
    if (this.filterMode === mode) return;
    this.filterMode = mode;
    this.refreshChart();
  }

  get filterBadgeLabel(): string {
    if (this.filterMode === 'daily') return 'Today';
    if (this.filterMode === 'weekly') return 'Last 7 Days';
    if (this.filterMode === 'monthly') return 'This Month';
    return 'Last 5 Years'; 
  }


  get sliderTranslate(): string {
    return `translateX(${this.filterIndex[this.filterMode] * 100}%)`;
  }

  private buildChart(): void {
    const ctx = this.roomChartCanvas?.nativeElement?.getContext('2d');
    if (ctx && !this.roomChart) {
      this.roomChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [
            {
              data: [],
              backgroundColor: [],
              hoverBackgroundColor: [],
              borderRadius: 50,
              borderSkipped: false,
              categoryPercentage: 0.55,
              barPercentage: 1.0,
              maxBarThickness: 52,
              minBarLength: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: {
            duration: 700,
            easing: 'easeOutQuart',
            delay: (context) => context.dataIndex * 80,
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1e293b',
              padding: 12,
              cornerRadius: 8,
              displayColors: false,
              callbacks: {
                label: (ctx) => `Usage: ${Number(ctx.parsed.y).toFixed(3)} kWh`,
              },
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              border: { display: false },
              grid: { color: '#f1f5f9' },
              ticks: {
                font: { size: 10 },
                color: '#64748b',
                callback: (v) => `${v} kWh`,
              },
            },
            x: {
              border: { display: false },
              grid: { display: false },
              ticks: { font: { size: 10 }, color: '#64748b', autoSkip: false, maxRotation: 45 },
            },
          },
        },
      });
    }
  }

  private tryRender(): void {
    if (!this.roomChart) return;
    this.refreshChart();
  }

  private refreshChart(): void {
    if (!this.roomChart) return;

    // Built here (not in a getter or template) so change detection never re-triggers chart updates.
    const index = groupEnergyByRoom(this.energyData, this.rooms);
    const entries = buildEnergyRoomEntries(this.rooms, index, this.mode);
    const energy = index.energy;
    const labels = entries.map((entry) => entry.label);
    let values: number[];

    if (this.filterMode === 'daily') {
      const today = getTodayKey();
      values = entries.map((entry) => sumKwhByDateForDevice(energy, entry.key, today));
    } else if (this.filterMode === 'weekly') {
      const days = getLast7DayKeys();
      const start = days[0];
      const end = days[days.length - 1];
      values = entries.map((entry) => sumKwhByWeekForDevice(energy, entry.key, start, end));
    } else if (this.filterMode === 'monthly') {
      const monthKey = getTodayKey().slice(0, 7);
      values = entries.map((entry) => sumKwhByMonthForDevice(energy, entry.key, monthKey));
    } else {
      const years = getLast5YearKeys();
      values = entries.map((entry) =>
        years.reduce((sum, y) => sum + sumKwhByYearForDevice(energy, entry.key, y), 0)
      );
    }
    values = values.map((value) => parseFloat(value.toFixed(4)));

    const colors = labels.map((_, i) => BAR_PALETTE[i % BAR_PALETTE.length]);
    const hoverColors = labels.map((_, i) => BAR_PALETTE_HOVER[i % BAR_PALETTE_HOVER.length]);

    this.roomChart.data.labels = labels;
    this.roomChart.data.datasets[0].data = values;
    this.roomChart.data.datasets[0].backgroundColor = colors;
    this.roomChart.data.datasets[0].hoverBackgroundColor = hoverColors;
    this.roomChart.update();
  }
}