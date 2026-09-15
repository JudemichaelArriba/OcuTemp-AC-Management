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