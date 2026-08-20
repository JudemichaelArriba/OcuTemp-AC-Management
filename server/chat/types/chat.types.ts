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
    | 'general'
    | 'greeting'
    | 'control'
    | 'unsupported';
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
    readonly estimatedKwh: number;
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
    };
    readonly trend: EnergyTrendPoint[];
    readonly rooms: EnergyRoomRow[];
}

export type DeviceOnlineState = 'online' | 'stale' | 'offline' | 'unknown';
export type RoomCondition = 'comfortable' | 'warm' | 'hot' | 'critical' | 'unknown';

export interface RoomTelemetryRow {
    readonly roomName: string;
    readonly onlineState: DeviceOnlineState;
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
    readonly answer: ChatAnswer;
    readonly presentations: ChatPresentation[];
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
}

export interface PlannerResult {
    readonly intent: ChatIntent;
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
}

export interface ChatStatePayload {
    readonly version: 1;
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
