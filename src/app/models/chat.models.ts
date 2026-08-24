export interface ChatTurnRequest {
  readonly message: string;
  readonly stateToken?: string;
}

export type ChatQuestionFocus =
  | 'room_existence'
  | 'current_temperature'
  | 'last_known_temperature'
  | 'current_humidity'
  | 'current_condition'
  | 'device_status'
  | 'ac_power_status'
  | 'ai_auto_apply_status'
  | 'schedule_count'
  | 'schedule_list'
  | 'energy_total'
  | 'energy_rank_winner'
  | 'energy_ranking'
  | 'energy_trend'
  | 'energy_report'
  | 'facility_efficiency_analysis'
  | 'climate_suggestion'
  | 'recent_events'
  | 'system_help'
  | 'greeting'
  | 'control_request'
  | 'unsupported';

export type ChatDisplayMode =
  | 'compact_metrics'
  | 'key_value'
  | 'bullet_list'
  | 'table'
  | 'ranking_chart'
  | 'trend_chart'
  | 'full_report';

export interface ChatDisplayDirective {
  readonly presentationId: string;
  readonly mode: ChatDisplayMode;
}

export interface ChatAnswerHighlight {
  readonly text: string;
}

export type ChatAnswerBlockKind =
  | 'paragraph'
  | 'bullet-list'
  | 'numbered-list'
  | 'callout'
  | 'key-value';

export type ChatAnswerBlockTone = 'neutral' | 'info' | 'warning';

export interface ChatAnswerKeyValue {
  readonly label: string;
  readonly value: string;
}

/**
 * A bounded, plain-text answer block. Every field is present so both AI
 * providers can use one strict JSON schema; renderers use only the fields
 * relevant to `kind` and never interpret the text as HTML.
 */
export interface ChatAnswerBlock {
  readonly kind: ChatAnswerBlockKind;
  readonly text: string;
  readonly items: string[];
  readonly entries: ChatAnswerKeyValue[];
  readonly tone: ChatAnswerBlockTone;
}

export interface ChatAnswer {
  readonly headline: string;
  readonly summary: string;
  readonly blocks: ChatAnswerBlock[];
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
  readonly estimatedKwh: number | null;
  readonly recordedDays: number;
  readonly expectedDays: number;
}

export interface EnergyReportPresentation {
  readonly kind: 'energy-report';
  readonly availability: 'available' | 'unavailable';
  readonly id: string;
  readonly title: string;
  readonly estimated: true;
  readonly range: EnergyRange;
  readonly metrics: {
    readonly totalKwh: number | null;
    readonly runtimeSeconds: number | null;
    readonly sessionCount: number | null;
    readonly activeRooms: number;
    readonly roomsWithRecords: number;
    readonly coveragePercent: number;
    readonly recordedDays: number;
    readonly expectedDays: number;
    readonly dataCoveragePercent: number;
  };
  readonly trend: EnergyTrendPoint[];
  readonly rooms: EnergyRoomRow[];
}

export type DeviceOnlineState = 'online' | 'stale' | 'offline' | 'unknown';
export type DeviceAssignmentStatus = 'assigned' | 'not_assigned' | 'unavailable';
export type RoomCondition = 'comfortable' | 'warm' | 'hot' | 'critical' | 'unknown';
export type MeasurementStatus = 'current' | 'stale' | 'offline' | 'unavailable';

export interface RoomTelemetryRow {
  readonly roomName: string;
  readonly deviceAssignmentStatus: DeviceAssignmentStatus;
  readonly onlineState: DeviceOnlineState;
  readonly measurementStatus: MeasurementStatus;
  readonly condition: RoomCondition;
  readonly temperature: number | null;
  readonly humidity: number | null;
  readonly occupancy: boolean | null;
  readonly acPower: boolean | null;
  readonly aiAutoApply: boolean | null;
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
  readonly availability: 'available' | 'unavailable';
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
  readonly applied: boolean | null;
  readonly autoApplyEnabled: boolean | null;
  readonly updatedAt: string | null;
}

export interface ClimateSuggestionsPresentation {
  readonly kind: 'climate-suggestions';
  readonly availability: 'available' | 'unavailable';
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
  readonly availability: 'available' | 'unavailable';
  readonly id: string;
  readonly title: string;
  readonly events: RecentEventRow[];
}

export interface SystemHelpPresentation {
  readonly kind: 'system-help';
  readonly availability: 'available' | 'unavailable';
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
  readonly questionFocus: ChatQuestionFocus;
  readonly answer: ChatAnswer;
  readonly presentations: ChatPresentation[];
  readonly displayPlan: ChatDisplayDirective[];
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
  readonly questionFocus?: ChatQuestionFocus;
  readonly presentations: ChatPresentation[];
  readonly displayPlan: ChatDisplayDirective[];
  readonly evidence?: ChatEvidenceMetadata;
  readonly errorCode?: string;
  readonly retryAfterSeconds?: number;
}
