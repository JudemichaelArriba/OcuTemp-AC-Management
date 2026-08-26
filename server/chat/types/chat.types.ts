export type ChatUserRole = 'staff' | 'admin';

export type ChatToolName =
    | 'get_facility_summary'
    | 'get_room_telemetry'
    | 'get_energy_report'
    | 'get_climate_prediction_logs'
    | 'get_recent_room_events'
    | 'get_system_help'
    | 'get_admin_user_aggregates';

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

export type ChatPartId = 'part-1' | 'part-2' | 'part-3';

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
    | 'conversation'
    | 'unsupported';

export type SystemOperation =
    | 'greet'
    | 'count'
    | 'list'
    | 'status'
    | 'detail'
    | 'compare'
    | 'summarize'
    | 'report'
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

export type SystemFilterOperator = 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte';

/** Strict-schema filter: exactly one typed value slot is selected by valueType. */
export interface SystemFilter {
    readonly field: SystemField;
    readonly operator: SystemFilterOperator;
    readonly valueType: 'string' | 'number' | 'boolean' | 'strings';
    readonly stringValue: string;
    readonly numberValue: number;
    readonly booleanValue: boolean;
    readonly stringValues: string[];
}

export interface SystemSort {
    readonly field: SystemField;
    readonly direction: 'none' | 'asc' | 'desc';
}

export type SystemScopeKind =
    | 'facility'
    | 'named_rooms'
    | 'own_account'
    | 'previous_request'
    | 'previous_result'
    | 'prior_part';

export interface SystemScope {
    readonly kind: SystemScopeKind;
    readonly roomNames: string[];
    readonly inventory: 'active' | 'inactive' | 'all';
    readonly referencePartId: '' | ChatPartId;
}

export interface SystemTimeRange {
    readonly preset: EnergyRangePreset;
    readonly startDate: string;
    readonly endDate: string;
    readonly bucket: EnergyBucket;
}

export interface FollowUpReference {
    readonly kind: 'none' | 'previous_request' | 'previous_result' | 'prior_part';
    readonly partId: '' | ChatPartId;
    readonly ordinal: 0 | 1 | 2 | 3;
}

export interface SystemQueryPart {
    readonly partId: ChatPartId;
    readonly domain: SystemDomain;
    readonly operation: SystemOperation;
    readonly fields: SystemField[];
    readonly filters: SystemFilter[];
    readonly sort: SystemSort;
    readonly scope: SystemScope;
    readonly timeRange: SystemTimeRange;
    readonly outputPreference: ChatOutputPreference;
    readonly followUpReference: FollowUpReference;
    readonly limit: number;
    readonly needsClarification: boolean;
    readonly clarification: string;
}

export interface SystemQueryPlan {
    readonly parts: SystemQueryPart[];
}

export type ChatDialogueAct =
    | 'ask'
    | 'confirm'
    | 'correct'
    | 'follow_up'
    | 'elaborate'
    | 'clarify'
    | 'greet'
    | 'deny';

export type DialogueFreshness =
    | 'auto'
    | 'current'
    | 'last_known'
    | 'configured'
    | 'historical';

export interface DialoguePart {
    readonly domain: SystemDomain;
    readonly intent: SystemOperation;
    readonly concepts: SystemField[];
    readonly roomNames: string[];
    readonly reference: 'none' | 'previous_request' | 'previous_result' | 'prior_part';
    readonly referencePartId: '' | ChatPartId;
    readonly ordinal: 0 | 1 | 2 | 3;
    readonly freshness: DialogueFreshness;
    readonly outputPreference: ChatOutputPreference;
    readonly confidence: 'high' | 'medium' | 'low';
    readonly ambiguity: string;
}

export interface DialoguePlan {
    readonly act: ChatDialogueAct;
    readonly parts: DialoguePart[];
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
    readonly source: 'facility' | 'application' | 'none';
    readonly partial: boolean;
    readonly notices: string[];
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

/** @deprecated Internal compatibility shape; new public room results use room-data. */
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

export interface ChatResponseContext {
    readonly partId: ChatPartId;
    readonly domain: SystemDomain;
    readonly operation: SystemOperation;
    readonly fields: SystemField[];
    readonly scope: SystemScopeKind;
    readonly answerability: ChatAnswerabilityOutcome;
}

export interface ChatAnswerPart {
    readonly partId: ChatPartId;
    readonly text: string;
    readonly blocks: ChatAnswerBlock[];
    readonly highlights: ChatAnswerHighlight[];
    readonly caveats: string[];
}

export interface ChatFollowUp {
    readonly label: string;
    readonly prompt: string;
}

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
    readonly partId: ChatPartId;
    readonly domain: SystemDomain;
    readonly operation: SystemOperation;
    readonly roomNames: string[];
    readonly inventory: 'active' | 'inactive' | 'all';
    readonly fields: SystemField[];
    readonly filters: SystemFilter[];
    readonly sort: SystemSort;
    readonly rangePreset: EnergyRangePreset;
    readonly startDate: string;
    readonly endDate: string;
    readonly bucket: EnergyBucket;
    readonly topic: string;
    readonly limit: number;
    readonly includeLastKnown: boolean;
}

export type PlannerResult = SystemQueryPlan;

export interface GroundingFact {
    readonly id: string;
    readonly partId: ChatPartId;
    readonly statement: string;
}

export interface ToolExecutionResult {
    readonly name: ChatToolName;
    readonly partId: ChatPartId;
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
    | 'insufficient_evidence'
    | 'permission_denied';

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
    | 'permission_denied'
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
    readonly partId: ChatPartId;
    readonly dialogueAct: ChatDialogueAct;
    readonly responseGoal: string;
    readonly domain: SystemDomain;
    readonly operation: SystemOperation;
    readonly fields: SystemField[];
    readonly scope: RoomScopeResolution;
    readonly range: EnergyRange | null;
    readonly answerability: ChatAnswerabilityOutcome;
    readonly freshness: ChatFreshnessOutcome;
    readonly facts: GroundingFact[];
    readonly recommendations: EvidenceBackedRecommendation[];
    readonly notices: string[];
    readonly displayPlan: ChatDisplayDirective[];
    readonly previousResult: ChatStateResultMemory | null;
}

export interface GroundedResponseClause {
    readonly role: 'direct_answer' | 'context' | 'next_step';
    readonly text: string;
    readonly evidenceRefs: string[];
}

export interface GroundedAnswerDraft {
    readonly clauses: GroundedResponseClause[];
    readonly highlights: Array<{
        readonly text: string;
        readonly evidenceRefs: string[];
    }>;
}

export interface AuthenticatedChatUser {
    readonly uid: string;
    readonly role: ChatUserRole;
    readonly approved: true;
    readonly emailVerified: boolean;
    readonly fullName: string | null;
    readonly email: string | null;
    readonly idToken: string;
}

export interface ChatPrincipal {
    readonly uid: string;
    readonly role: ChatUserRole;
    readonly approved: true;
    readonly emailVerified: boolean;
    readonly fullName: string | null;
    readonly email: string | null;
}

export interface ChatStateTurn {
    readonly act: ChatDialogueAct;
    readonly contexts: ChatStateContext[];
    readonly referents: ChatStateReferent[];
    readonly results: ChatStateResultMemory[];
}

export interface ChatStateContext {
    readonly partId: ChatPartId;
    readonly domain: SystemDomain;
    readonly operation: SystemOperation;
    readonly fields: SystemField[];
    readonly requestedScope: SystemScope;
    readonly timeRange: SystemTimeRange;
    readonly toolNames: ChatToolName[];
    readonly answerability: ChatAnswerabilityOutcome;
    readonly hadVisual: boolean;
}

export interface ChatStateReferent {
    readonly sourcePartId: ChatPartId;
    readonly kind: 'room_result';
    readonly roomNames: string[];
    readonly complete: boolean;
    readonly ordering: 'query' | 'ranking';
}

export type ChatStateResultOutcome =
    | 'matched'
    | 'empty'
    | 'partial'
    | 'unavailable'
    | 'denied'
    | 'ambiguous';

export type ChatStateEmptyReason =
    | 'none'
    | 'no_matches'
    | 'no_online_reading'
    | 'no_records'
    | 'room_not_found'
    | 'room_inactive'
    | 'permission_denied'
    | 'source_unavailable'
    | 'insufficient_evidence'
    | 'ambiguous';

export interface ChatStateCount {
    readonly field: SystemField;
    readonly value: number;
}

export interface ChatStateResultMemory {
    readonly sourcePartId: ChatPartId;
    readonly subject: SystemDomain;
    readonly outcome: ChatStateResultOutcome;
    readonly emptyReason: ChatStateEmptyReason;
    readonly counts: ChatStateCount[];
    readonly roomNames: string[];
    readonly complete: boolean;
    readonly freshness: ChatFreshnessOutcome;
    readonly asOf: string;
    readonly visual: ChatDisplayMode | 'none';
}

export interface ChatStatePayload {
    readonly version: 4;
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
