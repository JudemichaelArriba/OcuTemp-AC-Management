import { Component, OnDestroy, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Room } from '../../models/room.model';
import { RoomService } from '../../services/room.service';
import { DeviceService, DeviceTelemetry } from '../../services/device.service';
import { EnergyReportService, getTodayKey, sumKwhByDate } from '../../services/energy-report.service';
import { RoomCard } from '../../components/room-card/room-card';
import { mergeRoomsWithTelemetry } from '../../helpers/room-telemetry';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RoomCard, DecimalPipe],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Dashboard implements OnInit, OnDestroy {
  isLoading: boolean = true;
  rooms: Room[] = [];

  // Real data for dashboard cards
  totalEnergyToday: number = 0;
  avgTemperature: number = 0;
  occupiedZones: number = 0;
  activeOverrides: number = 0;
  totalRooms: number = 0;

  private baseRooms: Room[] = [];
  private deviceMap: Record<string, DeviceTelemetry> = {};
  
  private stopRoomStream?: () => void;
  private stopDevicesStream?: () => void;
  private stopEnergyStream?: () => void;

  constructor(
    private roomService: RoomService,
    private deviceService: DeviceService,
    private energyService: EnergyReportService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit(): void {
    // 1. Stream today's energy consumption
    this.stopEnergyStream = this.energyService.AllEnergyDaily((energyData) => {
      const today = getTodayKey();
      this.totalEnergyToday = sumKwhByDate(energyData, today);
      this.cdr.markForCheck();
    });

    // 2. Stream Active Rooms & Telemetry
    this.stopRoomStream = this.roomService.streamRoomsByStatus('active', (rooms) => {
      this.baseRooms = rooms;
      this.totalRooms = rooms.length;

      const deviceIds = rooms
        .map(room => room.device)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      this.stopDevicesStream?.();

      let isFirstDeviceLoad = true;
      this.stopDevicesStream = this.deviceService.streamDevicesByIds(deviceIds, (devices) => {
        this.deviceMap = devices;
        
        if (isFirstDeviceLoad && Object.keys(devices).length === deviceIds.length) {
          this.isLoading = false;
          isFirstDeviceLoad = false;
        }

        this.calculateMetrics();
        this.mergeRoomTelemetry();
      });
    });
  }

  ngOnDestroy(): void {
    this.stopRoomStream?.();
    this.stopDevicesStream?.();
    this.stopEnergyStream?.();
  }

  private calculateMetrics(): void {
    const devices = Object.values(this.deviceMap);
    
    let totalTemp = 0;
    let tempCount = 0;
    let occupiedCount = 0;
    let overrideCount = 0;

    for (const device of devices) {
      // Average Climate
      if (typeof device.temperature === 'number') {
        totalTemp += device.temperature;
        tempCount++;
      }
      // Occupied Zones
      if (device.occupancy) {
        occupiedCount++;
      }
      // Manual Admin/User Overrides
      if (device.control?.overrideActive) {
        overrideCount++;
      }
    }

    this.avgTemperature = tempCount > 0 ? (totalTemp / tempCount) : 0;
    this.occupiedZones = occupiedCount;
    this.activeOverrides = overrideCount;
  }

  private mergeRoomTelemetry(): void {
    this.rooms = mergeRoomsWithTelemetry(this.baseRooms, this.deviceMap, {
      fallbackToRoomPower: true,
      defaultPower: false,
    });
    this.cdr.markForCheck();
  }
}