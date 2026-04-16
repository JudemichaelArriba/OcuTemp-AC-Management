export interface EnergyDaily {
  estimatedKwh: number;
  estimatedWattsOn: number;
  roomUid: string;
  runtimeSeconds: number;
  sessionCount: number;
  updatedAt: string;
}

export interface EnergyProfile {
  estimateMode: string;
  estimatedWattsOn: number;
  updatedAt: string;
}

export interface EnergyState {
  active: boolean;
  dateKey: string;
  lastFlushAt: string;
  lastSource: string;
  roomUid: string;
  sessionStartedAt: string;
  updatedAt: string;
}