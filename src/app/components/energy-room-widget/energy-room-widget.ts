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

import { Room } from '../../models/room.model';
import { EnergyDaily } from '../../models/energy.model';
import { getTodayKey } from '../../services/energy-report.service';


Chart.register(BarController, BarElement, LinearScale, CategoryScale, Tooltip, Legend);

type FilterMode = 'daily' | 'weekly' | 'monthly';

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

  @ViewChild('roomChartCanvas') roomChartCanvas!: ElementRef<HTMLCanvasElement>;

  private roomChart: Chart | null = null;
  private isViewInit = false;

  ngAfterViewInit(): void {
    this.isViewInit = true;
    this.buildChart();
    this.tryRender();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.isViewInit && (changes['energyData'] || changes['rooms'])) {
      this.tryRender();
    }
  }

  ngOnDestroy(): void {
    this.roomChart?.destroy();
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
              ticks: { font: { size: 10 }, color: '#64748b' },
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
}