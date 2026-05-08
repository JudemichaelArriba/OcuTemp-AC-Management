import { Room } from '../models/room.model';

export type HeatIndexCondition =
  | 'VERY HOT / HIGH HUMIDITY'
  | 'HOT'
  | 'WARM'
  | 'SLIGHTLY WARM'
  | 'COMFORTABLE'
  | 'NO TELEMETRY'
  | 'OFF';

export type FloorPlanVisualState =
  | 'off'
  | 'comfortable'
  | 'slightly-warm'
  | 'warm'
  | 'hot'
  | 'very-hot'
  | 'no-telemetry';

export interface FloorPlanRoomState {
  visualState: FloorPlanVisualState;
  condition: HeatIndexCondition;
  heatIndex: number | null;
  power: boolean;
  hasTelemetry: boolean;
  className: string;
}

export const FLOOR_PLAN_STATE_CLASSES = [
  'floorplan-state-off',
  'floorplan-state-comfortable',
  'floorplan-state-slightly-warm',
  'floorplan-state-warm',
  'floorplan-state-hot',
  'floorplan-state-very-hot',
  'floorplan-state-no-telemetry',
] as const;

export function normalizeFloorPlanCellId(value: string): string {
  return value.trim().replace(/\s+/g, '-').toLowerCase();
}

export function normalizeRoomNameForFloorPlan(value: string): string {
  return normalizeFloorPlanCellId(value);
}

export function roomMatchesFloorPlanCellByName(room: Room, cellId: string): boolean {
  return normalizeRoomNameForFloorPlan(room.roomName) === normalizeFloorPlanCellId(cellId);
}

export function getHeatIndexCondition(heatIndex: number | null | undefined): HeatIndexCondition {
  if (heatIndex === null || heatIndex === undefined || !Number.isFinite(heatIndex)) {
    return 'NO TELEMETRY';
  }

  if (heatIndex >= 38) return 'VERY HOT / HIGH HUMIDITY';
  if (heatIndex >= 34) return 'HOT';
  if (heatIndex >= 30) return 'WARM';
  if (heatIndex >= 26) return 'SLIGHTLY WARM';
  return 'COMFORTABLE';
}

export function getVisualStateFromCondition(condition: HeatIndexCondition): FloorPlanVisualState {
  switch (condition) {
    case 'VERY HOT / HIGH HUMIDITY':
      return 'very-hot';
    case 'HOT':
      return 'hot';
    case 'WARM':
      return 'warm';
    case 'SLIGHTLY WARM':
      return 'slightly-warm';
    case 'COMFORTABLE':
      return 'comfortable';
    case 'OFF':
      return 'off';
    case 'NO TELEMETRY':
      return 'no-telemetry';
  }
}

export function computeHeatIndexCelsius(temperature?: number, humidity?: number): number | null {
  if (temperature === undefined || !Number.isFinite(temperature)) return null;
  if (humidity === undefined || !Number.isFinite(humidity)) return temperature;

  const tempF = temperature * 9 / 5 + 32;
  const relativeHumidity = Math.max(0, Math.min(100, humidity));

  const heatIndexF =
    -42.379 +
    2.04901523 * tempF +
    10.14333127 * relativeHumidity -
    0.22475541 * tempF * relativeHumidity -
    0.00683783 * tempF * tempF -
    0.05481717 * relativeHumidity * relativeHumidity +
    0.00122874 * tempF * tempF * relativeHumidity +
    0.00085282 * tempF * relativeHumidity * relativeHumidity -
    0.00000199 * tempF * tempF * relativeHumidity * relativeHumidity;

  const heatIndexC = (heatIndexF - 32) * 5 / 9;
  return Number.isFinite(heatIndexC) ? heatIndexC : temperature;
}

export function getFloorPlanRoomState(room: Room | undefined | null): FloorPlanRoomState {
  if (!room) {
    return {
      visualState: 'no-telemetry',
      condition: 'NO TELEMETRY',
      heatIndex: null,
      power: false,
      hasTelemetry: false,
      className: 'floorplan-state-no-telemetry',
    };
  }

  const power = room.power === true;
  const hasTelemetry =
    room.temperature !== undefined ||
    room.humidity !== undefined ||
    room.occupancy !== undefined;

  if (!power) {
    return {
      visualState: 'off',
      condition: 'OFF',
      heatIndex: computeHeatIndexCelsius(room.temperature, room.humidity),
      power,
      hasTelemetry,
      className: 'floorplan-state-off',
    };
  }

  const heatIndex = computeHeatIndexCelsius(room.temperature, room.humidity);
  const condition = getHeatIndexCondition(heatIndex);
  const visualState = getVisualStateFromCondition(condition);

  return {
    visualState,
    condition,
    heatIndex,
    power,
    hasTelemetry,
    className: `floorplan-state-${visualState}`,
  };
}
