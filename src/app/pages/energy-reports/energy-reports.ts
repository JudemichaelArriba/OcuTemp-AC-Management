import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';



import { RoomService } from '../../services/room.service';
import {
  EnergyReportService,
  getTodayKey,
} from '../../services/energy-report.service';
import { Room } from '../../models/room.model';
import { EnergyDaily } from '../../models/energy.model';
import { EnergyTrendWidget } from '../../components/energy-trend-widget/energy-trend-widget';
import { EnergyRoomWidget } from '../../components/energy-room-widget/energy-room-widget';


@Component({
  selector: 'app-energy-reports',
  standalone: true,
  imports: [CommonModule, EnergyTrendWidget, EnergyRoomWidget],
  templateUrl: './energy-reports.html',
  styleUrl: './energy-reports.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EnergyReports implements OnInit, OnDestroy {


  isLoading = true;

  totalKwhDisplay = '0.00';
  totalRuntimeDisplay = '0m';
  activeRoomsCount = 0;
  currentMonthLabel = '';


  rooms: Room[] = [];
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
      this.cdr.markForCheck();
    });

    this.unsubEnergy = this.energyService.AllEnergyDaily((data) => {
      this.energyData = data;
      this.energyLoaded = true;
      this.isLoading = false;
      this.refreshSummaryCards();
      this.cdr.markForCheck();
    });
  }



  ngOnDestroy(): void {
    this.unsubEnergy?.();
    this.unsubRooms?.();
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