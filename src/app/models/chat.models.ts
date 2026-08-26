export interface ChatTurnRequest {
  readonly message: string;
  readonly stateToken?: string;
}

export type ChatPartId = 'part-1' | 'part-2' | 'part-3';

export type ChatToolName =
  | 'get_facility_summary'
  | 'get_room_telemetry'
  | 'get_energy_report'
  | 'get_climate_prediction_logs'
  | 'get_recent_room_events'
  | 'get_system_help'
  | 'get_admin_user_aggregates';

export type SystemDomain =
  | 'rooms'
  | 'devices'
  | 'measurements'
  | 'occupancy'
  | 'ac_control'
  | 'overrides'
  | 'ai_auto_apply'
  | 'schedules'
  | 'energy'
  | 'climate_suggestions'
  | 'decision_events'
  | 'floor_plan'
  | 'own_account'
  | 'admin_user_aggregates'
  | 'app_help'
  | 'assistant_capabilities'
  | 'system_concepts'
  | 'conversation'
  | 'unsupported';

export type SystemOperation =
  | 'greet'
  | 'count'
  | 'list'
  | 'status'
  | 'detail'
  | 'compare'
  | 'report'
  | 'summarize'
  | 'explain'
  | 'how_to'
  | 'clarify'
  | 'deny';

export type SystemField =
  | 'room_name'
  | 'room_status'
  | 'room_count'
  | 'device_assignment'
  | 'device_status'
  | 'device_count'
  | 'assigned_device_count'
  | 'online_device_count'
  | 'stale_device_count'
  | 'offline_device_count'
  | 'unknown_device_status_count'
  | 'last_seen'
  | 'temperature'
  | 'last_known_temperature'
  | 'humidity'
  | 'last_known_humidity'
  | 'condition'
  | 'occupancy'
  | 'last_known_occupancy'
  | 'ac_power'
  | 'last_known_ac_power'
  | 'override_active'
  | 'override_target_temperature'
  | 'override_until'
  | 'ai_auto_apply'
  | 'schedule_count'
  | 'schedules'
  | 'estimated_kwh'
  | 'runtime_seconds'
  | 'session_count'
  | 'energy_rank'
  | 'energy_trend'
  | 'climate_suggestion'
  | 'decision_event'
  | 'floor_plan_assignment'
  | 'floor_plan_layout'
  | 'account_name'
  | 'account_email'
  | 'account_role'
  | 'account_approval'
  | 'user_total'
  | 'approved_staff_count'
  | 'pending_staff_count'
  | 'admin_count'
  | 'help_topic'
  | 'capabilities';

export type SystemScopeKind =
  | 'facility'
  | 'named_rooms'
  | 'own_account'
  | 'previous_request'
  | 'previous_result'
  | 'prior_part';

export type ChatAnswerabilityOutcome =
  | 'answerable'
  | 'partial'
  | 'room_not_found'
  | 'room_inactive'
  | 'room_ambiguous'
  | 'no_online_reading'
  | 'no_energy_records'
  | 'permission_denied'
  | 'source_unavailable'
  | 'insufficient_evidence'
  | 'clarification_required'
  | 'not_applicable';

export interface ChatResponseContext {
  readonly partId: ChatPartId;
  readonly domain: SystemDomain;
  readonly operation: SystemOperation;
  readonly fields: SystemField[];
  readonly scope: SystemScopeKind;
  readonly answerability: ChatAnswerabilityOutcome;
}

export type ChatDisplayMode =
  | 'compact_metrics'
  | 'key_value'
  | 'bullet_list'
  | 'table'
  | 'ranking_chart'
  | 'trend_chart'
  | 'full_report';

export interface ChatDisplayDirective {
  readonly partId: ChatPartId;
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

/** Plain text only. The client never interprets answer text as HTML. */
export interface ChatAnswerBlock {
  readonly kind: ChatAnswerBlockKind;
  readonly text: string;
  readonly items: string[];
  readonly entries: ChatAnswerKeyValue[];
  readonly tone: ChatAnswerBlockTone;
}

export interface ChatAnswerPart {
  readonly partId: ChatPartId;
  readonly text: string;
  readonly blocks: ChatAnswerBlock[];
  readonly highlights: ChatAnswerHighlight[];
  readonly caveats: string[];
}

export interface ChatEvidenceMetadata {
  readonly asOf: string;
  readonly timeZone: 'Asia/Manila';
  readonly source: 'facility' | 'application' | 'none';
  readonly partial: boolean;
  readonly notices: string[];
}

export interface ChatFollowUp {
  readonly label: string;
  readonly prompt: string;
}

export type ChatValueState =
  | 'current'
  | 'historical'
  | 'configured'
  | 'expired'
  | 'unknown'
  | 'unavailable'
  | 'not_applicable';

export type ChatValueUnit =
  | 'none'
  | 'celsius'
  | 'percent'
  | 'kwh'
  | 'seconds'
  | 'count'
  | 'datetime';

export interface ProjectedValue {
  readonly field: SystemField;
  readonly label: string;
  readonly value: string | number | boolean | null;
  readonly state: ChatValueState;
  readonly unit: ChatValueUnit;
  readonly asOf: string | null;
}

export interface ChatPresentationBase {
  readonly availability: 'available' | 'unavailable';
  readonly id: string;
  readonly title: string;
  readonly partId: ChatPartId;
  readonly toolName: ChatToolName;
}

export interface MetricSummaryPresentation extends ChatPresentationBase {
  readonly kind: 'metric-summary';
  readonly metrics: ProjectedValue[];
}

export interface RoomDataRow {
  readonly roomName: string;
  readonly values: ProjectedValue[];
}

export interface RoomDataPresentation extends ChatPresentationBase {
  readonly kind: 'room-data';
  readonly rooms: RoomDataRow[];
}

export interface ScheduleDataRow {
  readonly roomName: string;
  readonly day: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly subject: string;
  readonly state: Extract<ChatValueState, 'configured' | 'unknown' | 'unavailable'>;
}

export interface ScheduleDataPresentation extends ChatPresentationBase {
  readonly kind: 'schedule-data';
  readonly schedules: ScheduleDataRow[];
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

export interface EnergyReportPresentation extends ChatPresentationBase {
  readonly kind: 'energy-report';
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

/** Compatibility shape for existing specialized server tools. */
export interface RoomTelemetryPresentation extends ChatPresentationBase {
  readonly kind: 'room-telemetry';
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

export interface ClimateSuggestionsPresentation extends ChatPresentationBase {
  readonly kind: 'climate-suggestions';
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

export interface RecentEventsPresentation extends ChatPresentationBase {
  readonly kind: 'recent-events';
  readonly events: RecentEventRow[];
}

export interface SystemHelpPresentation extends ChatPresentationBase {
  readonly kind: 'system-help';
  readonly topic: string;
  readonly steps: string[];
  readonly route: string | null;
  readonly restricted: boolean;
}

export type ChatPresentation =
  | MetricSummaryPresentation
  | RoomDataPresentation
  | ScheduleDataPresentation
  | EnergyReportPresentation
  | RoomTelemetryPresentation
  | ClimateSuggestionsPresentation
  | RecentEventsPresentation
  | SystemHelpPresentation;

export interface ChatTurnResponse {
  readonly turnId: string;
  readonly responseContexts: ChatResponseContext[];
  readonly answerParts: ChatAnswerPart[];
  readonly presentations: ChatPresentation[];
  readonly displayPlan: ChatDisplayDirective[];
  readonly evidence: ChatEvidenceMetadata;
  readonly followUps: ChatFollowUp[];
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
  readonly responseContexts: ChatResponseContext[];
  readonly answerParts: ChatAnswerPart[];
  readonly presentations: ChatPresentation[];
  readonly displayPlan: ChatDisplayDirective[];
  readonly followUps: ChatFollowUp[];
  readonly evidence?: ChatEvidenceMetadata;
  readonly errorCode?: string;
  readonly retryAfterSeconds?: number;
}
