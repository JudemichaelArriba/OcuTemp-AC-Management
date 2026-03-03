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
}
