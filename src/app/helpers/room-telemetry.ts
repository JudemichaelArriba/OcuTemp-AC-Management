import { Room } from '../models/room.model';
import { DeviceTelemetry } from '../services/device.service';

export interface MergeTelemetryOptions {
  fallbackToRoomPower?: boolean;
  defaultPower?: boolean;
}

export function mergeRoomsWithTelemetry(
  rooms: Room[],
  deviceMap: Record<string, DeviceTelemetry>,
  options: MergeTelemetryOptions = {}
): Room[] {
  const fallbackToRoomPower = options.fallbackToRoomPower ?? false;
  const defaultPower = options.defaultPower ?? false;

  return rooms.map((room) => {
    const telemetry = room.device ? deviceMap[room.device] : undefined;
    const power = telemetry?.acState?.power ?? (fallbackToRoomPower ? room.power : undefined) ?? defaultPower;

    return {
      ...room,
      temperature: telemetry?.temperature ?? room.temperature,
      humidity: telemetry?.humidity ?? room.humidity,
      occupancy: telemetry?.occupancy ?? room.occupancy,
      power,
    };
  });
}
