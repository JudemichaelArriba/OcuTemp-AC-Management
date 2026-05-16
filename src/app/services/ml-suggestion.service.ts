import { Injectable } from '@angular/core';
import { Device } from '../models/esp.model';
import { MlSuggestion } from '../models/ml-suggestion.model';
import { Room } from '../models/room.model';

const TZ = 'Asia/Manila';

@Injectable({ providedIn: 'root' })
export class MlSuggestionService {
  attachPendingSuggestions(
    rooms: Room[],
    deviceMap: Record<string, Device>,
    now: Date = new Date()
  ): Room[] {
    return rooms.map((room) => ({
      ...room,
      pendingMlSuggestion: this.getPendingRoomSuggestion(room, deviceMap[room.device], now),
    }));
  }

  getPendingRoomSuggestion(
    room: Pick<Room, 'uid' | 'device'>,
    device?: Device | null,
    now: Date = new Date()
  ): MlSuggestion | undefined {
    const suggestion = device?.mlSuggestion;
    if (!suggestion) return undefined;
    if (device?.control?.aiAutoApply === true) return undefined;
    if (suggestion.applied === true) return undefined;

    const roomUid = suggestion.roomUid;
    const updatedAt = suggestion.updatedAt;
    const suggestedTemp = suggestion.suggestedTemp;

    if (typeof roomUid !== 'string' || roomUid !== room.uid) return undefined;
    if (typeof updatedAt !== 'string' || !this.isToday(updatedAt, now)) return undefined;
    if (!this.isValidNumber(suggestedTemp)) return undefined;

    return {
      deviceId: room.device,
      roomUid,
      suggestedTemp,
      updatedAt,
      currentRoomTemp: this.firstNumber(suggestion.currentRoomTemp, device?.temperature),
      targetTemp: this.firstNumber(device?.control?.targetTemp, device?.acState?.currentTemp),
      humidity: this.firstNumber(suggestion.humidity, device?.humidity),
      reason: suggestion.reason,
      source: suggestion.source,
    };
  }

  private isToday(updatedAt: string | undefined, now: Date): boolean {
    if (!updatedAt) return false;
    return this.toDateKey(updatedAt) === this.todayKey(now);
  }

  private toDateKey(value: string): string | null {
    const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (datePrefix) return datePrefix;

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleDateString('en-CA', { timeZone: TZ });
  }

  private todayKey(now: Date): string {
    return now.toLocaleDateString('en-CA', { timeZone: TZ });
  }

  private firstNumber(...values: Array<number | undefined>): number | undefined {
    return values.find((value): value is number => this.isValidNumber(value));
  }

  private isValidNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }
}
