import type {
    ChatAnswerabilityOutcome, ChatOutputPreference, ChatPartId, ChatToolName,
    EnergyBucket, EnergyRangePreset, RecommendationCategory, SystemDomain,
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
    'assistant_capabilities', 'conversation', 'unsupported',
];
export const SYSTEM_OPERATIONS: readonly SystemOperation[] = [
    'greet', 'count', 'list', 'status', 'detail', 'compare', 'summarize', 'explain',
    'report', 'how_to', 'clarify', 'deny',
];
export const SYSTEM_FIELDS: readonly SystemField[] = [
    'room_name', 'room_status', 'room_count', 'device_assignment', 'device_status',
    'device_count', 'last_seen', 'temperature', 'last_known_temperature', 'humidity',
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
export const RECOMMENDATION_CATEGORIES: readonly RecommendationCategory[] = [
    'review_schedule', 'inspect_high_runtime_room', 'investigate_offline_device',
    'review_ai_auto_apply_configuration', 'collect_missing_energy_data',
];

const FILTER_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
        field: { type: 'string', enum: SYSTEM_FIELDS },
        operator: { type: 'string', enum: SYSTEM_FILTER_OPERATORS },
        valueType: { type: 'string', enum: ['string', 'number', 'boolean', 'strings'] },
        stringValue: { type: 'string', maxLength: 100 },
        numberValue: { type: 'number', minimum: -1_000_000, maximum: 1_000_000 },
        booleanValue: { type: 'boolean' },
        stringValues: { type: 'array', maxItems: 50, uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 100 } },
    },
    required: ['field', 'operator', 'valueType', 'stringValue', 'numberValue',
        'booleanValue', 'stringValues'],
} as const;

const QUERY_PART_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
        partId: { type: 'string', enum: CHAT_PART_IDS },
        domain: { type: 'string', enum: SYSTEM_DOMAINS },
        operation: { type: 'string', enum: SYSTEM_OPERATIONS },
        fields: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true,
            items: { type: 'string', enum: SYSTEM_FIELDS } },
        filters: { type: 'array', maxItems: 4, items: FILTER_SCHEMA },
        sort: { type: 'object', additionalProperties: false,
            properties: {
                field: { type: 'string', enum: SYSTEM_FIELDS },
                direction: { type: 'string', enum: ['none', 'asc', 'desc'] },
            }, required: ['field', 'direction'] },
        scope: { type: 'object', additionalProperties: false,
            properties: {
                kind: { type: 'string', enum: SYSTEM_SCOPE_KINDS },
                roomNames: { type: 'array', maxItems: 50, uniqueItems: true,
                    items: { type: 'string', minLength: 1, maxLength: 100 } },
                inventory: { type: 'string', enum: ['active', 'inactive', 'all'] },
                referencePartId: { type: 'string', enum: ['', ...CHAT_PART_IDS] },
            }, required: ['kind', 'roomNames', 'inventory', 'referencePartId'] },
        timeRange: { type: 'object', additionalProperties: false,
            properties: {
                preset: { type: 'string', enum: ENERGY_PRESETS },
                startDate: { type: 'string', maxLength: 10 },
                endDate: { type: 'string', maxLength: 10 },
                bucket: { type: 'string', enum: ENERGY_BUCKETS },
            }, required: ['preset', 'startDate', 'endDate', 'bucket'] },
        outputPreference: { type: 'string', enum: CHAT_OUTPUT_PREFERENCES },
        followUpReference: { type: 'object', additionalProperties: false,
            properties: {
                kind: { type: 'string', enum: ['none', 'previous_request',
                    'previous_result', 'prior_part'] },
                partId: { type: 'string', enum: ['', ...CHAT_PART_IDS] },
                ordinal: { type: 'integer', minimum: 0, maximum: 3 },
            }, required: ['kind', 'partId', 'ordinal'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        needsClarification: { type: 'boolean' },
        clarification: { type: 'string', maxLength: 240 },
    },
    required: ['partId', 'domain', 'operation', 'fields', 'filters', 'sort', 'scope',
        'timeRange', 'outputPreference', 'followUpReference', 'limit',
        'needsClarification', 'clarification'],
} as const;

/** Models return semantic intent only. Tool names and authorization are server owned. */
export const PLANNER_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: 'object', additionalProperties: false,
    properties: { parts: { type: 'array', minItems: 1, maxItems: 3, items: QUERY_PART_SCHEMA } },
    required: ['parts'],
};

const EVIDENCE_REFS_SCHEMA = { type: 'array', minItems: 1, maxItems: 12,
    uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 80 } } as const;
const RECOMMENDATION_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
        category: { type: 'string', enum: RECOMMENDATION_CATEGORIES },
        text: { type: 'string', minLength: 1, maxLength: 300 },
        evidenceRefs: EVIDENCE_REFS_SCHEMA,
    },
    required: ['category', 'text', 'evidenceRefs'],
} as const;

export const ANSWER_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: 'object', additionalProperties: false,
    properties: {
        text: { type: 'string', minLength: 1, maxLength: 1_200 },
        evidenceRefs: EVIDENCE_REFS_SCHEMA,
        highlights: { type: 'array', maxItems: 6, items: {
            type: 'object', additionalProperties: false,
            properties: {
                text: { type: 'string', minLength: 1, maxLength: 240 },
                evidenceRefs: EVIDENCE_REFS_SCHEMA,
            }, required: ['text', 'evidenceRefs'],
        } },
        recommendations: { type: 'array', maxItems: 5, items: RECOMMENDATION_SCHEMA },
    },
    required: ['text', 'evidenceRefs', 'highlights', 'recommendations'],
};
