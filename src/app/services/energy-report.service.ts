import { Injectable } from '@angular/core';
import { Database, ref, onValue } from '@angular/fire/database';
import { EnergyDaily } from '../models/energy.model';


const TZ = 'Asia/Manila';


export function getTodayKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

export function getLast7DayKeys(): string[] {
  const keys: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(d.toLocaleDateString('en-CA', { timeZone: TZ }));
  }
  return keys;
}

export function getLast8WeekRanges(): Array<{ start: string; end: string; label: string }> {
  const result = [];
  const now = new Date();
  for (let i = 7; i >= 0; i--) {
    const end = new Date(now);
    end.setDate(now.getDate() - i * 7);
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    result.push({
      start: start.toLocaleDateString('en-CA', { timeZone: TZ }),
      end: end.toLocaleDateString('en-CA', { timeZone: TZ }),
      label: `Wk ${8 - i}`,
    });
  }
  return result;
}

export function getLast12MonthKeys(): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    );
  }
  return keys;
}

export function sumKwhByDate(
  energyData: Record<string, Record<string, EnergyDaily>>,
  dateKey: string
): number {
  return Object.values(energyData).reduce(
    (sum, deviceDays) => sum + (deviceDays[dateKey]?.estimatedKwh ?? 0),
    0
  );
}

export function sumKwhByWeek(
  energyData: Record<string, Record<string, EnergyDaily>>,
  start: string,
  end: string
): number {
  return Object.values(energyData).reduce((sum, deviceDays) => {
    return (
      sum +
      Object.entries(deviceDays)
        .filter(([key]) => key >= start && key <= end)
        .reduce((s, [, v]) => s + (v.estimatedKwh ?? 0), 0)
    );
  }, 0);
}

export function sumKwhByMonth(
  energyData: Record<string, Record<string, EnergyDaily>>,
  monthKey: string // 'YYYY-MM'
): number {
  return Object.values(energyData).reduce((sum, deviceDays) => {
    return (
      sum +
      Object.entries(deviceDays)
        .filter(([key]) => key.startsWith(monthKey))
        .reduce((s, [, v]) => s + (v.estimatedKwh ?? 0), 0)
    );
  }, 0);
}



@Injectable({ providedIn: 'root' })
export class EnergyReportService {
  constructor(private db: Database) { }

  AllEnergyDaily(
    callback: (data: Record<string, Record<string, EnergyDaily>>) => void
  ): () => void {
    const devicesRef = ref(this.db, 'devices');
    const unsub = onValue(devicesRef, (snapshot) => {
      if (!snapshot.exists()) {
        callback({});
        return;
      }

      const raw = snapshot.val() as Record<string, any>;
      const result: Record<string, Record<string, EnergyDaily>> = {};

      for (const [deviceId, deviceData] of Object.entries(raw)) {
        if (deviceData?.energyDaily && typeof deviceData.energyDaily === 'object') {
          result[deviceId] = deviceData.energyDaily as Record<string, EnergyDaily>;
        }
      }

      callback(result);
    });

    return unsub;
  }
}