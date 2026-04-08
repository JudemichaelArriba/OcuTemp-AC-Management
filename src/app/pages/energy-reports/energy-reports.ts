import {
  Component,
  OnInit,
  OnDestroy,
  AfterViewInit,
  ViewChild,
  ElementRef,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
  Legend,
} from 'chart.js';

import { RoomService } from '../../services/room.service';
import {
  EnergyReportService,
  getTodayKey,
  getLast7DayKeys,
  getLast8WeekRanges,
  getLast12MonthKeys,
  sumKwhByDate,
  sumKwhByWeek,
  sumKwhByMonth,
} from '../../services/energy-report.service';
import { Room } from '../../models/room.model';
import { EnergyDaily } from '../../models/energy.model';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
  Legend
);

type FilterMode = 'daily' | 'weekly' | 'monthly';

@Component({
  selector: 'app-energy-reports',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './energy-reports.html',
  styleUrl: './energy-reports.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnergyReports implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('overallChartCanvas') overallChartCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('roomChartCanvas') roomChartCanvas!: ElementRef<HTMLCanvasElement>;

  filterMode: FilterMode = 'daily';
  isLoading = true;

  totalKwhDisplay = '–';
  totalRuntimeDisplay = '–';
  currentMonthLabel = '';

  private overallChart: Chart | null = null;
  private roomChart: Chart | null = null;

  private rooms: Room[] = [];
  private energyData: Record<string, Record<string, EnergyDaily>> = {};


  private energyLoaded = false;

  private unsubEnergy: (() => void) | null = null;
  private unsubRooms: (() => void) | null = null;

  constructor(
    private roomService: RoomService,
    private energyService: EnergyReportService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.currentMonthLabel = new Date().toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Manila',
    });

    this.unsubRooms = this.roomService.streamRooms((rooms) => {
      this.rooms = rooms.filter((r) => r.status === 'active');
      this.tryRender();
      this.cdr.markForCheck();
    });

    this.unsubEnergy = this.energyService.AllEnergyDaily((data) => {
      this.energyData = data;
      this.energyLoaded = true;
      this.isLoading = false;
      this.refreshSummaryCards();
      this.tryRender();
      this.cdr.markForCheck();
    });
  }

  ngAfterViewInit(): void {

    this.buildChartInstances();

 
    this.tryRender();
  }

  ngOnDestroy(): void {
    this.unsubEnergy?.();
    this.unsubRooms?.();
    this.overallChart?.destroy();
    this.roomChart?.destroy();
  }

  setFilter(mode: FilterMode): void {
    if (this.filterMode === mode) return;
    this.filterMode = mode;
    if (this.overallChart && this.energyLoaded) {
      this.refreshOverallChart();
    }
  }


  private buildChartInstances(): void {
    const overallCtx = this.overallChartCanvas?.nativeElement?.getContext('2d');
    if (overallCtx && !this.overallChart) {
      this.overallChart = new Chart(overallCtx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            {
              data: [],
              borderColor: '#2563EB',
              backgroundColor: 'rgba(37,99,235,0.08)',
              fill: true,
              tension: 0.4,
              pointBackgroundColor: '#2563EB',
              pointRadius: 4,
              pointHoverRadius: 6,
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 600, easing: 'easeInOutQuart' },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => ` ${Number(ctx.parsed.y).toFixed(3)} kWh`,
              },
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              grid: { color: '#f1f5f9' },
              ticks: {
                font: { size: 10 },
                callback: (v) => `${v} kWh`,
              },
            },
            x: {
              grid: { display: false },
              ticks: { font: { size: 10 } },
            },
          },
        },
      });
    }

    const roomCtx = this.roomChartCanvas?.nativeElement?.getContext('2d');
    if (roomCtx && !this.roomChart) {
      this.roomChart = new Chart(roomCtx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [
            {
              data: [],
              backgroundColor: 'rgba(37,99,235,0.8)',
              borderRadius: 6,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 600, easing: 'easeInOutQuart' },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => ` ${Number(ctx.parsed.y).toFixed(3)} kWh`,
              },
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              grid: { color: '#f1f5f9' },
              ticks: {
                font: { size: 10 },
                callback: (v) => `${v} kWh`,
              },
            },
            x: {
              grid: { display: false },
              ticks: { font: { size: 10 } },
            },
          },
        },
      });
    }
  }


  private tryRender(): void {
    if (!this.overallChart || !this.roomChart || !this.energyLoaded) return;
    this.refreshOverallChart();
    this.refreshRoomChart();
  }

  private refreshOverallChart(): void {
    if (!this.overallChart) return;

    let labels: string[] = [];
    let values: number[] = [];

    if (this.filterMode === 'daily') {
      const days = getLast7DayKeys();
      labels = days.map((d) => d.slice(5)); // MM-DD
      values = days.map((d) => sumKwhByDate(this.energyData, d));
    } else if (this.filterMode === 'weekly') {
      const weeks = getLast8WeekRanges();
      labels = weeks.map((w) => w.label);
      values = weeks.map((w) => sumKwhByWeek(this.energyData, w.start, w.end));
    } else {
      const months = getLast12MonthKeys();
      labels = months.map((m) => {
        const [y, mo] = m.split('-');
        return new Date(+y, +mo - 1, 1).toLocaleString('en-US', {
          month: 'short',
          year: '2-digit',
        });
      });
      values = months.map((m) => sumKwhByMonth(this.energyData, m));
    }

    this.overallChart.data.labels = labels;
    this.overallChart.data.datasets[0].data = values.map((v) =>
      parseFloat(v.toFixed(4))
    );
    this.overallChart.update();
  }

  private refreshRoomChart(): void {
    if (!this.roomChart) return;

    const today = getTodayKey();
    const labels: string[] = [];
    const values: number[] = [];

    for (const room of this.rooms) {
      const kwh = this.energyData[room.device]?.[today]?.estimatedKwh ?? 0;
      labels.push(room.roomName);
      values.push(parseFloat(kwh.toFixed(4)));
    }

    this.roomChart.data.labels = labels;
    this.roomChart.data.datasets[0].data = values;
    this.roomChart.update();
  }

  private refreshSummaryCards(): void {
    const today = getTodayKey();
    const monthKey = today.slice(0, 7);

    let totalKwh = 0;
    let totalSec = 0;

    for (const deviceDays of Object.values(this.energyData)) {
      for (const [dateKey, entry] of Object.entries(deviceDays)) {
        if (dateKey.startsWith(monthKey)) {
          totalKwh += entry.estimatedKwh ?? 0;
          totalSec += entry.runtimeSeconds ?? 0;
        }
      }
    }

    this.totalKwhDisplay = totalKwh.toFixed(2);

    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    this.totalRuntimeDisplay = h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
}