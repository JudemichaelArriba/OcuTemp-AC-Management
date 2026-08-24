export type ChatUserRole = 'staff' | 'admin';

export type ChatToolName =
    | 'get_room_telemetry'
    | 'get_energy_report'
    | 'get_climate_prediction_logs'
    | 'get_recent_room_events'
    | 'get_system_help';

export type ChatIntent =
    | 'data'
    | 'help'
    | 'greeting'
    | 'control'
    | 'unsupported';

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

export type ChatOutputPreference = 'auto' | 'text' | 'table' | 'graph';

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

export type ChatMetric =
    | 'none'
    | 'temperature'
    | 'humidity'
    | 'condition'
    | 'device_status'
    | 'ac_power'
    | 'ai_auto_apply'
    | 'schedule_count'
    | 'estimated_kwh'
    | 'runtime_seconds'
    | 'session_count';

export type ChatComparisonTarget = 'none' | 'rooms' | 'winner' | 'trend';
export type EnergyBucket = 'auto' | 'day' | 'week' | 'month' | 'year';
export type EnergyRangePreset =
    | 'today'
    | 'this_week'
    | 'last_week'
    | 'last_7_days'
    | 'this_month'
    | 'last_month'
    | 'this_year'
    | 'last_12_months'
    | 'custom';

export interface ChatTurnRequest {
    readonly message: string;
    readonly stateToken?: string;
}

export interface ValidatedChatRequest {
    readonly message: string;
    readonly stateToken?: string;
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

export interface ChatAnswerBlockEntry {
    readonly label: string;
    readonly value: string;
}

/**
 * A deliberately small, renderer-safe content contract. Every field is
 * required so both configured providers can use one strict JSON schema;
 * fields that do not apply to a block are returned as empty strings/arrays.
 */
export interface ChatAnswerBlock {
    readonly kind: ChatAnswerBlockKind;
    readonly text: string;
    readonly items: string[];
    readonly entries: ChatAnswerBlockEntry[];
    readonly tone: ChatAnswerBlockTone;
}

export interface ChatAnswer {
    readonly headline: string;
    readonly summary: string;
    readonly blocks: ChatAnswerBlock[];
    readonly highlights: ChatAnswerHighlight[];
    readonly caveats: string[];
}

export interface GeneralAnswerDraft {
    readonly headline: string;
    readonly summary: string;
    readonly blocks: ChatAnswerBlock[];
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
    readonly bucket: Exclude<EnergyBucket, 'auto'>;
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
export type MeasurementStatus = 'current' | 'stale' | 'offline' | 'unavailable';
export type RoomCondition = 'comfortable' | 'warm' | 'hot' | 'critical' | 'unknown';

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

export interface ChatErrorResponse {
    readonly error: {
        readonly code: ChatErrorCode;
        readonly message: string;
        readonly retryAfterSeconds?: number;
    };
    readonly requestId: string;
}

export interface PlannerToolPlan {
    readonly name: ChatToolName;
    readonly roomNames: string[];
    readonly rangePreset: EnergyRangePreset;
    readonly startDate: string;
    readonly endDate: string;
    readonly bucket: EnergyBucket;
    readonly topic: string;
    readonly limit: number;
    readonly includeLastKnown: boolean;
}

export interface PlannerResult {
    readonly intent: ChatIntent;
    readonly questionFocus: ChatQuestionFocus;
    readonly outputPreference: ChatOutputPreference;
    readonly requestedRoomNames: string[];
    readonly allRooms: boolean;
    readonly metric: ChatMetric;
    readonly comparisonTarget: ChatComparisonTarget;
    readonly isFollowUp: boolean;
    readonly needsClarification: boolean;
    readonly clarification: string;
    readonly resolvedSummary: string;
    readonly tools: PlannerToolPlan[];
}

export interface GroundingFact {
    readonly id: string;
    readonly statement: string;
}

export interface ToolExecutionResult {
    readonly name: ChatToolName;
    readonly presentation: ChatPresentation;
    readonly facts: GroundingFact[];
    readonly notices: string[];
    readonly partial: boolean;
    readonly scope: RoomScopeResolution;
    readonly outcome: ToolOutcome;
}

export interface RoomScopeResolution {
    readonly requestedNames: string[];
    readonly matchedRoomNames: string[];
    readonly inactiveRoomNames: string[];
    readonly missingRoomNames: string[];
    readonly ambiguousRoomNames: string[];
    readonly activeRoomNames: string[];
}

export type ToolOutcome =
    | 'ok'
    | 'room_not_found'
    | 'room_inactive'
    | 'room_ambiguous'
    | 'no_online_reading'
    | 'no_energy_records'
    | 'source_unavailable'
    | 'insufficient_evidence';

export type ChatAnswerabilityOutcome =
    | 'answerable'
    | 'partial'
    | 'room_not_found'
    | 'room_inactive'
    | 'room_ambiguous'
    | 'no_online_reading'
    | 'no_energy_records'
    | 'source_unavailable'
    | 'insufficient_evidence'
    | 'clarification_required'
    | 'not_applicable';

export type ChatFreshnessOutcome =
    | 'current'
    | 'mixed'
    | 'stale'
    | 'offline'
    | 'unavailable'
    | 'not_applicable';

export type RecommendationCategory =
    | 'review_schedule'
    | 'inspect_high_runtime_room'
    | 'investigate_offline_device'
    | 'review_ai_auto_apply_configuration'
    | 'collect_missing_energy_data';

export interface EvidenceBackedRecommendation {
    readonly category: RecommendationCategory;
    readonly text: string;
    readonly evidenceRefs: string[];
}

export interface AnswerPacket {
    readonly questionFocus: ChatQuestionFocus;
    readonly scope: RoomScopeResolution;
    readonly range: EnergyRange | null;
    readonly answerability: ChatAnswerabilityOutcome;
    readonly freshness: ChatFreshnessOutcome;
    readonly facts: GroundingFact[];
    readonly recommendations: EvidenceBackedRecommendation[];
    readonly notices: string[];
    readonly displayPlan: ChatDisplayDirective[];
}

export interface GroundedAnswerDraft {
    readonly headline: string;
    readonly headlineEvidenceRefs: string[];
    readonly summary: string;
    readonly summaryEvidenceRefs: string[];
    readonly highlights: Array<{
        readonly text: string;
        readonly evidenceRefs: string[];
    }>;
    readonly recommendations: Array<{
        readonly category: RecommendationCategory;
        readonly text: string;
        readonly evidenceRefs: string[];
    }>;
}

export interface AuthenticatedChatUser {
    readonly uid: string;
    readonly role: ChatUserRole;
    readonly approved: true;
    readonly emailVerified: boolean;
    readonly idToken: string;
}

export interface ChatStateTurn {
    readonly user: string;
    readonly assistant: string;
    readonly context: ChatStateContext;
}

export interface ChatStateContext {
    readonly questionFocus: ChatQuestionFocus;
    readonly metric: ChatMetric;
    readonly roomNames: string[];
    readonly allRooms: boolean;
    readonly rangePreset: EnergyRangePreset;
    readonly startDate: string;
    readonly endDate: string;
    readonly bucket: EnergyBucket;
    readonly toolNames: ChatToolName[];
    readonly answerability: ChatAnswerabilityOutcome;
    readonly hadVisual: boolean;
}

export interface ChatStatePayload {
    readonly version: 2;
    readonly uid: string;
    readonly conversationId: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly turns: ChatStateTurn[];
}

export type ChatErrorCode =
    | 'invalid_request'
    | 'authentication_required'
    | 'account_not_authorized'
    | 'origin_not_allowed'
    | 'rate_limited'
    | 'context_invalid'
    | 'facility_too_large'
    | 'data_unavailable'
    | 'assistant_unavailable'
    | 'configuration_error'
    | 'method_not_allowed';

const PUBLIC_ERROR_MESSAGES: Readonly<Record<ChatErrorCode, string>> = {
    invalid_request: 'The chat request is invalid.',
    authentication_required: 'A valid signed-in session is required.',
    account_not_authorized: 'This account is not authorized to use OcuGuide.',
    origin_not_allowed: 'This website is not allowed to use OcuGuide.',
    rate_limited: 'OcuGuide is receiving requests too quickly. Please try again later.',
    context_invalid: 'The conversation context is invalid. Start a new report and try again.',
    facility_too_large: 'The requested facility report is too large. Narrow the room scope.',
    data_unavailable: 'The requested facility data is temporarily unavailable.',
    assistant_unavailable: 'OcuGuide is temporarily unavailable.',
    configuration_error: 'OcuGuide is temporarily unavailable.',
    method_not_allowed: 'Only POST requests are accepted by this endpoint.',
};

export class ChatApiError extends Error {
    constructor(
        readonly code: ChatErrorCode,
        message: string,
        readonly statusCode: number,
        readonly retryAfterSeconds?: number,
        override readonly cause?: unknown,
    ) {
        super(PUBLIC_ERROR_MESSAGES[code]);
        this.name = 'ChatApiError';
        void message;
    }
}
