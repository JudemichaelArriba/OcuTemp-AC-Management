export interface ChatTurnRequest {
  readonly message: string;
  readonly stateToken?: string;
}

export interface ChatAnswerHighlight {
  readonly text: string;
  readonly evidenceRefs: string[];
}

export interface ChatAnswer {
  readonly headline: string;
  readonly summary: string;
  readonly highlights: ChatAnswerHighlight[];
  readonly caveats: string[];
}

export interface ChatEvidenceMetadata {
  readonly asOf: string;
  readonly timeZone: 'Asia/Manila';
  readonly partial: boolean;
  readonly notices: string[];
}

export interface EnergyRange {
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly bucket: 'day' | 'week' | 'month' | 'year';
}

export type EnergyRoomDataStatus =
  | 'recorded'
  | 'no_records'
  | 'no_device'
  | 'device_unavailable';

export interface EnergyRoomRow {
  readonly roomName: string;
  readonly estimatedKwh: number | null;
  readonly sharePercent: number | null;
  readonly rank: number | null;
  readonly runtimeSeconds: number | null;
  readonly sessionCount: number | null;
  readonly status: EnergyRoomDataStatus;
  readonly lastUpdatedAt: string | null;
}

export interface EnergyTrendPoint {
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly estimatedKwh: number;
}

export interface EnergyReportPresentation {
  readonly kind: 'energy-report';
  readonly id: string;
  readonly title: string;
  readonly estimated: true;
  readonly range: EnergyRange;
  readonly metrics: {
    readonly totalKwh: number;
    readonly runtimeSeconds: number;
    readonly sessionCount: number;
    readonly activeRooms: number;
    readonly roomsWithRecords: number;
    readonly coveragePercent: number;
  };
  readonly trend: EnergyTrendPoint[];
  readonly rooms: EnergyRoomRow[];
}

export type DeviceOnlineState = 'online' | 'stale' | 'offline';
export type RoomCondition = 'comfortable' | 'warm' | 'hot' | 'critical' | 'unknown';

export interface RoomTelemetryRow {
  readonly roomName: string;
  readonly onlineState: DeviceOnlineState;
  readonly condition: RoomCondition;
  readonly temperature: number | null;
  readonly humidity: number | null;
  readonly occupancy: boolean | null;
  readonly acPower: boolean | null;
  readonly aiAutoApply: boolean;
  readonly schedules: Array<{
    readonly day: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly subject: string;
  }>;
  readonly lastSeen: string | null;
}

export interface RoomTelemetryPresentation {
  readonly kind: 'room-telemetry';
  readonly id: string;
  readonly title: string;
  readonly rooms: RoomTelemetryRow[];
}

export interface ClimateSuggestionRow {
  readonly roomName: string;
  readonly status: 'available' | 'no_suggestion' | 'no_device' | 'device_unavailable';
  readonly currentRoomTemp: number | null;
  readonly humidity: number | null;
  readonly suggestedTemp: number | null;
  readonly reason: string | null;
  readonly applied: boolean;
  readonly autoApplyEnabled: boolean;
  readonly updatedAt: string | null;
}

export interface ClimateSuggestionsPresentation {
  readonly kind: 'climate-suggestions';
  readonly id: string;
  readonly title: string;
  readonly rooms: ClimateSuggestionRow[];
}

export interface RecentEventRow {
  readonly roomName: string;
  readonly eventType: string;
  readonly mode: string | null;
  readonly detail: string;
  readonly applied: boolean | null;
  readonly updatedAt: string;
}

export interface RecentEventsPresentation {
  readonly kind: 'recent-events';
  readonly id: string;
  readonly title: string;
  readonly events: RecentEventRow[];
}

export interface SystemHelpPresentation {
  readonly kind: 'system-help';
  readonly id: string;
  readonly title: string;
  readonly topic: string;
  readonly steps: string[];
  readonly route: string | null;
  readonly restricted: boolean;
}

export type ChatPresentation =
  | EnergyReportPresentation
  | RoomTelemetryPresentation
  | ClimateSuggestionsPresentation
  | RecentEventsPresentation
  | SystemHelpPresentation;

export interface ChatTurnResponse {
  readonly turnId: string;
  readonly answer: ChatAnswer;
  readonly presentations: ChatPresentation[];
  readonly evidence: ChatEvidenceMetadata;
  readonly stateToken: string;
  readonly contextReset: boolean;
}

export interface ChatErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly retryAfterSeconds?: number;
  };
  readonly requestId?: string;
}

export class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly code = 'assistant_unavailable',
    readonly statusCode = 0,
    readonly retryAfterSeconds?: number,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ChatRequestError';
  }
}

export interface RenderableChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly answer?: ChatAnswer;
  readonly presentations: ChatPresentation[];
  readonly evidence?: ChatEvidenceMetadata;
  readonly errorCode?: string;
  readonly retryAfterSeconds?: number;
}
