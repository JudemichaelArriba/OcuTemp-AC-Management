import { MlSuggestion } from './ml-suggestion.model';

export interface Schedule {
  day: 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday' | '';
  startTime: string;
  endTime: string;
  subject: string;
}

export interface Room {
  uid: string;
  roomName: string;
  status: 'active' | 'inactive';
  temperature?: number;
  humidity?: number;
  device: string;
  occupancy?: boolean;
  power?: boolean;
  floorPlanCellId?: string;
  floorPlanAssignedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  schedules?: Schedule[];
  pendingMlSuggestion?: MlSuggestion;
}
