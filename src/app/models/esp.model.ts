export interface DeviceMlSuggestion {
  applied?: boolean;
  autoApplyEnabled?: boolean;
  currentRoomTemp?: number;
  humidity?: number;
  reason?: string;
  roomUid?: string;
  source?: string;
  suggestedTemp?: number;
  updatedAt?: string;
}

export interface Device {
  uid: string;         
  temperature?: number;
  humidity?: number;
  occupancy?: boolean;
  acState?: {
    power?: boolean;
    currentTemp?: number;
    roomUid?: string;
    source?: string;
    updatedAt?: string;
  };
  // NEW: Manual override control fields
  control?: {
    overrideActive?: boolean;
    targetTemp?: number;
    overrideUntil?: string;
    requestedAt?: string;
    requestedBy?: string;
    roomUid?: string;
    aiAutoApply?: boolean;
  };
  mlSuggestion?: DeviceMlSuggestion;
  status?: DeviceStatus;
}


export interface DeviceStatus {
  ip?: string;
  lastSeen?: string;
}

export type OverrideHistoryAction = 'override' | 'clear' | 'forcedOff';

/** Append-only audit entry at `overrideHistory/{deviceId}/{pushId}`. */
export interface OverrideHistoryEntry {
  action: OverrideHistoryAction;
  requestedBy: string;
  requestedByName?: string;
  requestedByRole?: string;
  requestedAt: string;
  roomUid: string;
  targetTemp?: number;
  overrideUntil?: string;
}

/**
 * Entry at `devices/{deviceId}/occupancyDebugLog/{pushId}`, written by the ESP32 each time
 * a room goes from empty to occupied. `timestamp` is device wall-clock time in GMT+8.
 */
export interface OccupancyLogEntry {
  timestamp: string;
  /** Triggers joined by `+`, built from `pir_edge`, `pir_level` and `mlx`. */
  reason?: string;
  pirEdge?: boolean;
  pirLevel?: boolean;
  mlxHit?: boolean;
  mlxObjectTemp?: number;
  mlxAmbientTemp?: number;
  mlxDeltaTemp?: number;
  uptimeMs?: number;
}

/** A stored record together with its RTDB push key and the device it was stored under. */
export type DeviceRecord<T> = T & { readonly id: string; readonly deviceId: string };