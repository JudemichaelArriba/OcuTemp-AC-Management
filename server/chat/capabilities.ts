import {
    CHAT_PART_IDS,
    CHAT_DIALOGUE_ACTS,
    CHAT_OUTPUT_PREFERENCES,
    DIALOGUE_FRESHNESS,
    ENERGY_BUCKETS,
    ENERGY_PRESETS,
    SYSTEM_DOMAINS,
    SYSTEM_FIELDS,
    SYSTEM_OPERATIONS,
} from './tools/schema.js';
import type {
    ChatDisplayMode,
    ChatDialogueAct,
    ChatPartId,
    ChatPrincipal,
    ChatToolName,
    ChatUserRole,
    DialogueFreshness,
    DialoguePart,
    DialoguePlan,
    PlannerToolPlan,
    SystemDomain,
    SystemField,
    SystemFilter,
    SystemOperation,
    SystemQueryPart,
    SystemQueryPlan,
    SystemScopeKind,
} from './types/chat.types.js';

export const MAX_QUERY_PARTS = 3;
export const MAX_UNIQUE_TOOLS = 4;
export const MAX_PART_FIELDS = 8;
export const MAX_PART_FILTERS = 4;
export const MAX_EXPLICIT_ROOMS = 50;

const BOTH_ROLES: readonly ChatUserRole[] = ['staff', 'admin'];
const ROOM_SCOPES: readonly SystemScopeKind[] = [
    'facility', 'named_rooms', 'previous_request', 'previous_result', 'prior_part',
];
const DATA_OPERATIONS: readonly SystemOperation[] = [
    'count', 'list', 'status', 'detail', 'compare', 'summarize', 'report', 'explain',
];

export const HELP_TOPIC_ROLES: Readonly<Record<string, readonly ChatUserRole[]>> = {
    'change-password': BOTH_ROLES,
    'add-room': ['admin'],
    'edit-room': ['admin'],
    'assign-floor-plan-cell': ['admin'],
    'floor-plan-legend': BOTH_ROLES,
    'manage-schedules': ['admin'],
    'approve-staff': ['admin'],
    'view-energy-reports': BOTH_ROLES,
    'manual-override': BOTH_ROLES,
    'forced-off': BOTH_ROLES,
    'ocu-guide': BOTH_ROLES,
};

type CapabilitySource = ChatToolName | 'principal' | 'deterministic';

export interface CapabilityDefinition {
    readonly domain: SystemDomain;
    readonly operations: readonly SystemOperation[];
    readonly fields: readonly SystemField[];
    readonly roles: readonly ChatUserRole[];
    readonly source: CapabilitySource;
    readonly scopes: readonly SystemScopeKind[];
    readonly displays: readonly ChatDisplayMode[];
}

export const CAPABILITY_REGISTRY: readonly CapabilityDefinition[] = [
    capability('rooms', DATA_OPERATIONS,
        ['room_name', 'room_status', 'room_count', 'device_assignment'],
        BOTH_ROLES, 'get_facility_summary', ROOM_SCOPES,
        ['compact_metrics', 'bullet_list', 'key_value', 'table']),
    capability('devices', DATA_OPERATIONS,
        ['room_name', 'device_assignment', 'device_status', 'device_count', 'last_seen'],
        BOTH_ROLES, 'get_facility_summary', ROOM_SCOPES,
        ['compact_metrics', 'bullet_list', 'key_value', 'table']),
    capability('measurements', ['status', 'detail', 'compare', 'summarize', 'explain'],
        ['room_name', 'temperature', 'last_known_temperature', 'humidity',
            'last_known_humidity', 'condition', 'device_status', 'last_seen'],
        BOTH_ROLES, 'get_room_telemetry', ROOM_SCOPES,
        ['compact_metrics', 'key_value', 'table']),
    capability('occupancy', ['count', 'list', 'status', 'detail', 'compare', 'summarize'],
        ['room_name', 'occupancy', 'last_known_occupancy', 'device_status', 'last_seen'],
        BOTH_ROLES, 'get_room_telemetry', ROOM_SCOPES,
        ['compact_metrics', 'bullet_list', 'key_value', 'table']),
    capability('ac_control', ['count', 'list', 'status', 'detail', 'compare', 'summarize'],
        ['room_name', 'ac_power', 'last_known_ac_power', 'device_status', 'last_seen'],
        BOTH_ROLES, 'get_room_telemetry', ROOM_SCOPES,
        ['compact_metrics', 'bullet_list', 'key_value', 'table']),
    capability('overrides', DATA_OPERATIONS,
        ['room_name', 'override_active', 'override_target_temperature', 'override_until',
            'device_status'],
        BOTH_ROLES, 'get_facility_summary', ROOM_SCOPES,
        ['compact_metrics', 'bullet_list', 'key_value', 'table']),
    capability('ai_auto_apply', DATA_OPERATIONS,
        ['room_name', 'ai_auto_apply', 'device_status'], BOTH_ROLES,
        'get_facility_summary', ROOM_SCOPES,
        ['compact_metrics', 'bullet_list', 'key_value', 'table']),
    capability('schedules', ['count', 'list', 'status', 'detail', 'compare', 'summarize'],
        ['room_name', 'schedule_count', 'schedules'], BOTH_ROLES,
        'get_facility_summary', ROOM_SCOPES,
        ['compact_metrics', 'bullet_list', 'table']),
    capability('energy', ['status', 'detail', 'compare', 'summarize', 'report', 'explain'],
        ['room_name', 'estimated_kwh', 'runtime_seconds', 'session_count', 'energy_rank',
            'energy_trend'], BOTH_ROLES, 'get_energy_report', ROOM_SCOPES,
        ['compact_metrics', 'key_value', 'table', 'ranking_chart', 'trend_chart',
            'full_report']),
    capability('climate_suggestions', ['list', 'status', 'detail', 'summarize', 'explain'],
        ['room_name', 'climate_suggestion'], BOTH_ROLES,
        'get_climate_prediction_logs', ROOM_SCOPES,
        ['bullet_list', 'key_value', 'table']),
    capability('decision_events', ['count', 'list', 'detail', 'summarize', 'explain'],
        ['room_name', 'decision_event'], BOTH_ROLES,
        'get_recent_room_events', ROOM_SCOPES, ['bullet_list', 'table']),
    capability('floor_plan', ['count', 'list', 'status', 'detail', 'summarize'],
        ['room_name', 'floor_plan_assignment', 'floor_plan_layout'], BOTH_ROLES,
        'get_facility_summary', ROOM_SCOPES,
        ['compact_metrics', 'bullet_list', 'key_value', 'table']),
    capability('own_account', ['status', 'detail'],
        ['account_name', 'account_email', 'account_role', 'account_approval'], BOTH_ROLES,
        'principal', ['own_account'], ['key_value']),
    capability('admin_user_aggregates', ['count', 'status', 'summarize'],
        ['user_total', 'approved_staff_count', 'pending_staff_count', 'admin_count'],
        ['admin'], 'get_admin_user_aggregates', ['facility'],
        ['compact_metrics', 'key_value']),
    capability('app_help', ['how_to'], ['help_topic'], BOTH_ROLES,
        'get_system_help', ['facility'], ['bullet_list']),
    capability('assistant_capabilities', ['list', 'explain'], ['capabilities'], BOTH_ROLES,
        'deterministic', ['facility'], ['bullet_list']),
    capability('conversation', ['greet', 'clarify', 'deny'], ['capabilities'], BOTH_ROLES,
        'deterministic', ['facility'], ['bullet_list']),
    capability('unsupported', ['clarify', 'deny'], ['capabilities'], BOTH_ROLES,
        'deterministic', ['facility'], ['bullet_list']),
] as const;

export interface DeniedQueryPart {
    readonly partId: ChatPartId;
    readonly reason: 'role_not_permitted' | 'help_topic_not_permitted';
}

export interface CompiledSystemQuery {
    readonly plan: SystemQueryPlan;
    readonly executablePlan: SystemQueryPlan;
    readonly tools: PlannerToolPlan[];
    readonly deniedParts: DeniedQueryPart[];
}

export class CapabilityValidationError extends Error {
    constructor(readonly reason: string) {
        super('The semantic query plan is not permitted.');
        this.name = 'CapabilityValidationError';
    }
}

export function capabilitiesForRole(role: ChatUserRole): readonly CapabilityDefinition[] {
    return CAPABILITY_REGISTRY.filter((item) => item.roles.includes(role));
}

/** Contains vocabulary only; it never includes profile data or facility values. */
export function plannerCapabilitySlice(role: ChatUserRole): string {
    const capabilities = capabilitiesForRole(role).map((item) =>
        `${item.domain}: operations=${item.operations.join(',')}; fields=${item.fields.join(',')}`,
    );
    const helpTopics = Object.entries(HELP_TOPIC_ROLES)
        .filter(([, roles]) => roles.includes(role))
        .map(([topic]) => topic);
    return [...capabilities, `app_help topics=${helpTopics.join(',')}`].join('\n');
}

export function validateSystemQueryPlan(rawPlan: unknown): SystemQueryPlan {
    return validatePlanShape(rawPlan);
}

export function validateDialoguePlan(value: unknown): DialoguePlan {
    if (!isRecord(value) || !hasExactKeys(value, ['act', 'parts']) ||
        typeof value['act'] !== 'string' ||
        !CHAT_DIALOGUE_ACTS.includes(value['act'] as ChatDialogueAct) ||
        !Array.isArray(value['parts']) || value['parts'].length < 1 ||
        value['parts'].length > MAX_QUERY_PARTS) {
        throw new CapabilityValidationError('invalid_dialogue_plan');
    }
    return {
        act: value['act'] as ChatDialogueAct,
        parts: value['parts'].map(validateDialoguePart),
    };
}

function validateDialoguePart(value: unknown, index: number): DialoguePart {
    const keys = ['domain', 'intent', 'concepts', 'roomNames', 'reference',
        'referencePartId', 'ordinal', 'freshness', 'outputPreference', 'confidence',
        'ambiguity'];
    if (!isRecord(value) || !hasExactKeys(value, keys) ||
        typeof value['domain'] !== 'string' ||
        !SYSTEM_DOMAINS.includes(value['domain'] as SystemDomain) ||
        typeof value['intent'] !== 'string' ||
        !SYSTEM_OPERATIONS.includes(value['intent'] as SystemOperation) ||
        !Array.isArray(value['concepts']) || value['concepts'].length < 1 ||
        value['concepts'].length > MAX_PART_FIELDS || !Array.isArray(value['roomNames']) ||
        typeof value['reference'] !== 'string' ||
        !['none', 'previous_request', 'previous_result', 'prior_part'].includes(value['reference']) ||
        typeof value['referencePartId'] !== 'string' ||
        !['', ...CHAT_PART_IDS].includes(value['referencePartId'] as ChatPartId) ||
        typeof value['ordinal'] !== 'number' || !Number.isInteger(value['ordinal']) ||
        value['ordinal'] < 0 || value['ordinal'] > 3 ||
        typeof value['freshness'] !== 'string' ||
        !DIALOGUE_FRESHNESS.includes(value['freshness'] as DialogueFreshness) ||
        typeof value['outputPreference'] !== 'string' ||
        !CHAT_OUTPUT_PREFERENCES.includes(value['outputPreference'] as never) ||
        !['high', 'medium', 'low'].includes(String(value['confidence'])) ||
        typeof value['ambiguity'] !== 'string' || value['ambiguity'].length > 240) {
        throw new CapabilityValidationError('invalid_dialogue_part');
    }
    const reference = value['reference'] as DialoguePart['reference'];
    const roomNames = normalizeTextArray(value['roomNames'], MAX_EXPLICIT_ROOMS, 100);
    if (reference === 'none' && value['referencePartId'] !== '' ||
        reference === 'prior_part' && (value['referencePartId'] === '' ||
            CHAT_PART_IDS.indexOf(value['referencePartId'] as ChatPartId) >= index) ||
        reference !== 'prior_part' && value['referencePartId'] !== '' ||
        reference !== 'none' && roomNames.length > 0) {
        throw new CapabilityValidationError('invalid_dialogue_reference');
    }
    return {
        domain: value['domain'] as SystemDomain,
        intent: value['intent'] as SystemOperation,
        concepts: normalizeEnumArray(value['concepts'], SYSTEM_FIELDS, MAX_PART_FIELDS,
            'invalid_dialogue_concepts'),
        roomNames,
        reference,
        referencePartId: value['referencePartId'] as DialoguePart['referencePartId'],
        ordinal: value['ordinal'] as DialoguePart['ordinal'],
        freshness: value['freshness'] as DialogueFreshness,
        outputPreference: value['outputPreference'] as DialoguePart['outputPreference'],
        confidence: value['confidence'] as DialoguePart['confidence'],
        ambiguity: cleanText(value['ambiguity'], 240),
    };
}

/**
 * Compiles semantics into server-owned calls. Denied parts are retained for a
 * direct permission response while unrelated allowed parts continue.
 */
export function compileSystemQueryPlan(
    rawPlan: unknown,
    principal: Pick<ChatPrincipal, 'role'>,
    resolvedParts?: readonly SystemQueryPart[],
): CompiledSystemQuery {
    const plan = validatePlanShape(rawPlan);
    const executablePlan = resolvedParts
        ? validateResolvedParts(plan, resolvedParts)
        : plan;
    const tools: PlannerToolPlan[] = [];
    const deniedParts: DeniedQueryPart[] = [];

    for (const part of executablePlan.parts) {
        const capability = capabilityForShape(part);
        validatePart(part, capability);
        if (!capability.roles.includes(principal.role)) {
            deniedParts.push({ partId: part.partId, reason: 'role_not_permitted' });
            continue;
        }
        if (part.domain === 'app_help' && !helpTopicAllowed(part, principal.role)) {
            deniedParts.push({ partId: part.partId, reason: 'help_topic_not_permitted' });
            continue;
        }
        if (part.needsClarification || capability.source === 'principal' ||
            capability.source === 'deterministic') continue;
        tools.push(compileTool(part, capability.source));

        // An efficiency explanation can draw only on these verified signals.
        if (part.domain === 'energy' && part.operation === 'explain') {
            tools.push(compileTool({
                ...part,
                domain: 'devices',
                operation: 'summarize',
                fields: ['room_name', 'device_status'],
                filters: [],
                sort: { field: 'room_name', direction: 'asc' },
            }, 'get_facility_summary'));
            tools.push(compileTool({
                ...part,
                domain: 'schedules',
                operation: 'summarize',
                fields: ['room_name', 'schedule_count'],
                filters: [],
                sort: { field: 'room_name', direction: 'asc' },
            }, 'get_facility_summary'));
        }
    }

    if (new Set(tools.map((tool) => tool.name)).size > MAX_UNIQUE_TOOLS) {
        throw new CapabilityValidationError('too_many_unique_tools');
    }
    return { plan, executablePlan, tools, deniedParts };
}

export function capabilityForPart(
    part: SystemQueryPart,
    role: ChatUserRole,
): CapabilityDefinition {
    const capability = capabilityForShape(part);
    if (!capability.roles.includes(role)) {
        throw new CapabilityValidationError('role_not_permitted');
    }
    return capability;
}

function capabilityForShape(part: SystemQueryPart): CapabilityDefinition {
    const domainMatches = CAPABILITY_REGISTRY.filter((item) => item.domain === part.domain);
    if (domainMatches.length === 0) throw new CapabilityValidationError('unknown_domain');
    const match = domainMatches.find((item) => item.operations.includes(part.operation));
    if (!match) throw new CapabilityValidationError('operation_not_permitted');
    return match;
}

function validatePlanShape(value: unknown): SystemQueryPlan {
    if (!isRecord(value) || !hasExactKeys(value, ['parts']) || !Array.isArray(value['parts']) ||
        value['parts'].length < 1 || value['parts'].length > MAX_QUERY_PARTS) {
        throw new CapabilityValidationError('invalid_parts');
    }
    const parts = value['parts'].map((item, index) => validatePartShape(item, index));
    validateRelationships(parts);
    return { parts };
}

function validateResolvedParts(
    requested: SystemQueryPlan,
    resolvedParts: readonly SystemQueryPart[],
): SystemQueryPlan {
    if (resolvedParts.length !== requested.parts.length) {
        throw new CapabilityValidationError('invalid_resolved_parts');
    }
    const parts = resolvedParts.map((part, index) => {
        const normalized = validatePartShape(part, index);
        const original = requested.parts[index]!;
        const mayInheritEnergyRange = original.domain === 'energy' &&
            (original.scope.kind === 'previous_request' ||
                original.followUpReference.kind === 'previous_request');
        if (normalized.partId !== original.partId || normalized.domain !== original.domain ||
            normalized.operation !== original.operation ||
            JSON.stringify(normalized.fields) !== JSON.stringify(original.fields) ||
            JSON.stringify(normalized.filters) !== JSON.stringify(original.filters) ||
            !mayInheritEnergyRange &&
            JSON.stringify(normalized.timeRange) !== JSON.stringify(original.timeRange)) {
            throw new CapabilityValidationError('resolved_part_mutated_semantics');
        }
        return normalized;
    });
    return { parts };
}

function validatePartShape(value: unknown, index: number): SystemQueryPart {
    const keys = ['partId', 'domain', 'operation', 'fields', 'filters', 'sort', 'scope',
        'timeRange', 'outputPreference', 'followUpReference', 'limit',
        'needsClarification', 'clarification'];
    if (!isRecord(value) || !hasExactKeys(value, keys)) {
        throw new CapabilityValidationError('invalid_part_shape');
    }
    const expectedPartId = CHAT_PART_IDS[index];
    const domain = value['domain'];
    const operation = value['operation'];
    const fields = value['fields'];
    const filters = value['filters'];
    if (value['partId'] !== expectedPartId || typeof domain !== 'string' ||
        !SYSTEM_DOMAINS.includes(domain as SystemDomain) || typeof operation !== 'string' ||
        !SYSTEM_OPERATIONS.includes(operation as SystemOperation) ||
        !Array.isArray(fields) || fields.length < 1 || fields.length > MAX_PART_FIELDS ||
        !Array.isArray(filters) || filters.length > MAX_PART_FILTERS ||
        !isRecord(value['sort']) || !isRecord(value['scope']) ||
        !isRecord(value['timeRange']) || !isRecord(value['followUpReference']) ||
        !['auto', 'text', 'table', 'graph'].includes(String(value['outputPreference'])) ||
        typeof value['limit'] !== 'number' || !Number.isInteger(value['limit']) ||
        value['limit'] < 1 || value['limit'] > 50 ||
        typeof value['needsClarification'] !== 'boolean' ||
        typeof value['clarification'] !== 'string' || value['clarification'].length > 240) {
        throw new CapabilityValidationError('invalid_part_values');
    }
    const clarification = cleanText(value['clarification'], 240);
    if (value['needsClarification'] !== (clarification.length > 0)) {
        throw new CapabilityValidationError('invalid_clarification');
    }
    return {
        partId: expectedPartId!,
        domain: domain as SystemDomain,
        operation: operation as SystemOperation,
        fields: normalizeEnumArray(fields, SYSTEM_FIELDS, MAX_PART_FIELDS, 'invalid_fields'),
        filters: filters.map(validateFilter),
        sort: validateSort(value['sort']),
        scope: validateScope(value['scope']),
        timeRange: validateTimeRange(value['timeRange']),
        outputPreference: value['outputPreference'] as SystemQueryPart['outputPreference'],
        followUpReference: validateFollowUpReference(value['followUpReference']),
        limit: value['limit'],
        needsClarification: value['needsClarification'],
        clarification,
    };
}

function validatePart(part: SystemQueryPart, capability: CapabilityDefinition): void {
    if (!capability.scopes.includes(part.scope.kind)) {
        throw new CapabilityValidationError('scope_not_permitted');
    }
    if (part.fields.some((field) => !capability.fields.includes(field))) {
        throw new CapabilityValidationError('field_not_permitted');
    }
    for (const filter of part.filters) {
        if (!part.fields.includes(filter.field) && filter.field !== 'room_name' &&
            filter.field !== 'room_status' && filter.field !== 'device_status') {
            throw new CapabilityValidationError('filter_field_not_projected');
        }
        validateFilterCompatibility(filter);
    }
    if (part.sort.direction !== 'none' && !part.fields.includes(part.sort.field)) {
        throw new CapabilityValidationError('sort_field_not_projected');
    }
    if (part.domain !== 'energy' && part.domain !== 'decision_events' &&
        (part.timeRange.startDate || part.timeRange.endDate ||
            part.timeRange.bucket !== 'auto')) {
        throw new CapabilityValidationError('unexpected_time_range');
    }
    if (part.scope.kind === 'own_account' && part.domain !== 'own_account' ||
        part.domain === 'own_account' && part.scope.kind !== 'own_account') {
        throw new CapabilityValidationError('invalid_account_scope');
    }
}

function compileTool(part: SystemQueryPart, name: ChatToolName): PlannerToolPlan {
    const detailedRoomRead = ['measurements', 'occupancy', 'ac_control'].includes(part.domain) ||
        part.domain === 'schedules' && part.fields.includes('schedules') ||
        part.scope.kind === 'named_rooms' && ['overrides', 'ai_auto_apply'].includes(part.domain);
    const selectedName = name === 'get_facility_summary' && detailedRoomRead
        ? 'get_room_telemetry'
        : name;
    return {
        name: selectedName,
        partId: part.partId,
        domain: part.domain,
        operation: part.operation,
        roomNames: [...part.scope.roomNames],
        inventory: part.scope.inventory,
        fields: [...part.fields],
        filters: [...part.filters],
        sort: { ...part.sort },
        rangePreset: part.timeRange.preset,
        startDate: part.timeRange.startDate,
        endDate: part.timeRange.endDate,
        bucket: part.timeRange.bucket,
        topic: part.domain === 'app_help'
            ? part.filters.find((filter) => filter.field === 'help_topic')?.stringValue ?? ''
            : '',
        limit: part.limit,
        includeLastKnown: part.fields.some((field) => field.startsWith('last_known_')),
    };
}

function validateRelationships(parts: readonly SystemQueryPart[]): void {
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]!;
        const dependsOnPrior = part.scope.kind === 'prior_part' ||
            part.followUpReference.kind === 'prior_part';
        if (!dependsOnPrior) continue;
        const reference = part.scope.referencePartId || part.followUpReference.partId;
        const referencedIndex = CHAT_PART_IDS.indexOf(reference as ChatPartId);
        if (referencedIndex < 0 || referencedIndex >= index) {
            throw new CapabilityValidationError('invalid_part_dependency');
        }
        const referenced = parts[referencedIndex]!;
        if (referenced.scope.kind === 'prior_part' ||
            referenced.followUpReference.kind === 'prior_part') {
            throw new CapabilityValidationError('dependency_depth_exceeded');
        }
    }
    if (parts.length <= 1) return;
    const first = parts[0]!;
    for (const part of parts.slice(1)) {
        if (part.scope.kind === 'prior_part' ||
            part.followUpReference.kind === 'prior_part') continue;
        if (scopeSignature(part) !== scopeSignature(first) ||
            rangeSignature(part) !== rangeSignature(first)) {
            throw new CapabilityValidationError('unrelated_parts');
        }
    }
}

function scopeSignature(part: SystemQueryPart): string {
    return JSON.stringify({
        kind: part.scope.kind,
        inventory: part.scope.inventory,
        roomNames: part.scope.roomNames.map((name) => name.toLocaleLowerCase('en-US')),
    });
}

function rangeSignature(part: SystemQueryPart): string {
    return JSON.stringify(part.timeRange);
}

function helpTopicAllowed(part: SystemQueryPart, role: ChatUserRole): boolean {
    const topic = part.filters.find((filter) => filter.field === 'help_topic')?.stringValue;
    return typeof topic === 'string' && HELP_TOPIC_ROLES[topic]?.includes(role) === true;
}

function validateFilter(value: unknown): SystemFilter {
    const keys = ['field', 'operator', 'valueType', 'stringValue', 'numberValue',
        'booleanValue', 'stringValues'];
    if (!isRecord(value) || !hasExactKeys(value, keys) ||
        typeof value['field'] !== 'string' ||
        !SYSTEM_FIELDS.includes(value['field'] as SystemField) ||
        typeof value['operator'] !== 'string' ||
        !['eq', 'in', 'gt', 'gte', 'lt', 'lte'].includes(value['operator']) ||
        !['string', 'number', 'boolean', 'strings'].includes(String(value['valueType'])) ||
        typeof value['stringValue'] !== 'string' || value['stringValue'].length > 100 ||
        typeof value['numberValue'] !== 'number' || !Number.isFinite(value['numberValue']) ||
        typeof value['booleanValue'] !== 'boolean' || !Array.isArray(value['stringValues'])) {
        throw new CapabilityValidationError('invalid_filter');
    }
    const filter: SystemFilter = {
        field: value['field'] as SystemField,
        operator: value['operator'] as SystemFilter['operator'],
        valueType: value['valueType'] as SystemFilter['valueType'],
        stringValue: cleanText(value['stringValue'], 100),
        numberValue: value['numberValue'],
        booleanValue: value['booleanValue'],
        stringValues: normalizeTextArray(value['stringValues'], 50, 100),
    };
    validateFilterCompatibility(filter);
    return filter;
}

function validateFilterCompatibility(filter: SystemFilter): void {
    const booleanFields: readonly SystemField[] = [
        'occupancy', 'last_known_occupancy', 'ac_power', 'last_known_ac_power',
        'override_active', 'ai_auto_apply', 'account_approval',
    ];
    const numberFields: readonly SystemField[] = [
        'temperature', 'last_known_temperature', 'humidity', 'last_known_humidity',
        'override_target_temperature', 'room_count', 'device_count', 'schedule_count',
        'estimated_kwh', 'runtime_seconds', 'session_count', 'energy_rank', 'user_total',
        'approved_staff_count', 'pending_staff_count', 'admin_count',
    ];
    const expected = booleanFields.includes(filter.field) ? 'boolean'
        : numberFields.includes(filter.field) ? 'number' : null;
    if (expected && filter.valueType !== expected) {
        throw new CapabilityValidationError('filter_type_mismatch');
    }
    if (filter.operator === 'in' && filter.valueType !== 'strings' ||
        ['gt', 'gte', 'lt', 'lte'].includes(filter.operator) &&
        filter.valueType !== 'number' ||
        filter.operator === 'eq' && filter.valueType === 'strings') {
        throw new CapabilityValidationError('invalid_filter_operator');
    }
}

function validateSort(value: Record<string, unknown>): SystemQueryPart['sort'] {
    if (!hasExactKeys(value, ['field', 'direction']) ||
        typeof value['field'] !== 'string' ||
        !SYSTEM_FIELDS.includes(value['field'] as SystemField) ||
        !['none', 'asc', 'desc'].includes(String(value['direction']))) {
        throw new CapabilityValidationError('invalid_sort');
    }
    return {
        field: value['field'] as SystemField,
        direction: value['direction'] as SystemQueryPart['sort']['direction'],
    };
}

function validateScope(value: Record<string, unknown>): SystemQueryPart['scope'] {
    if (!hasExactKeys(value, ['kind', 'roomNames', 'inventory', 'referencePartId']) ||
        !['facility', 'named_rooms', 'own_account', 'previous_request', 'previous_result',
            'prior_part'].includes(String(value['kind'])) || !Array.isArray(value['roomNames']) ||
        !['active', 'inactive', 'all'].includes(String(value['inventory'])) ||
        typeof value['referencePartId'] !== 'string' ||
        !['', ...CHAT_PART_IDS].includes(value['referencePartId'] as ChatPartId)) {
        throw new CapabilityValidationError('invalid_scope');
    }
    const roomNames = normalizeTextArray(value['roomNames'], MAX_EXPLICIT_ROOMS, 100);
    const kind = value['kind'] as SystemQueryPart['scope']['kind'];
    if (kind === 'named_rooms' && roomNames.length === 0 ||
        kind !== 'named_rooms' && roomNames.length > 0 ||
        kind === 'prior_part' && value['referencePartId'] === '' ||
        kind !== 'prior_part' && value['referencePartId'] !== '') {
        throw new CapabilityValidationError('invalid_scope_values');
    }
    return {
        kind,
        roomNames,
        inventory: value['inventory'] as SystemQueryPart['scope']['inventory'],
        referencePartId: value['referencePartId'] as SystemQueryPart['scope']['referencePartId'],
    };
}

function validateTimeRange(value: Record<string, unknown>): SystemQueryPart['timeRange'] {
    if (!hasExactKeys(value, ['preset', 'startDate', 'endDate', 'bucket']) ||
        typeof value['preset'] !== 'string' ||
        !ENERGY_PRESETS.includes(value['preset'] as never) ||
        typeof value['startDate'] !== 'string' || typeof value['endDate'] !== 'string' ||
        typeof value['bucket'] !== 'string' ||
        !ENERGY_BUCKETS.includes(value['bucket'] as never)) {
        throw new CapabilityValidationError('invalid_time_range');
    }
    const custom = value['preset'] === 'custom';
    if (custom && (!isDate(value['startDate']) || !isDate(value['endDate']) ||
        value['startDate'] > value['endDate']) || !custom &&
        (value['startDate'] !== '' || value['endDate'] !== '')) {
        throw new CapabilityValidationError('invalid_time_range_values');
    }
    return {
        preset: value['preset'] as SystemQueryPart['timeRange']['preset'],
        startDate: value['startDate'],
        endDate: value['endDate'],
        bucket: value['bucket'] as SystemQueryPart['timeRange']['bucket'],
    };
}

function validateFollowUpReference(
    value: Record<string, unknown>,
): SystemQueryPart['followUpReference'] {
    if (!hasExactKeys(value, ['kind', 'partId', 'ordinal']) ||
        !['none', 'previous_request', 'previous_result', 'prior_part'].includes(
            String(value['kind']),
        ) || typeof value['partId'] !== 'string' ||
        !['', ...CHAT_PART_IDS].includes(value['partId'] as ChatPartId) ||
        typeof value['ordinal'] !== 'number' || !Number.isInteger(value['ordinal']) ||
        value['ordinal'] < 0 || value['ordinal'] > 3) {
        throw new CapabilityValidationError('invalid_follow_up_reference');
    }
    const kind = value['kind'] as SystemQueryPart['followUpReference']['kind'];
    if (kind === 'none' && (value['partId'] !== '' || value['ordinal'] !== 0) ||
        kind === 'prior_part' && value['partId'] === '' ||
        kind !== 'prior_part' && value['partId'] !== '') {
        throw new CapabilityValidationError('invalid_follow_up_values');
    }
    return {
        kind,
        partId: value['partId'] as SystemQueryPart['followUpReference']['partId'],
        ordinal: value['ordinal'] as SystemQueryPart['followUpReference']['ordinal'],
    };
}

function capability(
    domain: SystemDomain,
    operations: readonly SystemOperation[],
    fields: readonly SystemField[],
    roles: readonly ChatUserRole[],
    source: CapabilitySource,
    scopes: readonly SystemScopeKind[],
    displays: readonly ChatDisplayMode[],
): CapabilityDefinition {
    return { domain, operations, fields, roles, source, scopes, displays };
}

function normalizeEnumArray<T extends string>(
    values: unknown[],
    allowed: readonly T[],
    maximum: number,
    reason: string,
): T[] {
    if (values.length > maximum || values.some((value) =>
        typeof value !== 'string' || !allowed.includes(value as T))) {
        throw new CapabilityValidationError(reason);
    }
    const result = [...new Set(values as T[])];
    if (result.length !== values.length) throw new CapabilityValidationError(reason);
    return result;
}

function normalizeTextArray(values: unknown[], maximum: number, maxLength: number): string[] {
    if (values.length > maximum) throw new CapabilityValidationError('too_many_values');
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (typeof value !== 'string') throw new CapabilityValidationError('invalid_text_value');
        const cleaned = cleanText(value, maxLength);
        const key = cleaned.toLocaleLowerCase('en-US');
        if (!cleaned || seen.has(key)) {
            throw new CapabilityValidationError('duplicate_text_value');
        }
        seen.add(key);
        result.push(cleaned);
    }
    return result;
}

function cleanText(value: string, maximum: number): string {
    return Array.from(value.normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ')
        .replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('');
}

function isDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
