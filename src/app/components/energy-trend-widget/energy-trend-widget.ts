import {
  Component,
  Input,
  OnChanges,
  OnDestroy,
  AfterViewInit,
  ViewChild,
  ElementRef,
  ChangeDetectionStrategy,
  SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
  Legend,
} from 'chart.js';

import { EnergyDaily } from '../../models/energy.model';
import {
  getTodayKey,
  getLast7DayKeys,
  getLast8WeekRanges,
  getLast12MonthKeys,
  sumKwhByDate,
  sumKwhByWeek,
  sumKwhByMonth,
} from '../../services/energy-report.service';

Chart.register(
  LineController, LineElement, PointElement,
  LinearScale, CategoryScale, Tooltip, Filler, Legend
);

type FilterMode = 'daily' | 'weekly' | 'monthly';

@Component({
  selector: 'app-energy-trend-widget',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './energy-trend-widget.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnergyTrendWidget implements OnChanges, AfterViewInit, OnDestroy {
  @Input() energyData: Record<string, Record<string, EnergyDaily>> = {};

  @ViewChild('overallChartCanvas') overallChartCanvas!: ElementRef<HTMLCanvasElement>;

  filterMode: FilterMode = 'daily';
  private overallChart: Chart | null = null;
  private isViewInit = false;

  ngAfterViewInit(): void {
    this.isViewInit = true;
    this.buildChartInstances();
    this.tryRender();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.isViewInit && changes['energyData']) {
      this.tryRender();
    }
  }

  ngOnDestroy(): void {
    this.overallChart?.destroy();
  }

  setFilter(mode: FilterMode): void {
    if (this.filterMode === mode) return;
    this.filterMode = mode;
    this.refreshOverallChart();
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
              pointRadius: 3,
              pointHoverRadius: 5,
              borderWidth: 2.5,
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
              titleFont: { size: 12, weight: 'bold' },
              bodyFont: { size: 12 },
              cornerRadius: 8,
              displayColors: false,
              callbacks: {
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
              border: { display: false },
              grid: { display: false },
              ticks: {
                font: { size: 10, family: 'Inter' },
                color: '#64748b',
                padding: 10
              },
            },
          },
        },
      });
    }
  }

  private tryRender(): void {
    if (!this.overallChart) return;
    this.refreshOverallChart();
  }

  private formatShortDate(dateStr: string): string {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const [y, m, d] = parts;
    return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  private refreshOverallChart(): void {
    if (!this.overallChart) return;
    let labels: string[] = [];
    let values: number[] = [];

    if (this.filterMode === 'daily') {
      const days = getLast7DayKeys();
      labels = days.map((d) => d.slice(5));
      values = days.map((d) => sumKwhByDate(this.energyData, d));
    } else if (this.filterMode === 'weekly') {
      const weeks = getLast8WeekRanges();
      labels = weeks.map((w) => `${this.formatShortDate(w.start)} - ${this.formatShortDate(w.end)}`);
      values = weeks.map((w) => sumKwhByWeek(this.energyData, w.start, w.end));
    } else {
      const months = getLast12MonthKeys();
      labels = months.map((m) => {
        const [y, mo] = m.split('-');
        return new Date(+y, +mo - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
      });
      values = months.map((m) => sumKwhByMonth(this.energyData, m));
    }

    this.overallChart.data.labels = labels;
    this.overallChart.data.datasets[0].data = values.map((v) => parseFloat(v.toFixed(4)));
    this.overallChart.update();
  }
}