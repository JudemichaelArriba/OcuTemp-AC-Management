import type {
    ChatAnswerabilityOutcome, ChatOutputPreference, ChatPartId, ChatToolName,
    EnergyBucket, EnergyRangePreset, SystemDomain,
    SystemField, SystemFilterOperator, SystemOperation, SystemScopeKind,
} from '../types/chat.types.js';

export const CHAT_PART_IDS: readonly ChatPartId[] = ['part-1', 'part-2', 'part-3'];
export const CHAT_TOOL_NAMES: readonly ChatToolName[] = [
    'get_facility_summary', 'get_room_telemetry', 'get_energy_report',
    'get_climate_prediction_logs', 'get_recent_room_events', 'get_system_help',
    'get_admin_user_aggregates',
];
export const SYSTEM_DOMAINS: readonly SystemDomain[] = [
    'rooms', 'devices', 'measurements', 'occupancy', 'ac_control', 'overrides',
    'ai_auto_apply', 'schedules', 'energy', 'climate_suggestions', 'decision_events',
    'floor_plan', 'own_account', 'admin_user_aggregates', 'app_help',
    'assistant_capabilities', 'system_concepts', 'conversation', 'unsupported',
];
export const SYSTEM_OPERATIONS: readonly SystemOperation[] = [
    'greet', 'count', 'list', 'status', 'detail', 'compare', 'summarize', 'explain',
    'report', 'how_to', 'clarify', 'deny',
];
export const SYSTEM_FIELDS: readonly SystemField[] = [
    'room_name', 'room_status', 'room_count', 'device_assignment', 'device_status',
    'device_count', 'assigned_device_count', 'online_device_count',
    'stale_device_count', 'offline_device_count', 'unknown_device_status_count',
    'last_seen', 'temperature', 'last_known_temperature', 'humidity',
    'last_known_humidity', 'condition', 'occupancy', 'last_known_occupancy',
    'ac_power', 'last_known_ac_power', 'override_active', 'override_target_temperature', 'override_until',
    'ai_auto_apply', 'schedule_count', 'schedules', 'estimated_kwh', 'runtime_seconds',
    'session_count', 'energy_rank', 'energy_trend', 'climate_suggestion',
    'decision_event', 'floor_plan_assignment', 'floor_plan_layout', 'account_name',
    'account_email', 'account_role', 'account_approval', 'user_total',
    'approved_staff_count', 'pending_staff_count', 'admin_count', 'help_topic',
    'capabilities',
];
export const SYSTEM_SCOPE_KINDS: readonly SystemScopeKind[] = [
    'facility', 'named_rooms', 'own_account', 'previous_request', 'previous_result',
    'prior_part',
];
export const SYSTEM_FILTER_OPERATORS: readonly SystemFilterOperator[] = [
    'eq', 'in', 'gt', 'gte', 'lt', 'lte',
];
export const CHAT_OUTPUT_PREFERENCES: readonly ChatOutputPreference[] = [
    'auto', 'text', 'table', 'graph',
];
export const CHAT_DIALOGUE_ACTS = [
    'ask', 'confirm', 'correct', 'follow_up', 'elaborate', 'clarify', 'greet',
    'acknowledge', 'deny',
] as const;
export const DIALOGUE_FRESHNESS = [
    'auto', 'current', 'last_known', 'configured', 'historical',
] as const;
export const ENERGY_PRESETS: readonly EnergyRangePreset[] = [
    'today', 'this_week', 'last_week', 'last_7_days', 'this_month', 'last_month',
    'this_year', 'last_12_months', 'custom',
];
export const ENERGY_BUCKETS: readonly EnergyBucket[] = [
    'auto', 'day', 'week', 'month', 'year',
];
export const ANSWERABILITY_OUTCOMES: readonly ChatAnswerabilityOutcome[] = [
    'answerable', 'partial', 'room_not_found', 'room_inactive', 'room_ambiguous',
    'no_online_reading', 'no_energy_records', 'source_unavailable',
    'insufficient_evidence', 'permission_denied', 'clarification_required',
    'not_applicable',
];
const DIALOGUE_PART_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
        domain: { type: 'string', enum: SYSTEM_DOMAINS },
        intent: { type: 'string', enum: SYSTEM_OPERATIONS },
        concepts: { type: 'array', minItems: 1, maxItems: 8,
            items: { type: 'string', enum: SYSTEM_FIELDS } },
        roomNames: { type: 'array', maxItems: 50, items: { type: 'string' } },
        reference: { type: 'string', enum: ['none', 'previous_request',
            'previous_result', 'prior_part'] },
        referencePartId: { type: 'string', enum: ['', ...CHAT_PART_IDS] },
        ordinal: { type: 'integer', minimum: 0, maximum: 3 },
        freshness: { type: 'string', enum: DIALOGUE_FRESHNESS },
        presentationIntent: { type: 'string', enum: [
            'prose', 'short_list', 'comparison', 'ranking', 'trend', 'report',
        ] },
    },
    required: ['domain', 'intent', 'concepts', 'roomNames', 'reference',
        'referencePartId', 'ordinal', 'freshness', 'presentationIntent'],
} as const;

export const DIALOGUE_PLAN_SCHEMA: Record<string, unknown> = {
    type: 'object', additionalProperties: false,
    properties: {
        act: { type: 'string', enum: CHAT_DIALOGUE_ACTS },
        parts: { type: 'array', minItems: 1, maxItems: 3, items: DIALOGUE_PART_SCHEMA },
        clarificationReason: { type: 'string', enum: [
            'none', 'missing_subject', 'missing_room', 'missing_period',
            'ambiguous_reference', 'unrelated_parts',
        ] },
    },
    required: ['act', 'parts', 'clarificationReason'],
};

const EVIDENCE_REFS_SCHEMA = {
    type: 'array', items: { type: 'string' },
} as const;
export const ANSWER_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: 'object', additionalProperties: false,
    properties: {
        clauses: { type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
                role: { type: 'string', enum: ['direct_answer', 'context', 'next_step'] },
                text: { type: 'string' },
                evidenceRefs: EVIDENCE_REFS_SCHEMA,
            }, required: ['role', 'text', 'evidenceRefs'],
        } },
        highlights: { type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
                text: { type: 'string' },
                evidenceRefs: EVIDENCE_REFS_SCHEMA,
            }, required: ['text', 'evidenceRefs'],
        } },
    },
    required: ['clauses', 'highlights'],
};
