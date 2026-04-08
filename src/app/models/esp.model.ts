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
  };
}
