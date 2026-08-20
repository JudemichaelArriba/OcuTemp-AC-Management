import type { ChatToolName } from '../types/chat.types.js';

export const CHAT_TOOL_NAMES: readonly ChatToolName[] = [
    'get_room_telemetry',
    'get_energy_report',
    'get_climate_prediction_logs',
    'get_recent_room_events',
    'get_system_help',
];

const TOOL_PLAN_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        name: { type: 'string', enum: CHAT_TOOL_NAMES },
        roomNames: {
            type: 'array',
            maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 100 },
        },
        rangePreset: {
            type: 'string',
            enum: [
                'today',
                'this_week',
                'last_week',
                'last_7_days',
                'this_month',
                'last_month',
                'this_year',
                'last_12_months',
                'custom',
            ],
        },
        startDate: { type: 'string', maxLength: 10 },
        endDate: { type: 'string', maxLength: 10 },
        bucket: { type: 'string', enum: ['auto', 'day', 'week', 'month', 'year'] },
        topic: { type: 'string', maxLength: 64 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
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
    ],
} as const;

export const PLANNER_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
        intent: {
            type: 'string',
            enum: ['data', 'help', 'general', 'greeting', 'control', 'unsupported'],
        },
        needsClarification: { type: 'boolean' },
        clarification: { type: 'string', maxLength: 240 },
        resolvedSummary: { type: 'string', maxLength: 300 },
        tools: { type: 'array', maxItems: 4, items: TOOL_PLAN_SCHEMA },
    },
    required: ['intent', 'needsClarification', 'clarification', 'resolvedSummary', 'tools'],
};

export const MAX_CHAT_ANSWER_BLOCKS = 5;
export const MAX_CHAT_BLOCK_TEXT_LENGTH = 600;
export const MAX_CHAT_BLOCK_ITEMS = 8;
export const MAX_CHAT_BLOCK_ITEM_LENGTH = 240;
export const MAX_CHAT_BLOCK_ENTRIES = 8;
export const MAX_CHAT_BLOCK_ENTRY_LABEL_LENGTH = 80;
export const MAX_CHAT_BLOCK_ENTRY_VALUE_LENGTH = 240;
export const MAX_CHAT_ANSWER_CAVEATS = 3;
export const MAX_CHAT_ANSWER_CAVEAT_LENGTH = 240;

const ANSWER_BLOCK_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        kind: {
            type: 'string',
            enum: ['paragraph', 'bullet-list', 'numbered-list', 'callout', 'key-value'],
        },
        text: { type: 'string', maxLength: MAX_CHAT_BLOCK_TEXT_LENGTH },
        items: {
            type: 'array',
            maxItems: MAX_CHAT_BLOCK_ITEMS,
            items: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_CHAT_BLOCK_ITEM_LENGTH,
            },
        },
        entries: {
            type: 'array',
            maxItems: MAX_CHAT_BLOCK_ENTRIES,
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    label: {
                        type: 'string',
                        minLength: 1,
                        maxLength: MAX_CHAT_BLOCK_ENTRY_LABEL_LENGTH,
                    },
                    value: {
                        type: 'string',
                        minLength: 1,
                        maxLength: MAX_CHAT_BLOCK_ENTRY_VALUE_LENGTH,
                    },
                },
                required: ['label', 'value'],
            },
        },
        tone: { type: 'string', enum: ['neutral', 'info', 'warning'] },
    },
    required: ['kind', 'text', 'items', 'entries', 'tone'],
} as const;

/**
 * General guidance has no evidence-reference fields because it must never
 * masquerade as facility data. Its shape remains closed and tightly bounded.
 */
export const GENERAL_ANSWER_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
        headline: { type: 'string', minLength: 1, maxLength: 160 },
        summary: { type: 'string', minLength: 1, maxLength: 800 },
        blocks: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_CHAT_ANSWER_BLOCKS,
            items: ANSWER_BLOCK_SCHEMA,
        },
        caveats: {
            type: 'array',
            maxItems: MAX_CHAT_ANSWER_CAVEATS,
            items: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_CHAT_ANSWER_CAVEAT_LENGTH,
            },
        },
    },
    required: ['headline', 'summary', 'blocks', 'caveats'],
};

const EVIDENCE_REFS_SCHEMA = {
    type: 'array',
    minItems: 1,
    maxItems: 12,
    uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 80 },
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
    },
    required: [
        'headline',
        'headlineEvidenceRefs',
        'summary',
        'summaryEvidenceRefs',
        'highlights',
    ],
};
