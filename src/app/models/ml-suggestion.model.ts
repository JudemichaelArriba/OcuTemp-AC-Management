export interface MlSuggestion {
  deviceId: string;
  roomUid: string;
  suggestedTemp: number;
  updatedAt: string;
  currentRoomTemp?: number;
  targetTemp?: number;
  humidity?: number;
  reason?: string;
  source?: string;
}
