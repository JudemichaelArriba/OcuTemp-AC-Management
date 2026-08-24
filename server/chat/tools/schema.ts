import type {
    ChatComparisonTarget,
    ChatMetric,
    ChatOutputPreference,
    ChatQuestionFocus,
    ChatToolName,
    RecommendationCategory,
} from '../types/chat.types.js';

export const CHAT_TOOL_NAMES: readonly ChatToolName[] = [
    'get_room_telemetry',
    'get_energy_report',
    'get_climate_prediction_logs',
    'get_recent_room_events',
    'get_system_help',
];

export const CHAT_QUESTION_FOCUSES: readonly ChatQuestionFocus[] = [
    'room_existence',
    'current_temperature',
    'last_known_temperature',
    'current_humidity',
    'current_condition',
    'device_status',
    'ac_power_status',
    'ai_auto_apply_status',
    'schedule_count',
    'schedule_list',
    'energy_total',
    'energy_rank_winner',
    'energy_ranking',
    'energy_trend',
    'energy_report',
    'facility_efficiency_analysis',
    'climate_suggestion',
    'recent_events',
    'system_help',
    'greeting',
    'control_request',
    'unsupported',
];

export const CHAT_OUTPUT_PREFERENCES: readonly ChatOutputPreference[] = [
    'auto',
    'text',
    'table',
    'graph',
];

export const CHAT_METRICS: readonly ChatMetric[] = [
    'none',
    'temperature',
    'humidity',
    'condition',
    'device_status',
    'ac_power',
    'ai_auto_apply',
    'schedule_count',
    'estimated_kwh',
    'runtime_seconds',
    'session_count',
];

export const CHAT_COMPARISON_TARGETS: readonly ChatComparisonTarget[] = [
    'none',
    'rooms',
    'winner',
    'trend',
];

export const RECOMMENDATION_CATEGORIES: readonly RecommendationCategory[] = [
    'review_schedule',
    'inspect_high_runtime_room',
    'investigate_offline_device',
    'review_ai_auto_apply_configuration',
    'collect_missing_energy_data',
];

const ENERGY_PRESETS = [
    'today',
    'this_week',
    'last_week',
    'last_7_days',
    'this_month',
    'last_month',
    'this_year',
    'last_12_months',
    'custom',
] as const;

const ENERGY_BUCKETS = ['auto', 'day', 'week', 'month', 'year'] as const;

const TOOL_PLAN_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        name: { type: 'string', enum: CHAT_TOOL_NAMES },
        roomNames: {
            type: 'array',
            maxItems: 50,
            uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 100 },
        },
        rangePreset: { type: 'string', enum: ENERGY_PRESETS },
        startDate: { type: 'string', maxLength: 10 },
        endDate: { type: 'string', maxLength: 10 },
        bucket: { type: 'string', enum: ENERGY_BUCKETS },
        topic: { type: 'string', maxLength: 64 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        includeLastKnown: { type: 'boolean' },
    },
    required: [
        'name',
        'roomNames',
        'rangePreset',
        'startDate',
        'endDate',
        'bucket',
        'topic',
        'limit',
        'includeLastKnown',
    ],
} as const;

/** Closed semantic plan. Server validation applies cross-field invariants. */
export const PLANNER_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
        intent: {
            type: 'string',
            enum: ['data', 'help', 'greeting', 'control', 'unsupported'],
        },
        questionFocus: { type: 'string', enum: CHAT_QUESTION_FOCUSES },
        outputPreference: { type: 'string', enum: CHAT_OUTPUT_PREFERENCES },
        requestedRoomNames: {
            type: 'array',
            maxItems: 50,
            uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 100 },
        },
        allRooms: { type: 'boolean' },
        metric: { type: 'string', enum: CHAT_METRICS },
        comparisonTarget: { type: 'string', enum: CHAT_COMPARISON_TARGETS },
        isFollowUp: { type: 'boolean' },
        needsClarification: { type: 'boolean' },
        clarification: { type: 'string', maxLength: 240 },
        resolvedSummary: { type: 'string', maxLength: 300 },
        tools: { type: 'array', maxItems: 4, items: TOOL_PLAN_SCHEMA },
    },
    required: [
        'intent',
        'questionFocus',
        'outputPreference',
        'requestedRoomNames',
        'allRooms',
        'metric',
        'comparisonTarget',
        'isFollowUp',
        'needsClarification',
        'clarification',
        'resolvedSummary',
        'tools',
    ],
};

const EVIDENCE_REFS_SCHEMA = {
    type: 'array',
    minItems: 1,
    maxItems: 12,
    uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 80 },
} as const;

const RECOMMENDATION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        category: { type: 'string', enum: RECOMMENDATION_CATEGORIES },
        text: { type: 'string', minLength: 1, maxLength: 300 },
        evidenceRefs: EVIDENCE_REFS_SCHEMA,
    },
    required: ['category', 'text', 'evidenceRefs'],
} as const;

export const ANSWER_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
        headline: { type: 'string', minLength: 1, maxLength: 160 },
        headlineEvidenceRefs: EVIDENCE_REFS_SCHEMA,
        summary: { type: 'string', minLength: 1, maxLength: 800 },
        summaryEvidenceRefs: EVIDENCE_REFS_SCHEMA,
        highlights: {
            type: 'array',
            maxItems: 6,
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    text: { type: 'string', minLength: 1, maxLength: 300 },
                    evidenceRefs: EVIDENCE_REFS_SCHEMA,
                },
                required: ['text', 'evidenceRefs'],
            },
        },
        recommendations: {
            type: 'array',
            maxItems: 5,
            items: RECOMMENDATION_SCHEMA,
        },
    },
    required: [
        'headline',
        'headlineEvidenceRefs',
        'summary',
        'summaryEvidenceRefs',
        'highlights',
        'recommendations',
    ],
};

export const MAX_CHAT_ANSWER_BLOCKS = 5;
export const MAX_CHAT_ANSWER_CAVEATS = 3;
export const MAX_CHAT_ANSWER_CAVEAT_LENGTH = 240;
export const MAX_CHAT_BLOCK_TEXT_LENGTH = 600;
export const MAX_CHAT_BLOCK_ITEMS = 8;
export const MAX_CHAT_BLOCK_ITEM_LENGTH = 240;
export const MAX_CHAT_BLOCK_ENTRIES = 8;
export const MAX_CHAT_BLOCK_ENTRY_LABEL_LENGTH = 80;
export const MAX_CHAT_BLOCK_ENTRY_VALUE_LENGTH = 240;
