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
  BarController,
  BarElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
} from 'chart.js';

import { RoomService } from '../../services/room.service';
import {
  EnergyReportService,
  getTodayKey,

} from '../../services/energy-report.service';
import { Room } from '../../models/room.model';
import { EnergyDaily } from '../../models/energy.model';
import { EnergyTrendWidget } from '../../components/energy-trend-widget/energy-trend-widget';
Chart.register(
  BarController,
  BarElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend
);


@Component({
  selector: 'app-energy-reports',
  standalone: true,
  imports: [CommonModule, EnergyTrendWidget],
  templateUrl: './energy-reports.html',
  styleUrl: './energy-reports.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnergyReports implements OnInit, AfterViewInit, OnDestroy {

  @ViewChild('roomChartCanvas') roomChartCanvas!: ElementRef<HTMLCanvasElement>;


  isLoading = true;

  totalKwhDisplay = '0.00';
  totalRuntimeDisplay = '0m';
  activeRoomsCount = 0;
  currentMonthLabel = '';


  private roomChart: Chart | null = null;

  private rooms: Room[] = [];
  energyData: Record<string, Record<string, EnergyDaily>> = {};

  private energyLoaded = false;

  private unsubEnergy: (() => void) | null = null;
  private unsubRooms: (() => void) | null = null;

  constructor(
    private roomService: RoomService,
    private energyService: EnergyReportService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit(): void {
    this.currentMonthLabel = new Date().toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Manila',
    });

    this.unsubRooms = this.roomService.streamRooms((rooms) => {
      this.rooms = rooms.filter((r) => r.status === 'active');
      this.activeRoomsCount = this.rooms.length;
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

    this.roomChart?.destroy();
  }



  private buildChartInstances(): void {


    const roomCtx = this.roomChartCanvas?.nativeElement?.getContext('2d');
    if (roomCtx && !this.roomChart) {
      this.roomChart = new Chart(roomCtx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [
            {
              data: [],
              backgroundColor: '#3b82f6',
              hoverBackgroundColor: '#2563eb',
              borderRadius: 4,
              barThickness: 24,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 800, easing: 'easeOutQuart' },
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
              ticks: {
                font: { size: 10 },
                color: '#64748b'
              },
            },
          },
        },
      });
    }
  }

  private tryRender(): void {

    if (!this.roomChart || !this.energyLoaded) return;
    this.refreshRoomChart();
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