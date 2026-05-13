import {
  Component, OnDestroy, OnInit,
  ChangeDetectionStrategy, ChangeDetectorRef
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Room } from '../../models/room.model';
import { RoomService } from '../../services/room.service';
import { DeviceService } from '../../services/device.service';
import { Device } from '../../models/esp.model';
import { EnergyReportService, getTodayKey, sumKwhByDate } from '../../services/energy-report.service';
import { RoomCard } from '../../components/room-card/room-card';
import { mergeRoomsWithTelemetry } from '../../helpers/room-telemetry';
import { FloorPlanComponent } from '../../components/floor-plan/floor-plan';
import { EnergyTrendWidget } from '../../components/energy-trend-widget/energy-trend-widget';
import { EnergyDaily } from '../../models/energy.model';
import { LogsModal } from '../../components/logs-modal/logs-modal';
import { LogsCard } from '../../components/logs-card/logs-card';
import { LogsDetailsModal } from '../../components/logs-details-modal/logs-details-modal';
import { LogService } from '../../services/logs.service';
import { DecisionLog } from '../../models/logs.model';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RoomCard, DecimalPipe, FloorPlanComponent, EnergyTrendWidget, LogsModal, LogsCard, LogsDetailsModal],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard implements OnInit, OnDestroy {

  isEnergyReady = false;
  isDevicesReady = false;
  get isReady(): boolean { return this.isEnergyReady && this.isDevicesReady; }

  useFadeIn = false;

  rooms: Room[] = [];
  viewMode: 'cards' | 'map' = 'cards';
  selectedMapRoom: Room | undefined;
  totalRooms = 0;
  rawEnergyData: Record<string, Record<string, EnergyDaily>> = {};

  totalEnergyToday = 0;
  avgTemperature = 0;
  occupiedZones = 0;
  activeOverrides = 0;

  private baseRooms: Room[] = [];
  private deviceMap: Record<string, Device> = {};

  recentLogs: DecisionLog[] = [];
  isLogsModalOpen = false;
  selectedDashboardLog: DecisionLog | null = null;
  isDashboardLogDetailsOpen = false;

  private stopRoomStream?: () => void;
  private stopDevicesStream?: () => void;
  private stopEnergyStream?: () => void;
  private stopLogsStream?: () => void;

  constructor(
    private roomService: RoomService,
    private deviceService: DeviceService,
    private energyService: EnergyReportService,
    private logService: LogService,
    private cdr: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    if (!sessionStorage.getItem('dashboard_animated')) {
      this.useFadeIn = true;
      sessionStorage.setItem('dashboard_animated', 'true');
    }

    this.stopEnergyStream = this.energyService.AllEnergyDaily((energyData) => {
      this.rawEnergyData = energyData;
      const today = getTodayKey();
      this.totalEnergyToday = sumKwhByDate(energyData, today);
      this.isEnergyReady = true;
      this.cdr.markForCheck();
    });

    this.stopRoomStream = this.roomService.streamRoomsByStatus('active', (rooms) => {
      this.baseRooms = rooms;
      this.totalRooms = rooms.length;

      const deviceIds = rooms
        .map(r => r.device)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      if (deviceIds.length === 0) {
        this.isDevicesReady = true;
        this.deviceMap = {};
        this.calculateMetrics();
        this.mergeRoomTelemetry();
        this.cdr.markForCheck();
        return;
      }

      this.stopDevicesStream?.();
      this.stopDevicesStream = this.deviceService.streamDevicesByIds(deviceIds, (devices) => {
        this.deviceMap = devices;
        this.isDevicesReady = true;
        this.calculateMetrics();
        this.mergeRoomTelemetry();
        this.cdr.markForCheck();
      });
    });

    this.stopLogsStream = this.logService.streamLatest(2, (logs) => {
      this.recentLogs = logs;
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.stopRoomStream?.();
    this.stopDevicesStream?.();
    this.stopEnergyStream?.();
    this.stopLogsStream?.();
  }

  openLogsModal(): void {
    this.isLogsModalOpen = true;
    this.cdr.markForCheck();
  }

  closeLogsModal(): void {
    this.isLogsModalOpen = false;
    this.cdr.markForCheck();
  }

  async openDashboardLogDetails(log: DecisionLog): Promise<void> {
    this.selectedDashboardLog = log;
    this.isDashboardLogDetailsOpen = true;
    this.cdr.markForCheck();

    if (log.read === true) return;

    try {
      await this.logService.markAsRead(log.id);
      this.recentLogs = this.recentLogs.map(item =>
        item.id === log.id ? { ...item, read: true } : item
      );
      this.selectedDashboardLog = { ...log, read: true };
    } catch (error) {
      console.error('Failed to mark dashboard log as read.', error);
    } finally {
      this.cdr.markForCheck();
    }
  }

  closeDashboardLogDetails(): void {
    this.isDashboardLogDetailsOpen = false;
    this.selectedDashboardLog = null;
    this.cdr.markForCheck();
  }

  private calculateMetrics(): void {
    const devices = Object.values(this.deviceMap);
    let totalTemp = 0, tempCount = 0, occupiedCount = 0, overrideCount = 0;

    for (const device of devices) {
      if (typeof device.temperature === 'number') { totalTemp += device.temperature; tempCount++; }
      if (device.occupancy) occupiedCount++;
      if (device.control?.overrideActive) overrideCount++;
    }

    this.avgTemperature = tempCount > 0 ? totalTemp / tempCount : 0;
    this.occupiedZones = occupiedCount;
    this.activeOverrides = overrideCount;
  }

  private mergeRoomTelemetry(): void {
    this.rooms = mergeRoomsWithTelemetry(this.baseRooms, this.deviceMap, {
      fallbackToRoomPower: true,
      defaultPower: false,
    });
  }

  onMapRoomSelected(room: Room | undefined): void {
    this.selectedMapRoom = room;
  }
}
