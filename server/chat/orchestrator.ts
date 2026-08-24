import { GeminiProvider } from './providers/gemini.provider.js';
import { GroqProvider } from './providers/groq.provider.js';
import { generateWithFallback } from './retry.js';
import { PLANNER_SYSTEM_PROMPT } from './prompts/planner.prompt.js';
import { ANSWERER_SYSTEM_PROMPT } from './prompts/answerer.prompt.js';
import {
    ANSWER_OUTPUT_SCHEMA,
    CHAT_COMPARISON_TARGETS,
    CHAT_METRICS,
    CHAT_OUTPUT_PREFERENCES,
    CHAT_QUESTION_FOCUSES,
    CHAT_TOOL_NAMES,
    PLANNER_OUTPUT_SCHEMA,
    RECOMMENDATION_CATEGORIES,
} from './tools/schema.js';
import { executeToolPlans } from './tools/executor.js';
import type { FirebaseRestClient } from './firebase-rest.js';
import type {
    AnswerPacket,
    AuthenticatedChatUser,
    ChatAnswer,
    ChatAnswerBlock,
    ChatAnswerabilityOutcome,
    ChatComparisonTarget,
    ChatDisplayDirective,
    ChatDisplayMode,
    ChatFreshnessOutcome,
    ChatIntent,
    ChatMetric,
    ChatOutputPreference,
    ChatPresentation,
    ChatQuestionFocus,
    ChatStateContext,
    ChatStatePayload,
    ChatToolName,
    ClimateSuggestionsPresentation,
    EnergyBucket,
    EnergyRange,
    EnergyRangePreset,
    EnergyReportPresentation,
    EvidenceBackedRecommendation,
    GroundedAnswerDraft,
    GroundingFact,
    PlannerResult,
    PlannerToolPlan,
    RecentEventsPresentation,
    RoomScopeResolution,
    RoomTelemetryPresentation,
    SystemHelpPresentation,
    ToolExecutionResult,
} from './types/chat.types.js';
import { ChatApiError } from './types/chat.types.js';

const MANILA_TIME_ZONE = 'Asia/Manila';
const MAX_TOOLS = 4;
const MAX_PACKET_FACTS = 80;
const MAX_PACKET_NOTICES = 8;
const MAX_PACKET_BYTES = 48 * 1024;
const MAX_STATE_SUMMARY = 500;
const CHAT_INTENTS: readonly ChatIntent[] = ['data', 'help', 'greeting', 'control', 'unsupported'];
const ENERGY_RANGE_PRESETS: readonly EnergyRangePreset[] = [
    'today', 'this_week', 'last_week', 'last_7_days', 'this_month',
    'last_month', 'this_year', 'last_12_months', 'custom',
];
const ENERGY_BUCKETS: readonly EnergyBucket[] = ['auto', 'day', 'week', 'month', 'year'];
const SYSTEM_HELP_TOPICS = new Set([
    'change-password', 'add-room', 'edit-room', 'assign-floor-plan-cell',
    'floor-plan-legend', 'manage-schedules', 'approve-staff',
    'view-energy-reports', 'manual-override', 'forced-off', 'ocu-guide',
]);
const TELEMETRY_FOCUSES = new Set<ChatQuestionFocus>([
    'room_existence', 'current_temperature', 'last_known_temperature',
    'current_humidity', 'current_condition', 'device_status', 'ac_power_status',
    'ai_auto_apply_status', 'schedule_count', 'schedule_list',
]);
const CURRENT_MEASUREMENT_FOCUSES = new Set<ChatQuestionFocus>([
    'current_temperature', 'current_humidity', 'current_condition', 'ac_power_status',
]);
const ENERGY_FOCUSES = new Set<ChatQuestionFocus>([
    'energy_total', 'energy_rank_winner', 'energy_ranking', 'energy_trend',
    'energy_report', 'facility_efficiency_analysis',
]);
const TERMINAL_OUTCOMES = new Set<ChatAnswerabilityOutcome>([
    'room_not_found', 'room_inactive', 'room_ambiguous', 'no_online_reading',
    'no_energy_records', 'source_unavailable', 'insufficient_evidence',
    'clarification_required',
]);
const EXACT_ROW_CLAIM_FOCUSES = new Set<ChatQuestionFocus>([
    'current_temperature', 'last_known_temperature', 'current_humidity',
    'current_condition', 'device_status', 'ac_power_status', 'ai_auto_apply_status',
    'schedule_count', 'schedule_list', 'energy_total', 'energy_rank_winner',
    'energy_ranking', 'energy_trend', 'energy_report',
    'climate_suggestion', 'recent_events', 'facility_efficiency_analysis',
]);
const DETERMINISTIC_DIRECT_FOCUSES = new Set<ChatQuestionFocus>([
    'room_existence', 'current_temperature', 'last_known_temperature',
    'current_humidity', 'current_condition', 'device_status', 'ac_power_status',
    'ai_auto_apply_status', 'schedule_count', 'schedule_list', 'system_help',
]);
const NO_VISUAL_DETERMINISTIC_FOCUSES = new Set<ChatQuestionFocus>([
    'energy_ranking', 'energy_trend', 'energy_report', 'climate_suggestion',
    'recent_events', 'facility_efficiency_analysis',
]);
const GROUNDING_GLUE_TOKENS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'cannot',
    'data', 'does', 'each', 'for', 'from', 'had', 'has', 'have', 'in', 'is', 'it',
    'its', 'of', 'on', 'only', 'or', 'report', 'result', 'results', 'summary', 'than',
    'that', 'the', 'their', 'these', 'this', 'those', 'through', 'to', 'was', 'were',
    'which', 'while', 'with', 'without', 'details', 'energy', 'estimated', 'ranking',
    'reading', 'readings', 'configuration', 'configured', 'schedule', 'schedules',
    'temperature', 'humidity', 'status',
]);
const textEncoder = new TextEncoder();
const geminiProvider = new GeminiProvider();
const groqProvider = new GroqProvider();

export interface RunChatTurnRequest {
    readonly requestId: string;
    readonly message: string;
    readonly user: AuthenticatedChatUser;
    readonly state: ChatStatePayload | null;
    readonly firebase: FirebaseRestClient;
    readonly now?: Date;
    readonly abortSignal?: AbortSignal;
}

export interface ChatTurnCoreResult {
    readonly questionFocus: ChatQuestionFocus;
    readonly answer: ChatAnswer;
    readonly presentations: ChatPresentation[];
    readonly displayPlan: ChatDisplayDirective[];
    readonly partial: boolean;
    readonly notices: string[];
    readonly stateSummary: string;
    readonly stateContext: ChatStateContext;
}

export async function runChatTurn(request: RunChatTurnRequest): Promise<ChatTurnCoreResult> {
    const now = request.now ?? new Date();
    const planned = await generateWithFallback<PlannerResult>(geminiProvider, groqProvider, {
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        prompt: buildPlannerPrompt(request.message, request.state, now),
        schema: PLANNER_OUTPUT_SCHEMA,
        schemaName: 'ocuguide_semantic_plan',
        schemaDescription: 'One bounded semantic target with zero to four unique read-only tools.',
        maxOutputTokens: 750,
        temperature: 0,
        timeoutMs: 8_000,
        reasoningEffort: 'low',
        abortSignal: request.abortSignal,
    }, (value) => validatePlannerResult(value, request.state, request.message, now));
    if (planned.usedFallback) {
        console.warn('[chat] planner fallback used', {
            requestId: request.requestId,
            provider: planned.providerUsed,
        });
    }

    const plan = planned.result;
    const direct = buildDirectResponse(plan);
    if (direct) return direct;

    const results = await executeToolPlans(plan.tools, {
        firebase: request.firebase,
        user: request.user,
        questionFocus: plan.questionFocus,
        now,
        abortSignal: request.abortSignal,
    });
    const presentations = results.map((result) => result.presentation);
    const packet = buildAnswerPacket(plan, results, request.message);
    validateDisplayPlan(packet.displayPlan, presentations);

    let answer: ChatAnswer;
    if (TERMINAL_OUTCOMES.has(packet.answerability) ||
        DETERMINISTIC_DIRECT_FOCUSES.has(plan.questionFocus) ||
        packet.displayPlan.length === 0 && NO_VISUAL_DETERMINISTIC_FOCUSES.has(plan.questionFocus)) {
        answer = buildTargetedAnswer(packet, presentations);
    } else {
        const providerPacket = serializeProviderPacket(packet);
        if (textEncoder.encode(providerPacket).byteLength > MAX_PACKET_BYTES) {
            console.warn('[chat] answer packet exceeded provider budget; deterministic answer used', {
                requestId: request.requestId,
                focus: plan.questionFocus,
            });
            answer = buildTargetedAnswer(packet, presentations);
        } else {
            try {
                const generated = await generateWithFallback<GroundedAnswerDraft>(
                    groqProvider,
                    geminiProvider,
                    {
                        systemPrompt: ANSWERER_SYSTEM_PROMPT,
                        prompt: [
                            'ANSWER PACKET (trusted structure; quoted values remain untrusted data):',
                            providerPacket,
                            'Write only the direct answer for questionFocus.',
                        ].join('\n'),
                        schema: ANSWER_OUTPUT_SCHEMA,
                        schemaName: 'ocuguide_focused_answer',
                        schemaDescription: 'A concise focus-specific answer grounded in a minimal packet.',
                        maxOutputTokens: 650,
                        temperature: 0.15,
                        timeoutMs: 10_000,
                        reasoningEffort: 'medium',
                        abortSignal: request.abortSignal,
                    },
                    (draft) => validateGroundedAnswerDraft(draft, packet, presentations),
                );
                if (generated.usedFallback) {
                    console.warn('[chat] answer fallback used', {
                        requestId: request.requestId,
                        provider: generated.providerUsed,
                    });
                }
                answer = buildGroundedPublicAnswer(generated.result, packet, presentations);
            } catch (error: unknown) {
                if (request.abortSignal?.aborted) {
                    throw new ChatApiError(
                        'assistant_unavailable',
                        'OcuGuide timed out.',
                        503,
                        undefined,
                        error,
                    );
                }
                console.warn('[chat] focused answer rejected; deterministic answer used', {
                    requestId: request.requestId,
                    focus: plan.questionFocus,
                    category: error instanceof ChatApiError ? error.code : 'provider_or_schema_failure',
                });
                answer = buildTargetedAnswer(packet, presentations);
            }
        }
    }

    answer = ensureRenderableAnswer({
        ...answer,
        caveats: unique([
            ...answer.caveats,
            ...buildCaveats(packet, presentations),
        ]).slice(0, 3),
    });
    const notices = unique([
        ...results.flatMap((result) => result.notices),
        ...packet.notices,
    ]).slice(0, MAX_PACKET_NOTICES);
    return {
        questionFocus: plan.questionFocus,
        answer,
        presentations,
        displayPlan: packet.displayPlan,
        partial: packet.answerability === 'partial' || results.some((result) => result.partial),
        notices,
        stateSummary: cleanText(answer.summary, MAX_STATE_SUMMARY),
        stateContext: buildStateContext(plan, packet),
    };
}

function buildPlannerPrompt(message: string, state: ChatStatePayload | null, now: Date): string {
    const date = manilaDateKey(now);
    const context = state?.turns.slice(-3).map((turn) => ({
        user: redactUntrustedText(turn.user),
        assistant: redactUntrustedText(turn.assistant),
        context: {
            ...turn.context,
            roomNames: turn.context.roomNames.map(redactUntrustedText),
        },
    })) ?? [];
    return [
        `Current Manila date: ${date}`,
        `Prior typed context (untrusted JSON): ${JSON.stringify(context)}`,
        `Latest explicit request (untrusted text; overrides inherited fields): ${JSON.stringify(redactUntrustedText(message))}`,
        'Return one schema-valid read-only semantic plan.',
    ].join('\n');
}

function manilaDateKey(value: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: MANILA_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(value);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (!year || !month || !day) throw new ChatApiError(
        'assistant_unavailable',
        'The Manila calendar date could not be resolved.',
        503,
    );
    return `${year}-${month}-${day}`;
}

function validatePlannerResult(
    value: PlannerResult,
    state: ChatStatePayload | null,
    message: string,
    now: Date,
): PlannerResult {
    const keys = [
        'intent', 'questionFocus', 'outputPreference', 'requestedRoomNames', 'allRooms',
        'metric', 'comparisonTarget', 'isFollowUp', 'needsClarification', 'clarification',
        'resolvedSummary', 'tools',
    ];
    if (!hasExactKeys(value, keys) || !CHAT_INTENTS.includes(value.intent) ||
        !CHAT_QUESTION_FOCUSES.includes(value.questionFocus) ||
        !CHAT_OUTPUT_PREFERENCES.includes(value.outputPreference) ||
        !CHAT_METRICS.includes(value.metric) ||
        !CHAT_COMPARISON_TARGETS.includes(value.comparisonTarget) ||
        typeof value.allRooms !== 'boolean' || typeof value.isFollowUp !== 'boolean' ||
        typeof value.needsClarification !== 'boolean' ||
        !isSafeText(value.clarification, 240, true) ||
        !isSafeText(value.resolvedSummary, 300, true) ||
        !Array.isArray(value.requestedRoomNames) || value.requestedRoomNames.length > 50 ||
        !Array.isArray(value.tools) || value.tools.length > MAX_TOOLS) {
        throw invalidProviderPlan();
    }
    const requestedRoomNames = normalizeUniqueNames(value.requestedRoomNames);
    if (value.allRooms && requestedRoomNames.length > 0) throw invalidProviderPlan();
    if (value.isFollowUp && !state?.turns.length) throw invalidProviderPlan();

    const seen = new Set<ChatToolName>();
    const tools = value.tools.map((tool) => validateToolPlan(tool, seen));
    if (value.needsClarification) {
        if (!value.clarification.trim() || tools.length > 0 ||
            ['greeting', 'control', 'unsupported'].includes(value.intent)) throw invalidProviderPlan();
    } else if (value.clarification.trim()) {
        throw invalidProviderPlan();
    }

    validateIntentFocus(value.intent, value.questionFocus, value.needsClarification, tools);
    validateFocusTools(value.questionFocus, tools, value.needsClarification);
    validateScope(value, requestedRoomNames, tools);
    validateMetricAndComparison(value.questionFocus, value.metric, value.comparisonTarget);
    validateAnalysisRange(value, tools, message);
    validateExplicitEnergySemantics(value, tools, message, now);
    validateExplicitOutputPreference(value.outputPreference, message);
    validateInheritedContext(value, tools, state, message);

    return {
        ...value,
        clarification: normalizeText(value.clarification),
        resolvedSummary: normalizeText(value.resolvedSummary),
        requestedRoomNames,
        tools,
    };
}

function validateExplicitOutputPreference(
    preference: ChatOutputPreference,
    message: string,
): void {
    const normalized = normalizeForComparison(message);
    const negatedTable = /\b(?:(?:do\s+not|don['’]?t|dont|never)\s+(?:show|use|give|display)|(?:show|use|give|display)\s+no)\b.{0,20}\btable\b|\bwithout\s+(?:a\s+)?table\b/u.test(normalized);
    const negatedGraph = /\b(?:(?:do\s+not|don['’]?t|dont|never)\s+(?:show|use|give|display)|(?:show|use|give|display)\s+no)\b.{0,20}\b(?:graph|chart)\b|\bwithout\s+(?:a\s+)?(?:graph|chart)\b/u.test(normalized);
    const textOnly = /\btext\s*only\b|\bno\s+(?:table|graph|chart|visual)\b/u.test(normalized) ||
        negatedTable || negatedGraph;
    const showTable = !negatedTable && /\b(?:show|use|give|display)\b.{0,20}\btable\b/u.test(normalized);
    const showGraph = !negatedGraph && /\b(?:show|use|give|display)\b.{0,20}\b(?:graph|chart)\b/u.test(normalized);
    if (showTable && showGraph) throw invalidProviderPlan();
    const expected: ChatOutputPreference | null = showTable ? 'table'
        : showGraph ? 'graph'
            : textOnly ? 'text' : null;
    if (expected !== null && preference !== expected) throw invalidProviderPlan();
}

function validateInheritedContext(
    plan: PlannerResult,
    tools: readonly PlannerToolPlan[],
    state: ChatStatePayload | null,
    message: string,
): void {
    const previous = state?.turns.at(-1)?.context;
    if (plan.questionFocus === 'energy_rank_winner' && !hasExplicitEnergyPeriod(message)) {
        const canInheritEnergyScope = previous?.toolNames.includes('get_energy_report') === true;
        if (!canInheritEnergyScope) {
            if (!plan.needsClarification || plan.isFollowUp ||
                !plan.allRooms && plan.requestedRoomNames.length === 0) throw invalidProviderPlan();
            return;
        }
        if (plan.needsClarification || !plan.isFollowUp) throw invalidProviderPlan();
    }
    if (!plan.isFollowUp) return;
    if (!previous) throw invalidProviderPlan();
    if (!hasExplicitRoomScope(message)) {
        if (plan.allRooms !== previous.allRooms) throw invalidProviderPlan();
        if (!plan.allRooms && !sameNames(plan.requestedRoomNames, previous.roomNames)) {
            throw invalidProviderPlan();
        }
    }
    if (ENERGY_FOCUSES.has(plan.questionFocus) && !hasExplicitEnergyPeriod(message)) {
        const energy = tools.find((tool) => tool.name === 'get_energy_report');
        if (!energy) throw invalidProviderPlan();
        if (previous.toolNames.includes('get_energy_report')) {
            if (energy.rangePreset !== previous.rangePreset ||
                energy.startDate !== previous.startDate || energy.endDate !== previous.endDate ||
                energy.bucket !== previous.bucket) throw invalidProviderPlan();
        } else {
            const defaultPreset = plan.questionFocus === 'facility_efficiency_analysis'
                ? 'this_year'
                : 'this_month';
            if (energy.rangePreset !== defaultPreset) throw invalidProviderPlan();
        }
    }
}

function validateAnalysisRange(
    plan: PlannerResult,
    tools: readonly PlannerToolPlan[],
    message: string,
): void {
    if (plan.questionFocus !== 'facility_efficiency_analysis') return;
    const energy = tools.find((tool) => tool.name === 'get_energy_report');
    if (!energy) throw invalidProviderPlan();
    if (!plan.isFollowUp && !hasExplicitEnergyPeriod(message) && energy.rangePreset !== 'this_year') {
        throw invalidProviderPlan();
    }
    const events = tools.find((tool) => tool.name === 'get_recent_room_events');
    if (events && (events.rangePreset !== energy.rangePreset ||
        events.startDate !== energy.startDate || events.endDate !== energy.endDate ||
        events.bucket !== energy.bucket)) throw invalidProviderPlan();
}

function validateExplicitEnergySemantics(
    plan: PlannerResult,
    tools: readonly PlannerToolPlan[],
    message: string,
    now: Date,
): void {
    const energy = tools.find((tool) => tool.name === 'get_energy_report');
    if (!energy) return;
    const normalized = normalizeForComparison(message);
    const today = manilaDateKey(now);
    const currentYear = Number(today.slice(0, 4));
    let fullYearRangeRequested = false;
    const dateKeys = normalized.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
    if (dateKeys.length >= 2) {
        assertCustomEnergyRange(energy, dateKeys[0]!, dateKeys[1]!);
    } else if (dateKeys.length === 1) {
        const date = dateKeys[0]!;
        const escapedDate = date.replace(/-/gu, '\\-');
        if (new RegExp(`\\b(?:since|from|starting(?:\\s+on)?)\\s+${escapedDate}\\b`, 'u').test(normalized)) {
            assertCustomEnergyRange(energy, date, today);
        } else if (new RegExp(
            `\\b(?:before|after|through|until|ending(?:\\s+on)?)\\s+${escapedDate}\\b`,
            'u',
        ).test(normalized)) {
            throw invalidProviderPlan();
        } else {
            assertCustomEnergyRange(energy, date, date);
        }
    } else {
        const withoutDates = normalized.replace(/\b\d{4}-\d{2}-\d{2}\b/gu, ' ');
        const years = unique(withoutDates.match(/\b(?:19|20)\d{2}\b/gu) ?? [])
            .map(Number)
            .sort((left, right) => left - right);
        const quarter = withoutDates.match(/\bq([1-4])(?:\s+of)?\s+((?:19|20)\d{2})\b/u);
        const reversedQuarter = withoutDates.match(/\b((?:19|20)\d{2})\s+q([1-4])\b/u);
        const month = withoutDates.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:of\s+)?((?:19|20)\d{2})\b/u) ??
            withoutDates.match(/\b((?:19|20)\d{2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/u);
        if (quarter || reversedQuarter) {
            const quarterNumber = Number(quarter?.[1] ?? reversedQuarter?.[2]);
            const year = Number(quarter?.[2] ?? reversedQuarter?.[1]);
            const startMonth = (quarterNumber - 1) * 3 + 1;
            const endMonth = startMonth + 2;
            const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
            const calendarEnd = `${year}-${String(endMonth).padStart(2, '0')}-${String(daysInMonth(year, endMonth)).padStart(2, '0')}`;
            assertCustomEnergyRange(energy, start, calendarEnd > today ? today : calendarEnd);
        } else if (month) {
            const monthFirst = month[1]?.match(/^\d{4}$/u) ? month[2]! : month[1]!;
            const yearText = month[1]?.match(/^\d{4}$/u) ? month[1]! : month[2]!;
            const monthNumber = namedMonthNumber(monthFirst);
            const year = Number(yearText);
            const start = `${year}-${String(monthNumber).padStart(2, '0')}-01`;
            const calendarEnd = `${year}-${String(monthNumber).padStart(2, '0')}-${String(daysInMonth(year, monthNumber)).padStart(2, '0')}`;
            assertCustomEnergyRange(energy, start, calendarEnd > today ? today : calendarEnd);
        } else if (years.length > 0) {
            fullYearRangeRequested = true;
            const firstYear = years[0]!;
            const lastYear = years.at(-1)!;
            const expectedStart = `${firstYear}-01-01`;
            const expectedEnd = lastYear === currentYear ? today : `${lastYear}-12-31`;
            if (firstYear === currentYear && lastYear === currentYear) {
                if (energy.rangePreset !== 'this_year' &&
                    !(energy.rangePreset === 'custom' && energy.startDate === expectedStart &&
                        energy.endDate === expectedEnd)) throw invalidProviderPlan();
            } else {
                assertCustomEnergyRange(energy, expectedStart, expectedEnd);
            }
        } else {
            const expectedPreset = explicitPreset(normalized);
            if (expectedPreset && energy.rangePreset !== expectedPreset) throw invalidProviderPlan();
            if (expectedPreset === 'this_year') fullYearRangeRequested = true;
            if (/\byesterday\b/u.test(normalized)) {
                const yesterday = addDateKeyDays(today, -1);
                assertCustomEnergyRange(energy, yesterday, yesterday);
            }
            if (/\b(?:last|previous)\s+year\b/u.test(normalized)) {
                fullYearRangeRequested = true;
                const year = currentYear - 1;
                assertCustomEnergyRange(energy, `${year}-01-01`, `${year}-12-31`);
            }
        }
    }

    const explicitBucket: EnergyBucket | null = /\b(?:daily|by\s+day|per\s+day)\b/u.test(normalized)
        ? 'day'
        : /\b(?:weekly|by\s+week|per\s+week)\b/u.test(normalized)
            ? 'week'
            : /\b(?:monthly|by\s+month|per\s+month)\b/u.test(normalized)
                ? 'month'
                : /\b(?:by\s+year|per\s+year)\b/u.test(normalized)
                    ? 'year'
                    : null;
    if (explicitBucket && energy.bucket !== explicitBucket) throw invalidProviderPlan();
    if ((plan.questionFocus === 'energy_report' || plan.questionFocus === 'energy_trend') &&
        fullYearRangeRequested && explicitBucket === null &&
        energy.bucket !== 'auto' && energy.bucket !== 'month') throw invalidProviderPlan();
}

function assertCustomEnergyRange(
    tool: PlannerToolPlan,
    startDate: string,
    endDate: string,
): void {
    if (tool.rangePreset !== 'custom' || tool.startDate !== startDate ||
        tool.endDate !== endDate) throw invalidProviderPlan();
}

function explicitPreset(value: string): EnergyRangePreset | null {
    if (/\b(?:last|past)\s+12\s+months\b/u.test(value)) return 'last_12_months';
    if (/\b(?:last|past)\s+7\s+days\b/u.test(value)) return 'last_7_days';
    if (/\b(?:last|previous)\s+week\b/u.test(value)) return 'last_week';
    if (/\bthis\s+week\b/u.test(value)) return 'this_week';
    if (/\b(?:last|previous)\s+month\b/u.test(value)) return 'last_month';
    if (/\bthis\s+month\b/u.test(value)) return 'this_month';
    if (/\b(?:whole[- ]year|this\s+year|current\s+year)\b/u.test(value) ||
        /\b(?:annual|yearly)\b/u.test(value) &&
        !/\b(?:last|previous)\s+year\b/u.test(value)) return 'this_year';
    if (/\btoday\b/u.test(value)) return 'today';
    return null;
}

function namedMonthNumber(value: string): number {
    const month = [
        'january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december',
    ].indexOf(value);
    if (month < 0) throw invalidProviderPlan();
    return month + 1;
}

function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDateKeyDays(value: string, days: number): string {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    parsed.setUTCDate(parsed.getUTCDate() + days);
    return parsed.toISOString().slice(0, 10);
}

function validateToolPlan(tool: PlannerToolPlan, seen: Set<ChatToolName>): PlannerToolPlan {
    if (!hasExactKeys(tool, [
        'name', 'roomNames', 'rangePreset', 'startDate', 'endDate', 'bucket',
        'topic', 'limit', 'includeLastKnown',
    ]) || !CHAT_TOOL_NAMES.includes(tool.name) || seen.has(tool.name) ||
        !Array.isArray(tool.roomNames) || tool.roomNames.length > 50 ||
        !ENERGY_RANGE_PRESETS.includes(tool.rangePreset) ||
        !ENERGY_BUCKETS.includes(tool.bucket) ||
        !isSafeText(tool.startDate, 10, true) || !isSafeText(tool.endDate, 10, true) ||
        !isSafeText(tool.topic, 64, true) ||
        !Number.isInteger(tool.limit) || tool.limit < 1 || tool.limit > 25 ||
        typeof tool.includeLastKnown !== 'boolean') throw invalidProviderPlan();
    seen.add(tool.name);
    const roomNames = normalizeUniqueNames(tool.roomNames);
    if (tool.rangePreset === 'custom') {
        if (!isIsoCalendarDate(tool.startDate) || !isIsoCalendarDate(tool.endDate) ||
            tool.startDate > tool.endDate) throw invalidProviderPlan();
    } else if (tool.startDate || tool.endDate) throw invalidProviderPlan();
    const topic = normalizeText(tool.topic).toLocaleLowerCase('en-US').replace(/[\s_]+/gu, '-');
    if (tool.name === 'get_system_help' && !SYSTEM_HELP_TOPICS.has(topic)) throw invalidProviderPlan();
    return { ...tool, roomNames, topic };
}

function validateIntentFocus(
    intent: ChatIntent,
    focus: ChatQuestionFocus,
    clarification: boolean,
    tools: readonly PlannerToolPlan[],
): void {
    const expected: ChatIntent = focus === 'system_help' ? 'help'
        : focus === 'greeting' ? 'greeting'
            : focus === 'control_request' ? 'control'
                : focus === 'unsupported' ? 'unsupported'
                    : 'data';
    if (intent !== expected) throw invalidProviderPlan();
    if (clarification) return;
    if (['greeting', 'control', 'unsupported'].includes(intent) && tools.length > 0) {
        throw invalidProviderPlan();
    }
}

function validateFocusTools(
    focus: ChatQuestionFocus,
    tools: readonly PlannerToolPlan[],
    clarification: boolean,
): void {
    if (clarification) return;
    const names = new Set(tools.map((tool) => tool.name));
    const exactly = (name: ChatToolName): boolean => names.size === 1 && names.has(name);
    if (TELEMETRY_FOCUSES.has(focus) && !exactly('get_room_telemetry')) throw invalidProviderPlan();
    if (ENERGY_FOCUSES.has(focus)) {
        if (!names.has('get_energy_report')) throw invalidProviderPlan();
        if (focus === 'facility_efficiency_analysis') {
            if (!names.has('get_room_telemetry') || names.has('get_system_help') ||
                names.has('get_climate_prediction_logs')) throw invalidProviderPlan();
        } else if (!exactly('get_energy_report')) throw invalidProviderPlan();
    }
    if (focus === 'climate_suggestion' && !exactly('get_climate_prediction_logs')) {
        throw invalidProviderPlan();
    }
    if (focus === 'recent_events' && !exactly('get_recent_room_events')) throw invalidProviderPlan();
    if (focus === 'system_help' && !exactly('get_system_help')) throw invalidProviderPlan();
    if (['greeting', 'control_request', 'unsupported'].includes(focus) && names.size > 0) {
        throw invalidProviderPlan();
    }
}

function validateScope(
    plan: PlannerResult,
    names: readonly string[],
    tools: readonly PlannerToolPlan[],
): void {
    const dataFocus = !['greeting', 'control_request', 'unsupported', 'system_help'].includes(
        plan.questionFocus,
    );
    if (!dataFocus && (plan.allRooms || names.length > 0)) throw invalidProviderPlan();
    if (!plan.needsClarification && dataFocus && !plan.allRooms && names.length === 0) {
        throw invalidProviderPlan();
    }
    for (const tool of tools) {
        if (tool.name === 'get_system_help') continue;
        if (plan.allRooms) {
            if (tool.roomNames.length > 0) throw invalidProviderPlan();
        } else if (!sameNames(tool.roomNames, names)) throw invalidProviderPlan();
        if (tool.includeLastKnown !== (plan.questionFocus === 'last_known_temperature')) {
            throw invalidProviderPlan();
        }
    }
}

function validateMetricAndComparison(
    focus: ChatQuestionFocus,
    metric: ChatMetric,
    comparison: ChatComparisonTarget,
): void {
    const expectedMetric: Partial<Record<ChatQuestionFocus, ChatMetric>> = {
        current_temperature: 'temperature', last_known_temperature: 'temperature',
        current_humidity: 'humidity', current_condition: 'condition', device_status: 'device_status',
        ac_power_status: 'ac_power', ai_auto_apply_status: 'ai_auto_apply',
        schedule_count: 'schedule_count', energy_total: 'estimated_kwh',
        energy_rank_winner: 'estimated_kwh', energy_ranking: 'estimated_kwh',
        energy_trend: 'estimated_kwh', energy_report: 'estimated_kwh',
        facility_efficiency_analysis: 'estimated_kwh',
    };
    if ((expectedMetric[focus] ?? 'none') !== metric) throw invalidProviderPlan();
    const expectedComparison: ChatComparisonTarget = focus === 'energy_rank_winner' ? 'winner'
        : focus === 'energy_trend' ? 'trend'
            : focus === 'energy_ranking' ? 'rooms'
                : 'none';
    if (comparison !== expectedComparison) throw invalidProviderPlan();
}

function buildDirectResponse(plan: PlannerResult): ChatTurnCoreResult | null {
    let headline: string;
    let summary: string;
    let answerability: ChatAnswerabilityOutcome;
    if (plan.needsClarification) {
        headline = 'One detail is needed';
        summary = plan.clarification;
        answerability = 'clarification_required';
    } else if (plan.questionFocus === 'greeting') {
        headline = 'How can I help?';
        summary = 'I can check OcuTemp room status, current readings, schedules, AI auto-apply configuration, estimated energy, recent events, and verified app guidance.';
        answerability = 'not_applicable';
    } else if (plan.questionFocus === 'control_request') {
        headline = 'Read-only assistance';
        summary = 'I cannot change AC controls or facility data. I can check the room’s verified status before you use the authorized OcuTemp controls.';
        answerability = 'not_applicable';
    } else if (plan.questionFocus === 'unsupported') {
        headline = 'Outside OcuGuide’s scope';
        summary = 'I can answer only from verified OcuTemp facility data or verified OcuTemp help.';
        answerability = 'not_applicable';
    } else return null;

    const packet: AnswerPacket = {
        questionFocus: plan.questionFocus,
        scope: emptyScope(plan.requestedRoomNames),
        range: null,
        answerability,
        freshness: 'not_applicable',
        facts: [],
        recommendations: [],
        notices: [],
        displayPlan: [],
    };
    return {
        questionFocus: plan.questionFocus,
        answer: ensureRenderableAnswer({
            headline,
            summary,
            blocks: [],
            highlights: [],
            caveats: [],
        }),
        presentations: [],
        displayPlan: [],
        partial: false,
        notices: [],
        stateSummary: summary,
        stateContext: buildStateContext(plan, packet),
    };
}

function buildAnswerPacket(
    plan: PlannerResult,
    results: readonly ToolExecutionResult[],
    userMessage: string,
): AnswerPacket {
    const presentations = results.map((result) => result.presentation);
    const scope = mergeScopes(results.map((result) => result.scope), plan.requestedRoomNames);
    const notices = unique(results.flatMap((result) => result.notices)).slice(0, MAX_PACKET_NOTICES);
    const facts: GroundingFact[] = [];
    const recommendations: EvidenceBackedRecommendation[] = [];
    const addFact = (id: string, statement: string): string => {
        if (facts.length < MAX_PACKET_FACTS) facts.push({ id, statement: cleanText(statement, 700) });
        return id;
    };

    let answerability: ChatAnswerabilityOutcome = requiredResultsUnavailable(
        plan.questionFocus,
        results,
    )
        ? 'source_unavailable'
        : scopeAnswerability(scope, plan);
    const scopePartial = scope.matchedRoomNames.length > 0 &&
        (scope.missingRoomNames.length > 0 || scope.inactiveRoomNames.length > 0 ||
            scope.ambiguousRoomNames.length > 0);
    let freshness: ChatFreshnessOutcome = 'not_applicable';
    let range: EnergyRange | null = null;
    if (answerability === 'room_not_found') {
        addFact('scope.not_found', notFoundStatement(scope));
    } else if (answerability === 'room_inactive') {
        addFact('scope.inactive', inactiveStatement(scope));
    } else if (answerability === 'room_ambiguous') {
        addFact('scope.ambiguous', ambiguousStatement(scope));
    } else if (answerability === 'source_unavailable') {
        addFact('source.unavailable', 'The requested OcuTemp data source is temporarily unavailable; no missing value was treated as zero or off.');
    } else {
        if (scope.missingRoomNames.length > 0) addFact(
            'scope.partial_missing',
            `${joinNames(scope.missingRoomNames)} ${scope.missingRoomNames.length === 1 ? 'is' : 'are'} not configured in OcuTemp; only verified matched rooms were used.`,
        );
        if (scope.inactiveRoomNames.length > 0) addFact(
            'scope.partial_inactive',
            `${joinNames(scope.inactiveRoomNames)} ${scope.inactiveRoomNames.length === 1 ? 'exists' : 'exist'} but ${scope.inactiveRoomNames.length === 1 ? 'is' : 'are'} inactive; only verified active matches were used.`,
        );
        if (scope.ambiguousRoomNames.length > 0) addFact(
            'scope.partial_ambiguous',
            `${joinNames(scope.ambiguousRoomNames)} ${scope.ambiguousRoomNames.length === 1 ? 'matches' : 'match'} more than one configured room and ${scope.ambiguousRoomNames.length === 1 ? 'was' : 'were'} not selected; only unambiguous verified matches were used.`,
        );
        const telemetry = findPresentation(presentations, 'room-telemetry');
        const energy = findPresentation(presentations, 'energy-report');
        const climate = findPresentation(presentations, 'climate-suggestions');
        const events = findPresentation(presentations, 'recent-events');
        const help = findPresentation(presentations, 'system-help');
        range = energy?.range ?? null;
        const derived = selectFocusFacts({
            plan, telemetry, energy, climate, events, help, userMessage,
            addFact, recommendations,
        });
        answerability = derived.answerability;
        freshness = derived.freshness;
    }

    if (scopePartial && answerability === 'answerable') answerability = 'partial';
    if (results.some((result) => result.partial) && answerability === 'answerable') {
        answerability = 'partial';
    }
    const displayPlan = deriveDisplayPlan(plan, answerability, presentations);
    return {
        questionFocus: plan.questionFocus,
        scope,
        range,
        answerability,
        freshness,
        facts: facts.slice(0, MAX_PACKET_FACTS),
        recommendations: recommendations.slice(0, 5),
        notices,
        displayPlan,
    };
}

interface FocusSelectionInput {
    readonly plan: PlannerResult;
    readonly telemetry: RoomTelemetryPresentation | undefined;
    readonly energy: EnergyReportPresentation | undefined;
    readonly climate: ClimateSuggestionsPresentation | undefined;
    readonly events: RecentEventsPresentation | undefined;
    readonly help: SystemHelpPresentation | undefined;
    readonly userMessage: string;
    readonly addFact: (id: string, statement: string) => string;
    readonly recommendations: EvidenceBackedRecommendation[];
}

function selectFocusFacts(input: FocusSelectionInput): {
    readonly answerability: ChatAnswerabilityOutcome;
    readonly freshness: ChatFreshnessOutcome;
} {
    const { plan, telemetry, energy, climate, events, help, addFact, recommendations } = input;
    if (TELEMETRY_FOCUSES.has(plan.questionFocus)) {
        if (!telemetry) return unavailableSelection();
        const freshness = telemetryFreshness(telemetry);
        if (CURRENT_MEASUREMENT_FOCUSES.has(plan.questionFocus)) {
            const usable = telemetry.rooms.filter((room) => room.measurementStatus === 'current' &&
                (plan.questionFocus === 'current_temperature' ? room.temperature !== null
                    : plan.questionFocus === 'current_humidity' ? room.humidity !== null
                        : plan.questionFocus === 'current_condition' ? room.condition !== 'unknown'
                            : room.acPower !== null));
            if (usable.length === 0) {
                addFact('telemetry.no_current', `No current ${focusMeasurementLabel(plan.questionFocus)} can be reported because none of the ${telemetry.rooms.length} selected active ${plural(telemetry.rooms.length, 'room')} has an online device with that current measurement.`);
                return { answerability: 'no_online_reading', freshness };
            }
            for (const [index, room] of usable.entries()) {
                const value = plan.questionFocus === 'current_temperature' ? `${room.temperature} °C`
                    : plan.questionFocus === 'current_humidity' ? `${room.humidity}% relative humidity`
                        : plan.questionFocus === 'current_condition' ? room.condition
                            : room.acPower ? 'on' : 'off';
                const conditionReadings = plan.questionFocus === 'current_condition'
                    ? `${room.temperature === null ? '' : `; current temperature is ${room.temperature} °C`}${room.humidity === null ? '' : `; current humidity is ${room.humidity}%`}`
                    : '';
                addFact(`telemetry.current.${index + 1}`, `${room.roomName}'s current ${focusMeasurementLabel(plan.questionFocus)} is ${value}${conditionReadings}; its device is online${room.lastSeen ? ` with last contact at ${room.lastSeen}` : ''}.`);
            }
            const unavailableCount = telemetry.rooms.length - usable.length;
            if (unavailableCount > 0) {
                addFact('telemetry.current.partial', `${unavailableCount} of ${telemetry.rooms.length} selected active ${plural(telemetry.rooms.length, 'room')} ${unavailableCount === 1 ? 'does' : 'do'} not have a current online ${focusMeasurementLabel(plan.questionFocus)} available.`);
            }
            if (plan.questionFocus === 'current_condition' && /\bwhy\b/iu.test(input.userMessage)) {
                const hot = usable.filter((room) => room.condition === 'hot' || room.condition === 'critical');
                if (hot.length === 0) addFact(
                    'telemetry.not_hot',
                    `${usable.length === 1 ? usable[0]!.roomName : 'The selected online rooms'} ${usable.length === 1 ? 'is' : 'are'} not currently classified as hot or critical by OcuTemp.`,
                );
                else addFact('telemetry.cause_unknown', 'OcuTemp has a verified current hot or critical observation, but the available evidence does not establish its cause.');
            }
            return { answerability: unavailableCount > 0 ? 'partial' : 'answerable', freshness };
        }
        if (plan.questionFocus === 'last_known_temperature') {
            const rows = telemetry.rooms.filter((room) => room.temperature !== null && room.lastSeen !== null);
            if (rows.length === 0) {
                addFact('telemetry.no_last_known', 'No valid last-known temperature with a timestamp is available for the selected active room scope.');
                return { answerability: 'insufficient_evidence', freshness };
            }
            rows.forEach((room, index) => addFact(
                `telemetry.last_known.${index + 1}`,
                room.measurementStatus === 'current'
                    ? `${room.roomName}'s latest temperature is ${room.temperature} °C from ${room.lastSeen}; it is a current reading and the device is online.`
                    : `${room.roomName}'s last-known temperature is ${room.temperature} °C from ${room.lastSeen}; it is not a current reading and the device state is ${room.onlineState}.`,
            ));
            return { answerability: rows.length < telemetry.rooms.length ? 'partial' : 'answerable', freshness };
        }
        if (plan.questionFocus === 'room_existence') {
            addFact('scope.exists', telemetry.rooms.length === 1
                ? `${telemetry.rooms[0]!.roomName} is configured and active in OcuTemp.`
                : `${telemetry.rooms.length} requested rooms are configured and active in OcuTemp: ${joinNames(telemetry.rooms.map((room) => room.roomName))}.`);
        } else if (plan.questionFocus === 'device_status') {
            telemetry.rooms.forEach((room, index) => addFact(
                `telemetry.status.${index + 1}`,
                room.deviceAssignmentStatus === 'not_assigned'
                    ? `${room.roomName} has no assigned device in OcuTemp.`
                    : room.deviceAssignmentStatus === 'unavailable'
                        ? `${room.roomName} has an assigned device, but its device data is unavailable.`
                        : `${room.roomName}'s assigned device status is ${room.onlineState}${room.lastSeen ? `; last contact was ${room.lastSeen}` : '; no valid last-contact timestamp is available'}.`,
            ));
        } else if (plan.questionFocus === 'ai_auto_apply_status') {
            telemetry.rooms.forEach((room, index) => addFact(
                `telemetry.ai.${index + 1}`,
                room.deviceAssignmentStatus === 'not_assigned'
                    ? `${room.roomName} has no assigned device, so no device AI auto-apply configuration is available.`
                    : room.deviceAssignmentStatus === 'unavailable'
                        ? `${room.roomName} has an assigned device, but its AI auto-apply configuration is unavailable.`
                        : `${room.roomName}'s stored OcuTemp AI auto-apply configuration is ${room.aiAutoApply === null ? 'unknown' : room.aiAutoApply ? 'enabled' : 'disabled'}; its device status is ${room.onlineState}${room.onlineState === 'online' ? '' : ', so current device application cannot be confirmed'}.`,
            ));
        } else if (plan.questionFocus === 'schedule_count') {
            const total = telemetry.rooms.reduce((sum, room) => sum + room.schedules.length, 0);
            addFact('schedule.total', `${total} valid configured ${plural(total, 'schedule')} ${total === 1 ? 'is' : 'are'} stored across ${telemetry.rooms.length} selected active ${plural(telemetry.rooms.length, 'room')}.`);
            telemetry.rooms.forEach((room, index) => addFact(
                `schedule.count.${index + 1}`,
                `${room.roomName} has ${room.schedules.length} valid configured ${plural(room.schedules.length, 'schedule')}.`,
            ));
        } else if (plan.questionFocus === 'schedule_list') {
            const total = telemetry.rooms.reduce((sum, room) => sum + room.schedules.length, 0);
            addFact('schedule.total', `${total} valid configured ${plural(total, 'schedule')} ${total === 1 ? 'is' : 'are'} stored across ${telemetry.rooms.length} selected active ${plural(telemetry.rooms.length, 'room')}.`);
            telemetry.rooms.forEach((room, roomIndex) => {
                if (room.schedules.length === 0) addFact(`schedule.none.${roomIndex + 1}`, `${room.roomName} has no valid configured schedules.`);
                room.schedules.forEach((schedule, scheduleIndex) => addFact(
                    `schedule.item.${roomIndex + 1}.${scheduleIndex + 1}`,
                    `${room.roomName}: ${schedule.day}, ${schedule.startTime}–${schedule.endTime}, ${schedule.subject}.`,
                ));
                addFact(`schedule.count.${roomIndex + 1}`, `${room.roomName} has ${room.schedules.length} valid configured ${plural(room.schedules.length, 'schedule')}.`);
            });
        }
        return { answerability: 'answerable', freshness };
    }

    if (ENERGY_FOCUSES.has(plan.questionFocus)) {
        if (!energy) return unavailableSelection();
        if (energy.metrics.roomsWithRecords === 0 || energy.metrics.totalKwh === null) {
            const noDevice = energy.rooms.filter((room) => room.status === 'no_device');
            if (noDevice.length > 0 && noDevice.length === energy.rooms.length) {
                addFact('energy.no_devices', `${joinNames(noDevice.map((room) => room.roomName))} ${noDevice.length === 1 ? 'has' : 'have'} no assigned device, so no room energy source exists for the selected scope.`);
                return { answerability: 'insufficient_evidence', freshness: 'not_applicable' };
            }
            addFact('energy.no_records', `No recorded estimated energy is available for the selected active room scope from ${energy.range.start} through ${energy.range.end}; no zero total or ranking can be inferred.`);
            if (plan.questionFocus === 'facility_efficiency_analysis') {
                const ref = addFact('energy.collect', 'Facility-specific energy-waste analysis requires recorded energy evidence in the selected period.');
                recommendations.push({
                    category: 'collect_missing_energy_data',
                    text: 'Collect missing energy data before drawing a facility-specific waste conclusion.',
                    evidenceRefs: [ref],
                });
            }
            return { answerability: 'no_energy_records', freshness: 'not_applicable' };
        }
        const coverageRef = addFact(
            'energy.coverage',
            `From ${energy.range.start} through ${energy.range.end}, ${energy.metrics.roomsWithRecords} of ${energy.metrics.activeRooms} active ${plural(energy.metrics.activeRooms, 'room')} have recorded energy, and records exist on ${energy.metrics.recordedDays} of ${energy.metrics.expectedDays} calendar days (${energy.metrics.dataCoveragePercent}% temporal data coverage). Energy values are estimated and not billing-grade.`,
        );
        const recorded = energy.rooms.filter((room) => room.status === 'recorded' && room.estimatedKwh !== null);
        const leaders = recorded.filter((room) => room.rank === 1);
        if (plan.questionFocus === 'energy_total' || plan.questionFocus === 'energy_report') {
            const runtime = energy.metrics.runtimeSeconds === null
                ? 'a complete runtime total is unavailable'
                : `${energy.metrics.runtimeSeconds} runtime seconds`;
            const sessions = energy.metrics.sessionCount === null
                ? 'a complete session total is unavailable'
                : `${energy.metrics.sessionCount} recorded sessions`;
            addFact('energy.total', `The selected period's recorded total is an estimated ${energy.metrics.totalKwh} kWh from ${energy.range.start} through ${energy.range.end}; ${runtime}, and ${sessions}.`);
            if (plan.questionFocus === 'energy_report' && leaders.length > 0) {
                addFact('energy.leader', leaderStatement(leaders, energy));
            }
        } else if (plan.questionFocus === 'energy_rank_winner') {
            addFact('energy.winner', leaderStatement(leaders, energy));
        } else if (plan.questionFocus === 'energy_ranking') {
            recorded.sort((left, right) => (left.rank ?? 999) - (right.rank ?? 999)).forEach((room, index) => addFact(
                `energy.rank.${index + 1}`,
                `${room.roomName} ranks ${room.rank} with an estimated ${room.estimatedKwh} kWh (${room.sharePercent}% of the recorded total) from ${energy.range.start} through ${energy.range.end}.`,
            ));
        } else if (plan.questionFocus === 'energy_trend') {
            const points = energy.trend.filter((point) => point.estimatedKwh !== null);
            if (points.length === 0) {
                addFact('energy.no_trend', `No recorded trend point is available from ${energy.range.start} through ${energy.range.end}.`);
                return { answerability: 'no_energy_records', freshness: 'not_applicable' };
            }
            points.forEach((point, index) => addFact(
                `energy.trend.${index + 1}`,
                `${point.label} (${point.start} through ${point.end}) has an estimated ${point.estimatedKwh} kWh from records on ${point.recordedDays} of ${point.expectedDays} calendar days.`,
            ));
        } else if (plan.questionFocus === 'facility_efficiency_analysis') {
            if (leaders.length > 0 && energy.metrics.totalKwh !== null &&
                energy.metrics.totalKwh > 0) {
                const leaderRef = addFact('energy.analysis.leader', leaderStatement(leaders, energy));
                const leaderNames = joinNames(leaders.map((room) => room.roomName));
                recommendations.push({
                    category: 'inspect_high_runtime_room',
                    text: `Review ${leaderNames} first because ${leaders.length === 1 ? 'it has' : 'they tie for'} the highest estimated energy in the available records for the selected period; this prioritizes incomplete evidence and is not proof of waste.`,
                    evidenceRefs: [leaderRef],
                });
            }
            if (energy.metrics.dataCoveragePercent < 100) {
                recommendations.push({
                    category: 'collect_missing_energy_data',
                    text: 'Collect the missing period data before treating this as a complete facility-wide waste analysis.',
                    evidenceRefs: [coverageRef],
                });
            }
            if (input.telemetry) {
                const offline = input.telemetry.rooms.filter((room) =>
                    room.onlineState === 'stale' || room.onlineState === 'offline');
                if (offline.length > 0) {
                    const ref = addFact('telemetry.analysis.offline', `${offline.length} selected ${plural(offline.length, 'room')} ${offline.length === 1 ? 'does' : 'do'} not have an online device: ${joinNames(offline.map((room) => room.roomName))}. Current operating behavior cannot be confirmed for those rooms.`);
                    recommendations.push({
                        category: 'investigate_offline_device',
                        text: 'Investigate the offline devices before relying on current operating behavior in the energy review.',
                        evidenceRefs: [ref],
                    });
                }
            }
        }
        const partial = energy.metrics.coveragePercent < 100 ||
            energy.metrics.dataCoveragePercent < 100 || input.telemetry?.rooms.some((room) => room.onlineState !== 'online');
        return { answerability: partial ? 'partial' : 'answerable', freshness: 'not_applicable' };
    }

    if (plan.questionFocus === 'climate_suggestion') {
        if (!climate) return unavailableSelection();
        const available = climate.rooms.filter((room) => room.status === 'available');
        if (available.length === 0) {
            addFact('climate.none', 'No valid stored climate suggestion is available for the selected active room scope.');
            return { answerability: 'insufficient_evidence', freshness: 'not_applicable' };
        }
        available.forEach((room, index) => addFact(
            `climate.${index + 1}`,
            `${room.roomName} has a stored suggestion of ${room.suggestedTemp} °C${room.reason ? ` with stored reason: ${room.reason}` : ''}; applied state is ${room.applied === null ? 'unknown' : room.applied ? 'yes' : 'no'} and AI auto-apply configuration is ${room.autoApplyEnabled === null ? 'unknown' : room.autoApplyEnabled ? 'enabled' : 'disabled'}.`,
        ));
        return { answerability: available.length < climate.rooms.length ? 'partial' : 'answerable', freshness: 'not_applicable' };
    }

    if (plan.questionFocus === 'recent_events') {
        if (!events) return unavailableSelection();
        if (events.events.length === 0) {
            addFact('events.none', 'No valid recent operational events matched the selected active room scope.');
            return { answerability: 'insufficient_evidence', freshness: 'not_applicable' };
        }
        events.events.forEach((event, index) => addFact(
            `events.${index + 1}`,
            `${event.roomName}: ${event.eventType} at ${event.updatedAt}${event.mode ? `, mode ${event.mode}` : ''}${event.applied === null ? '' : `, applied ${event.applied ? 'yes' : 'no'}`}; ${event.detail}.`,
        ));
        return { answerability: 'answerable', freshness: 'not_applicable' };
    }

    if (plan.questionFocus === 'system_help') {
        if (!help) return unavailableSelection();
        if (help.restricted) addFact('help.restricted', `${help.title} requires administrator access in OcuTemp.`);
        else if (help.steps.length === 0) addFact('help.none', 'No exact verified OcuTemp help entry matched this request.');
        else {
            addFact('help.summary', `${help.title} has ${help.steps.length} verified OcuTemp steps.`);
            help.steps.forEach((step, index) => addFact(`help.step.${index + 1}`, `${index + 1}. ${step}`));
        }
        return { answerability: help.steps.length > 0 ? 'answerable' : 'insufficient_evidence', freshness: 'not_applicable' };
    }
    return unavailableSelection();
}

function deriveDisplayPlan(
    plan: PlannerResult,
    outcome: ChatAnswerabilityOutcome,
    presentations: readonly ChatPresentation[],
): ChatDisplayDirective[] {
    if (plan.outputPreference === 'text' || TERMINAL_OUTCOMES.has(outcome)) return [];
    const telemetry = findPresentation(presentations, 'room-telemetry');
    const energy = findPresentation(presentations, 'energy-report');
    const climate = findPresentation(presentations, 'climate-suggestions');
    const events = findPresentation(presentations, 'recent-events');
    let directive: ChatDisplayDirective | null = null;
    switch (plan.questionFocus) {
        case 'current_temperature':
        case 'current_humidity':
        case 'current_condition': {
            const currentCount = telemetry?.rooms.filter((room) =>
                room.measurementStatus === 'current' &&
                (plan.questionFocus === 'current_temperature' ? room.temperature !== null
                    : plan.questionFocus === 'current_humidity' ? room.humidity !== null
                        : room.condition !== 'unknown')).length ?? 0;
            if (currentCount >= 2 && (plan.allRooms || plan.outputPreference === 'table')) {
                directive = telemetry ? { presentationId: telemetry.id, mode: 'table' } : null;
            }
            break;
        }
        case 'last_known_temperature': {
            const readable = telemetry?.rooms.filter((room) =>
                room.temperature !== null && room.lastSeen !== null).length ?? 0;
            if (telemetry && readable >= 2 &&
                (plan.allRooms || plan.outputPreference === 'table')) directive = {
                presentationId: telemetry.id,
                mode: 'table',
            };
            break;
        }
        case 'device_status':
            if (telemetry && telemetry.rooms.length >= 2 &&
                (plan.allRooms || plan.outputPreference === 'table')) directive = {
                presentationId: telemetry.id,
                mode: 'table',
            };
            break;
        case 'ac_power_status': {
            const readable = telemetry?.rooms.filter((room) =>
                room.measurementStatus === 'current' && room.acPower !== null).length ?? 0;
            if (telemetry && readable >= 2 &&
                (plan.allRooms || plan.outputPreference === 'table')) directive = {
                presentationId: telemetry.id,
                mode: 'table',
            };
            break;
        }
        case 'ai_auto_apply_status': {
            const values = new Set(telemetry?.rooms.map((room) => room.aiAutoApply) ?? []);
            if (telemetry && telemetry.rooms.length > 1 &&
                (plan.outputPreference === 'table' || values.size > 1)) {
                directive = { presentationId: telemetry.id, mode: 'table' };
            }
            break;
        }
        case 'schedule_list':
            if (telemetry && telemetry.rooms.length > 1 &&
                telemetry.rooms.some((room) => room.schedules.length > 0)) directive = {
                presentationId: telemetry.id,
                mode: 'table',
            };
            break;
        case 'energy_total':
            if (energy && plan.outputPreference !== 'auto') directive = {
                presentationId: energy.id,
                mode: plan.outputPreference === 'table' ? 'table'
                    : 'trend_chart',
            };
            break;
        case 'energy_rank_winner':
            if (energy && plan.outputPreference !== 'auto') directive = {
                presentationId: energy.id,
                mode: plan.outputPreference === 'graph' ? 'ranking_chart' : 'table',
            };
            break;
        case 'energy_ranking':
            if (energy) {
                const recordedRooms = energy.rooms.filter((room) =>
                    room.status === 'recorded' && room.estimatedKwh !== null).length;
                directive = {
                    presentationId: energy.id,
                    mode: plan.outputPreference === 'graph' ||
                        plan.outputPreference === 'auto' && recordedRooms <= 10
                        ? 'ranking_chart'
                        : 'table',
                };
            }
            break;
        case 'energy_trend':
            if (energy) directive = {
                presentationId: energy.id,
                mode: plan.outputPreference === 'table' ? 'table' : 'trend_chart',
            };
            break;
        case 'energy_report':
            if (energy) directive = {
                presentationId: energy.id,
                mode: plan.outputPreference === 'table' ? 'table'
                    : plan.outputPreference === 'graph' ? 'trend_chart' : 'full_report',
            };
            break;
        case 'facility_efficiency_analysis':
            if (energy && plan.outputPreference !== 'auto') directive = {
                presentationId: energy.id,
                mode: plan.outputPreference === 'graph' ? 'ranking_chart' : 'table',
            };
            break;
        case 'climate_suggestion':
            if (climate && (climate.rooms.length > 1 || plan.outputPreference === 'table')) {
                directive = { presentationId: climate.id, mode: 'table' };
            }
            break;
        case 'recent_events':
            if (events && events.events.length > 1) directive = { presentationId: events.id, mode: 'table' };
            break;
        case 'system_help':
            break;
        default:
            break;
    }
    if (directive) {
        const selectedDirective = directive;
        const presentation = presentations.find((item) => item.id === selectedDirective.presentationId);
        if (!presentation || presentation.availability !== 'available' ||
            !displayCompatible(selectedDirective.mode, presentation)) directive = null;
    }
    const candidate = directive ? [directive] : [];
    validateDisplayPlan(candidate, presentations);
    return candidate;
}

function validateDisplayPlan(
    directives: readonly ChatDisplayDirective[],
    presentations: readonly ChatPresentation[],
): void {
    if (!Array.isArray(directives) || directives.length > 1) throw invalidDisplayPlan();
    const ids = new Set<string>();
    for (const directive of directives) {
        const directiveKeys = Object.keys(directive);
        if (directiveKeys.length !== 2 ||
            !directiveKeys.every((key) => key === 'presentationId' || key === 'mode') ||
            typeof directive.presentationId !== 'string' || ids.has(directive.presentationId)) {
            throw invalidDisplayPlan();
        }
        ids.add(directive.presentationId);
        const presentation = presentations.find((item) => item.id === directive.presentationId);
        if (!presentation || presentation.availability !== 'available' ||
            !displayCompatible(directive.mode, presentation)) throw invalidDisplayPlan();
    }
}

function displayCompatible(mode: ChatDisplayMode, presentation: ChatPresentation): boolean {
    if (mode === 'compact_metrics') return presentation.kind === 'energy-report' &&
        presentation.metrics.roomsWithRecords > 0;
    if (mode === 'key_value') return presentation.kind === 'room-telemetry' && presentation.rooms.length > 0;
    if (mode === 'bullet_list') return (presentation.kind === 'room-telemetry' &&
        presentation.rooms.some((room) => room.schedules.length > 0)) ||
        (presentation.kind === 'system-help' && presentation.steps.length > 0);
    if (mode === 'table') {
        if (presentation.kind === 'energy-report') return presentation.rooms.length > 0;
        if (presentation.kind === 'room-telemetry') return presentation.rooms.length > 0;
        if (presentation.kind === 'climate-suggestions') return presentation.rooms.length > 0;
        if (presentation.kind === 'recent-events') return presentation.events.length > 0;
        return false;
    }
    if (mode === 'ranking_chart') return presentation.kind === 'energy-report' &&
        presentation.rooms.filter((room) => room.status === 'recorded').length >= 2;
    if (mode === 'trend_chart') return presentation.kind === 'energy-report' &&
        presentation.trend.some((point) => point.estimatedKwh !== null);
    return mode === 'full_report' && presentation.kind === 'energy-report' &&
        presentation.metrics.roomsWithRecords > 0;
}

function validateGroundedAnswerDraft(
    draft: GroundedAnswerDraft,
    packet: AnswerPacket,
    presentations: readonly ChatPresentation[],
): GroundedAnswerDraft {
    if (!hasExactKeys(draft, [
        'headline', 'headlineEvidenceRefs', 'summary', 'summaryEvidenceRefs',
        'highlights', 'recommendations',
    ]) || !isSafeText(draft.headline, 160, false) || !isSafeText(draft.summary, 800, false) ||
        !Array.isArray(draft.highlights) || draft.highlights.length > 6 ||
        !Array.isArray(draft.recommendations) || draft.recommendations.length > 5) {
        throw invalidGeneratedAnswer();
    }
    const factMap = new Map(packet.facts.map((fact) => [fact.id, fact.statement]));
    validateGroundedText(draft.headline, draft.headlineEvidenceRefs, factMap, packet);
    validateGroundedText(draft.summary, draft.summaryEvidenceRefs, factMap, packet);
    for (const highlight of draft.highlights) {
        if (!hasExactKeys(highlight, ['text', 'evidenceRefs']) ||
            !isSafeText(highlight.text, 300, false)) throw invalidGeneratedAnswer();
        validateGroundedText(highlight.text, highlight.evidenceRefs, factMap, packet);
    }
    const allowedRecommendations = new Map(packet.recommendations.map((item) => [
        `${item.category}\u0000${item.text}\u0000${item.evidenceRefs.join(',')}`,
        item,
    ]));
    for (const recommendation of draft.recommendations) {
        if (!hasExactKeys(recommendation, ['category', 'text', 'evidenceRefs']) ||
            !RECOMMENDATION_CATEGORIES.includes(recommendation.category) ||
            !isSafeText(recommendation.text, 300, false) ||
            !Array.isArray(recommendation.evidenceRefs)) throw invalidGeneratedAnswer();
        const key = `${recommendation.category}\u0000${recommendation.text}\u0000${recommendation.evidenceRefs.join(',')}`;
        if (!allowedRecommendations.has(key)) throw invalidGeneratedAnswer();
    }
    const normalized: GroundedAnswerDraft = {
        headline: cleanText(draft.headline, 160),
        headlineEvidenceRefs: unique(draft.headlineEvidenceRefs),
        summary: cleanText(draft.summary, 800),
        summaryEvidenceRefs: unique(draft.summaryEvidenceRefs),
        highlights: draft.highlights.map((item) => ({
            text: cleanText(item.text, 300),
            evidenceRefs: unique(item.evidenceRefs),
        })),
        recommendations: draft.recommendations.map((item) => ({
            category: item.category,
            text: cleanText(item.text, 300),
            evidenceRefs: unique(item.evidenceRefs),
        })),
    };
    validateFocusSpecificAnswer(normalized, packet, presentations);
    return normalized;
}

function validateGroundedText(
    text: string,
    refs: readonly string[],
    factMap: ReadonlyMap<string, string>,
    packet: AnswerPacket,
): void {
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 12 ||
        new Set(refs).size !== refs.length || refs.some((ref) =>
            typeof ref !== 'string' || ref.length > 80 || !factMap.has(ref))) {
        throw invalidGeneratedAnswer();
    }
    const supportedStatements = refs.map((ref) => factMap.get(ref)!);
    const evidence = supportedStatements.join(' ');
    if (/<[^>]+>|```|https?:\/\/|(?:firebase|database)\s*(?:path|url)|system prompt|api[_ -]?key|bearer\s+[a-z0-9]/iu.test(text) ||
        /\b(?:i|we|ocuguide)\s+(?:turned|switched|set|changed|applied|updated|deleted|controlled|fixed|wrote)\b/iu.test(text) ||
        /\b(?:caused|causes|because of|due to|resulted in|led to|as a result of)\b/iu.test(text)) {
        throw invalidGeneratedAnswer();
    }
    const evidenceNumbers = new Set(extractNumbers(evidence));
    if (extractNumbers(text).some((number) => !evidenceNumbers.has(number))) throw invalidGeneratedAnswer();
    validateNumericAssociations(text, evidence);
    const normalizedEvidence = normalizeForComparison(evidence);
    for (const status of ['online', 'offline', 'stale', 'hot', 'critical', 'comfortable', 'enabled', 'disabled', 'unknown', 'on', 'off']) {
        if (hasWord(text, status) && !hasWord(normalizedEvidence, status)) throw invalidGeneratedAnswer();
    }
    const claimedRooms = extractMentionedRoomKeys(text, packet.scope.activeRoomNames);
    const supportedRooms = extractMentionedRoomKeys(evidence, packet.scope.activeRoomNames);
    for (const roomKey of claimedRooms) {
        if (!supportedRooms.has(roomKey)) throw invalidGeneratedAnswer();
    }
    const hasSpecificRowClaim = extractNumbers(text).length > 0 || claimedRooms.size > 0 ||
        /\b(?:online|offline|stale|hot|critical|comfortable|enabled|disabled|unknown|on|off)\b/iu.test(text);
    if (EXACT_ROW_CLAIM_FOCUSES.has(packet.questionFocus) && hasSpecificRowClaim &&
        !supportedStatements.some((statement) => sameNormalizedClaim(text, statement))) {
        throw invalidGeneratedAnswer();
    }
    const evidenceTokens = new Set(extractClaimTokens(evidence));
    for (const token of extractClaimTokens(text)) {
        if (!evidenceTokens.has(token) && !GROUNDING_GLUE_TOKENS.has(token)) {
            throw invalidGeneratedAnswer();
        }
    }
    if (/\b(?:wast(?:e|es|ed|ing)|inefficien\w*|uncomfortable|excessive|faulty|broken|poor|unsafe|maintenance|servic(?:e|ing)|repair|filter|insulation|refrigerant)\b/iu.test(text) &&
        !/\b(?:wast(?:e|es|ed|ing)|inefficien\w*|uncomfortable|excessive|faulty|broken|poor|unsafe|maintenance|servic(?:e|ing)|repair|filter|insulation|refrigerant)\b/iu.test(evidence)) {
        throw invalidGeneratedAnswer();
    }
    if (packet.displayPlan.length === 0 && /\b(?:table|chart|graph|visual)\b/iu.test(text)) {
        throw invalidGeneratedAnswer();
    }
}

function validateFocusSpecificAnswer(
    draft: GroundedAnswerDraft,
    packet: AnswerPacket,
    presentations: readonly ChatPresentation[],
): void {
    const text = normalizeForComparison([
        draft.headline, draft.summary, ...draft.highlights.map((item) => item.text),
        ...draft.recommendations.map((item) => item.text),
    ].join(' '));
    if (packet.answerability === 'room_not_found' && !/\b(?:not configured|not found|does not exist)\b/u.test(text)) {
        throw invalidGeneratedAnswer();
    }
    if (packet.answerability === 'no_online_reading' &&
        !/\b(?:no current|cannot report|not online|no room is online|none).*(?:current|online)|(?:current).*(?:unavailable|cannot)/u.test(text)) {
        throw invalidGeneratedAnswer();
    }
    if (packet.questionFocus === 'energy_rank_winner') {
        const energy = findPresentation(presentations, 'energy-report');
        const leaders = energy?.rooms.filter((room) => room.rank === 1 && room.estimatedKwh !== null) ?? [];
        if (leaders.length === 0 || !energy ||
            !containsPhrase(text, leaderStatement(leaders, energy)) ||
            leaders.some((leader) => !containsPhrase(text, leader.roomName)) ||
            leaders.some((leader) => !containsPhrase(text, String(leader.estimatedKwh))) ||
            !containsPhrase(text, energy.range.start) ||
            !containsPhrase(text, energy.range.end) ||
            !/\bestimated\b/u.test(text) || !/\bkwh\b/u.test(text) ||
            !/\b(?:first|rank|tie)\b/u.test(text) ||
            (leaders.length > 1 && !/\btie\b/u.test(text))) throw invalidGeneratedAnswer();
    }
    if (packet.questionFocus === 'energy_total' || packet.questionFocus === 'energy_report') {
        const total = packet.facts.find((fact) => fact.id === 'energy.total');
        if (total && !containsPhrase(text, total.statement)) throw invalidGeneratedAnswer();
    }
    if (packet.questionFocus === 'energy_total') {
        const energy = findPresentation(presentations, 'energy-report');
        if (!energy || energy.metrics.totalKwh === null ||
            !extractNumbers(text).includes(String(energy.metrics.totalKwh)) ||
            !containsPhrase(text, energy.range.start) || !containsPhrase(text, energy.range.end) ||
            !/\bestimated\b/u.test(text) || !/\bkwh\b/u.test(text)) {
            throw invalidGeneratedAnswer();
        }
    }
    if (packet.questionFocus === 'ai_auto_apply_status' && !/\b(?:configured|configuration|stored)\b/u.test(text)) {
        throw invalidGeneratedAnswer();
    }
    if (packet.questionFocus === 'facility_efficiency_analysis') {
        const allowed = new Set(packet.recommendations.map((item) => item.text));
        if (draft.recommendations.some((item) => !allowed.has(item.text))) throw invalidGeneratedAnswer();
        if (packet.recommendations.length > 0 && draft.recommendations.length === 0) {
            throw invalidGeneratedAnswer();
        }
        if (/\b(?:filter|insulation|seal leaks|service|maintenance|setpoint|refrigerant)\b/u.test(text)) {
            throw invalidGeneratedAnswer();
        }
    }
}

function buildGroundedPublicAnswer(
    draft: GroundedAnswerDraft,
    packet: AnswerPacket,
    presentations: readonly ChatPresentation[],
): ChatAnswer {
    const highlights = unique(draft.highlights.map((item) => cleanText(item.text, 300)))
        .filter(Boolean).slice(0, 6).map((text) => ({ text }));
    const recommendationItems = draft.recommendations.map((item) => cleanText(item.text, 240));
    const blocks: ChatAnswerBlock[] = [];
    if (recommendationItems.length > 0) blocks.push({
        kind: recommendationItems.length === 1 ? 'callout' : 'bullet-list',
        text: recommendationItems.length === 1 ? recommendationItems[0]! : 'Evidence-based next steps',
        items: recommendationItems.length === 1 ? [] : recommendationItems,
        entries: [],
        tone: 'info',
    });
    else if (highlights.length >= 2) blocks.push({
        kind: 'bullet-list', text: 'Key details',
        items: highlights.map((item) => item.text).slice(0, 8), entries: [], tone: 'neutral',
    });
    return {
        headline: cleanText(draft.headline, 160),
        summary: cleanText(draft.summary, 800),
        blocks,
        highlights,
        caveats: buildCaveats(packet, presentations),
    };
}

function buildTargetedAnswer(packet: AnswerPacket, presentations: readonly ChatPresentation[]): ChatAnswer {
    const telemetry = findPresentation(presentations, 'room-telemetry');
    const energy = findPresentation(presentations, 'energy-report');
    const climate = findPresentation(presentations, 'climate-suggestions');
    const events = findPresentation(presentations, 'recent-events');
    const help = findPresentation(presentations, 'system-help');
    if (packet.answerability === 'room_not_found') return simpleAnswer('Room not found', notFoundStatement(packet.scope));
    if (packet.answerability === 'room_inactive') return simpleAnswer('Room inactive', inactiveStatement(packet.scope));
    if (packet.answerability === 'room_ambiguous') return simpleAnswer('Room name is ambiguous', ambiguousStatement(packet.scope));
    if (packet.answerability === 'source_unavailable') return simpleAnswer(
        'Data temporarily unavailable',
        'I cannot safely read the requested OcuTemp data right now, so I cannot answer this question yet.',
        buildCaveats(packet, presentations),
    );
    if (packet.answerability === 'no_online_reading') return simpleAnswer(
        'No current reading available',
        `I cannot report a current ${focusMeasurementLabel(packet.questionFocus)} because no selected room has an online device with that current measurement.`,
        buildCaveats(packet, presentations),
    );
    if (packet.answerability === 'no_energy_records') return simpleAnswer(
        'No recorded energy for this period',
        energy ? `No recorded estimated energy is available from ${energy.range.start} through ${energy.range.end}, so I cannot calculate a total, ranking, trend, or facility-specific waste conclusion.` : 'No recorded estimated energy is available for the selected period.',
        buildCaveats(packet, presentations),
    );
    if (packet.answerability === 'insufficient_evidence') {
        const noDevices = packet.facts.find((fact) => fact.id === 'energy.no_devices');
        if (noDevices) return simpleAnswer('No assigned energy source', noDevices.statement, buildCaveats(packet, presentations));
        if (packet.questionFocus === 'recent_events') return simpleAnswer('No matching recent events', 'No valid recent operational events matched the selected room scope.', buildCaveats(packet, presentations));
        if (packet.questionFocus === 'climate_suggestion') return simpleAnswer('No stored suggestion available', 'No valid stored climate suggestion is available for the selected room scope.', buildCaveats(packet, presentations));
        return simpleAnswer('Not enough verified data', 'OcuTemp does not have enough verified data to answer this question safely.', buildCaveats(packet, presentations));
    }

    switch (packet.questionFocus) {
        case 'room_existence':
            return simpleAnswer('Room is configured', packet.facts.find((fact) =>
                fact.id === 'scope.exists')?.statement ?? 'The requested room is configured and active in OcuTemp.');
        case 'current_temperature':
        case 'current_humidity':
        case 'current_condition':
        case 'ac_power_status':
        case 'last_known_temperature':
            return currentTelemetryAnswer(telemetry, packet, presentations);
        case 'device_status':
            return factsAnswer('Device status', packet.facts.filter((fact) => fact.id.startsWith('telemetry.status.')), packet, presentations);
        case 'ai_auto_apply_status':
            return aiToggleAnswer(telemetry, packet, presentations);
        case 'schedule_count': {
            const countFacts = packet.facts.filter((fact) => fact.id.startsWith('schedule.count.'));
            const summary = countFacts.length === 1 ? countFacts[0]!.statement
                : packet.facts.find((fact) => fact.id === 'schedule.total')?.statement ?? 'No schedule count is available.';
            return simpleAnswer('Configured schedules', summary);
        }
        case 'schedule_list': {
            const allItems = telemetry?.rooms.flatMap((room) => room.schedules.map((schedule) =>
                `${room.roomName}: ${schedule.day}, ${schedule.startTime}–${schedule.endTime}, ${schedule.subject}.`)) ?? [];
            const items = allItems.slice(0, 40);
            const baseSummary = packet.facts.find((fact) => fact.id === 'schedule.total')?.statement ?? 'Configured schedules';
            const summary = allItems.length > items.length
                ? `${baseSummary} The text response shows the first ${items.length} because answer output is bounded.`
                : baseSummary;
            const blocks = packet.displayPlan.length > 0 ? [] : chunkStrings(items, 8).slice(0, 5).map(
                (chunk): ChatAnswerBlock => ({
                    kind: chunk.length === 1 ? 'paragraph' : 'bullet-list',
                    text: chunk.length === 1 ? chunk[0]! : '',
                    items: chunk.length === 1 ? [] : chunk,
                    entries: [],
                    tone: 'neutral',
                }),
            );
            return {
                headline: 'Configured schedules', summary,
                blocks,
                highlights: [], caveats: [],
            };
        }
        case 'energy_total':
            return simpleAnswer('Estimated energy total', packet.facts.find((fact) => fact.id === 'energy.total')?.statement ?? 'No total is available.', buildCaveats(packet, presentations));
        case 'energy_rank_winner':
            return simpleAnswer(energy?.rooms.filter((room) => room.rank === 1).length === 1 ? 'First-ranked room' : 'First-place tie', packet.facts.find((fact) => fact.id === 'energy.winner')?.statement ?? 'No winner can be determined.', buildCaveats(packet, presentations));
        case 'energy_ranking':
            return factsAnswer('Estimated energy ranking', packet.facts.filter((fact) => fact.id.startsWith('energy.rank.')), packet, presentations);
        case 'energy_trend':
            return factsAnswer('Estimated energy trend', packet.facts.filter((fact) => fact.id.startsWith('energy.trend.')), packet, presentations);
        case 'energy_report': {
            const total = packet.facts.find((fact) => fact.id === 'energy.total')?.statement ?? 'The report is available.';
            return simpleAnswer('Estimated energy report', total, buildCaveats(packet, presentations));
        }
        case 'facility_efficiency_analysis': {
            const items = packet.recommendations.map((item) => item.text);
            return {
                headline: 'Facility-specific energy review',
                summary: items.length > 0 ? 'The verified OcuTemp data supports these bounded next steps; it does not prove that any configuration caused energy waste.' : 'The available OcuTemp evidence does not support a specific energy-waste recommendation.',
                blocks: items.length === 1 ? [{ kind: 'callout', text: items[0]!, items: [], entries: [], tone: 'info' }]
                    : items.length > 1 ? [{ kind: 'bullet-list', text: 'Evidence-based next steps', items, entries: [], tone: 'neutral' }] : [],
                highlights: [], caveats: buildCaveats(packet, presentations),
            };
        }
        case 'climate_suggestion':
            return factsAnswer('Stored climate suggestions', packet.facts.filter((fact) => fact.id.startsWith('climate.')), packet, presentations);
        case 'recent_events':
            return factsAnswer('Recent operational events', packet.facts.filter((fact) => fact.id.startsWith('events.')), packet, presentations);
        case 'system_help':
            return helpAnswer(help);
        default:
            return simpleAnswer('OcuGuide', packet.facts[0]?.statement ?? 'No verified answer is available.');
    }
}

function factsAnswer(
    headline: string,
    facts: readonly GroundingFact[],
    packet: AnswerPacket,
    presentations: readonly ChatPresentation[],
): ChatAnswer {
    if (facts.length === 0) return simpleAnswer(headline, 'No verified answer is available.', buildCaveats(packet, presentations));
    const summary = facts.length === 1 ? facts[0]!.statement : `${facts.length} verified results are available for the requested scope.`;
    const items = facts.map((fact) => fact.statement);
    return {
        headline, summary,
        blocks: items.length >= 2 ? [{ kind: 'bullet-list', text: '', items: items.slice(0, 8), entries: [], tone: 'neutral' }] : [],
        highlights: items.slice(0, 6).map((text) => ({ text })),
        caveats: buildCaveats(packet, presentations),
    };
}

function helpAnswer(help: SystemHelpPresentation | undefined): ChatAnswer {
    if (!help || help.availability === 'unavailable') return simpleAnswer('Help unavailable', 'Verified OcuTemp help is temporarily unavailable.');
    if (help.restricted) return simpleAnswer(help.title, 'This OcuTemp help topic requires administrator access.');
    if (help.steps.length === 0) return simpleAnswer('Help topic not found', 'No exact verified OcuTemp help topic matched this request.');
    return {
        headline: help.title,
        summary: 'Follow these verified OcuTemp steps:',
        blocks: [{ kind: 'numbered-list', text: '', items: help.steps.slice(0, 8), entries: [], tone: 'neutral' }],
        highlights: [], caveats: [],
    };
}

function currentTelemetryAnswer(
    telemetry: RoomTelemetryPresentation | undefined,
    packet: AnswerPacket,
    presentations: readonly ChatPresentation[],
): ChatAnswer {
    const rows = telemetry?.rooms.filter((room) =>
        packet.questionFocus === 'last_known_temperature'
            ? room.temperature !== null && room.lastSeen !== null
            : room.measurementStatus === 'current' &&
                (packet.questionFocus === 'current_temperature' ? room.temperature !== null
                    : packet.questionFocus === 'current_humidity' ? room.humidity !== null
                        : packet.questionFocus === 'current_condition' ? room.condition !== 'unknown'
                            : room.acPower !== null)) ?? [];
    if (rows.length === 0) return simpleAnswer(
        focusHeadline(packet.questionFocus),
        `No verified ${focusMeasurementLabel(packet.questionFocus)} is available for the selected room scope.`,
    );
    const describe = (room: RoomTelemetryPresentation['rooms'][number]): string => {
        if (packet.questionFocus === 'last_known_temperature') {
            return room.measurementStatus === 'current'
                ? `${room.roomName}'s latest temperature is ${room.temperature} °C from ${room.lastSeen}; this is a current reading.`
                : `${room.roomName}'s last-known temperature is ${room.temperature} °C from ${room.lastSeen}; this is not a current reading.`;
        }
        if (packet.questionFocus === 'current_temperature') return `${room.roomName}'s current temperature is ${room.temperature} °C.`;
        if (packet.questionFocus === 'current_humidity') return `${room.roomName}'s current humidity is ${room.humidity}%.`;
        if (packet.questionFocus === 'ac_power_status') return `${room.roomName}'s current AC power status is ${room.acPower ? 'on' : 'off'}.`;
        const observation = `${room.roomName}'s current condition is ${room.condition}${room.temperature === null ? '' : ` at ${room.temperature} °C`}${room.humidity === null ? '' : ` and ${room.humidity}% humidity`}.`;
        if (packet.facts.some((fact) => fact.id === 'telemetry.not_hot')) {
            return `${observation} It is not currently classified as hot or critical by OcuTemp.`;
        }
        if (packet.facts.some((fact) => fact.id === 'telemetry.cause_unknown')) {
            return `${observation} OcuTemp's available evidence does not establish why.`;
        }
        return observation;
    };
    const items = rows.map(describe);
    return {
        headline: focusHeadline(packet.questionFocus),
        summary: items.length === 1 ? items[0]! : `${items.length} verified ${focusMeasurementLabel(packet.questionFocus)} results are available for the requested scope.`,
        blocks: items.length >= 2 ? [{
            kind: 'bullet-list', text: '', items: items.slice(0, 8), entries: [], tone: 'neutral',
        }] : [],
        highlights: items.slice(0, 6).map((text) => ({ text })),
        caveats: buildCaveats(packet, presentations),
    };
}

function aiToggleAnswer(
    telemetry: RoomTelemetryPresentation | undefined,
    packet: AnswerPacket,
    presentations: readonly ChatPresentation[],
): ChatAnswer {
    const rows = telemetry?.rooms ?? [];
    if (rows.length === 0) {
        return simpleAnswer('AI auto-apply configuration', 'No verified AI auto-apply configuration is available for the selected room scope.');
    }
    const setting = (value: boolean | null): string => value === null
        ? 'unknown'
        : value ? 'enabled' : 'disabled';
    const offline = rows.filter((row) => row.deviceAssignmentStatus === 'assigned' &&
        (row.onlineState === 'stale' || row.onlineState === 'offline'));
    const notAssigned = rows.filter((row) => row.deviceAssignmentStatus === 'not_assigned');
    const unavailable = rows.filter((row) => row.deviceAssignmentStatus === 'unavailable');
    if (rows.length === 1) {
        const row = rows[0]!;
        if (row.deviceAssignmentStatus === 'not_assigned') return simpleAnswer(
            'AI auto-apply configuration',
            `${row.roomName} has no assigned device, so no device AI auto-apply configuration is available.`,
            buildCaveats(packet, presentations),
        );
        if (row.deviceAssignmentStatus === 'unavailable') return simpleAnswer(
            'AI auto-apply configuration',
            `${row.roomName} has an assigned device, but its AI auto-apply configuration is unavailable.`,
            buildCaveats(packet, presentations),
        );
        const qualifier = row.onlineState === 'online'
            ? ''
            : ` Its device is ${row.onlineState}, so current device application cannot be confirmed.`;
        return simpleAnswer(
            'AI auto-apply configuration',
            `${row.roomName}'s stored OcuTemp AI auto-apply configuration is ${setting(row.aiAutoApply)}.${qualifier}`,
            buildCaveats(packet, presentations),
        );
    }
    const enabled = rows.filter((row) => row.aiAutoApply === true);
    const disabled = rows.filter((row) => row.aiAutoApply === false);
    const unknown = rows.filter((row) => row.aiAutoApply === null);
    let summary: string;
    const sharedState = enabled.length === rows.length || disabled.length === rows.length ||
        unknown.length === rows.length;
    if (sharedState) {
        const state = enabled.length === rows.length
            ? 'enabled'
            : disabled.length === rows.length ? 'disabled' : 'unknown';
        summary = state === 'unknown'
            ? `AI auto-apply configuration is unknown for all ${rows.length} selected rooms.`
            : `AI auto-apply is configured as ${state} in all ${rows.length} selected rooms.`;
    } else {
        const parts = [
            `${enabled.length} enabled`,
            `${disabled.length} disabled`,
            ...(unknown.length > 0 ? [`${unknown.length} unknown`] : []),
        ];
        summary = `Stored AI auto-apply configuration is mixed across ${rows.length} selected rooms: ${parts.join(', ')}.`;
    }
    if (offline.length > 0) {
        summary += ` ${offline.length} selected ${plural(offline.length, 'room')} ${offline.length === 1 ? 'does' : 'do'} not have an online device, so current device application cannot be confirmed there.`;
    }
    if (notAssigned.length > 0) {
        summary += ` ${notAssigned.length} selected ${plural(notAssigned.length, 'room')} ${notAssigned.length === 1 ? 'has' : 'have'} no assigned device.`;
    }
    if (unavailable.length > 0) {
        summary += ` Assigned-device configuration data is unavailable for ${unavailable.length} selected ${plural(unavailable.length, 'room')}.`;
    }
    return {
        headline: 'AI auto-apply configuration',
        summary,
        blocks: sharedState || packet.displayPlan.length > 0 ? [] : [{
            kind: 'key-value',
            text: 'Stored configuration',
            items: [],
            entries: rows.slice(0, 8).map((row) => ({
                label: row.roomName,
                value: row.deviceAssignmentStatus === 'not_assigned'
                    ? 'No assigned device'
                    : row.deviceAssignmentStatus === 'unavailable'
                        ? 'Assigned-device data unavailable'
                        : `${setting(row.aiAutoApply)}; device ${row.onlineState}`,
            })),
            tone: 'neutral',
        }],
        highlights: [],
        caveats: buildCaveats(packet, presentations),
    };
}

function simpleAnswer(headline: string, summary: string, caveats: string[] = []): ChatAnswer {
    return {
        headline: cleanText(headline, 160),
        summary: cleanText(summary, 800),
        blocks: [], highlights: [], caveats: unique(caveats).slice(0, 3),
    };
}

function ensureRenderableAnswer(answer: ChatAnswer): ChatAnswer {
    if (answer.blocks.length > 0) return answer;
    return {
        ...answer,
        blocks: [{
            kind: 'paragraph',
            text: answer.summary,
            items: [],
            entries: [],
            tone: 'neutral',
        }],
    };
}

function buildCaveats(packet: AnswerPacket, presentations: readonly ChatPresentation[]): string[] {
    const caveats: string[] = packet.facts
        .filter((fact) => fact.id.startsWith('scope.partial_') ||
            fact.id === 'telemetry.current.partial')
        .map((fact) => fact.statement);
    const energy = findPresentation(presentations, 'energy-report');
    const hasRecordedEnergy = energy?.availability === 'available' &&
        energy.metrics.roomsWithRecords > 0 && energy.metrics.totalKwh !== null;
    if (hasRecordedEnergy) caveats.push('Energy values are estimates and are not billing-grade measurements.');
    const hasTemporalCoverageNotice = hasRecordedEnergy && packet.notices.some((notice) =>
        notice.includes(`${energy.metrics.recordedDays} of ${energy.metrics.expectedDays} calendar days`) &&
        /temporal coverage/iu.test(notice));
    if (hasRecordedEnergy && energy.metrics.dataCoveragePercent < 100 && !hasTemporalCoverageNotice) caveats.push(
        `Temporal coverage is partial: records exist on ${energy.metrics.recordedDays} of ${energy.metrics.expectedDays} calendar days.`,
    );
    if (packet.answerability === 'partial') caveats.push('Some requested OcuTemp evidence is incomplete or unavailable.');
    return unique(caveats.map((item) => cleanText(item, 240))).slice(0, 3);
}

function buildStateContext(plan: PlannerResult, packet: AnswerPacket): ChatStateContext {
    const energyTool = plan.tools.find((tool) => tool.name === 'get_energy_report');
    const resolvedRange = packet.range;
    return {
        questionFocus: plan.questionFocus,
        metric: plan.metric,
        roomNames: plan.allRooms
            ? []
            : packet.scope.matchedRoomNames.length > 0
                ? packet.scope.matchedRoomNames.slice(0, 50)
                : plan.requestedRoomNames.slice(0, 50),
        allRooms: plan.allRooms,
        rangePreset: resolvedRange ? 'custom' : energyTool?.rangePreset ?? 'this_month',
        startDate: resolvedRange?.start ?? energyTool?.startDate ?? '',
        endDate: resolvedRange?.end ?? energyTool?.endDate ?? '',
        bucket: resolvedRange?.bucket ?? energyTool?.bucket ?? 'auto',
        toolNames: plan.tools.map((tool) => tool.name),
        answerability: packet.answerability,
        hadVisual: packet.displayPlan.length > 0,
    };
}

function serializeProviderPacket(packet: AnswerPacket): string {
    const safe = {
        questionFocus: packet.questionFocus,
        answerability: packet.answerability,
        freshness: packet.freshness,
        scope: {
            requestedNames: packet.scope.requestedNames.map(redactUntrustedText),
            matchedRoomNames: packet.scope.matchedRoomNames.map(redactUntrustedText),
        },
        range: packet.range,
        facts: packet.facts.map((fact) => ({
            id: fact.id,
            statement: redactUntrustedText(fact.statement),
        })),
        recommendations: packet.recommendations.map((item) => ({
            ...item,
            text: redactUntrustedText(item.text),
        })),
        displayPlan: packet.displayPlan,
        notices: packet.notices.map(redactUntrustedText),
    };
    return JSON.stringify(safe);
}

function scopeAnswerability(scope: RoomScopeResolution, plan: PlannerResult): ChatAnswerabilityOutcome {
    if (scope.ambiguousRoomNames.length > 0 && scope.matchedRoomNames.length === 0) {
        return 'room_ambiguous';
    }
    if (plan.requestedRoomNames.length > 0 && scope.matchedRoomNames.length === 0) {
        if (scope.inactiveRoomNames.length > 0 && scope.missingRoomNames.length === 0) return 'room_inactive';
        return 'room_not_found';
    }
    return 'answerable';
}

function mergeScopes(scopes: readonly RoomScopeResolution[], requested: readonly string[]): RoomScopeResolution {
    if (scopes.length === 0) return emptyScope(requested);
    return {
        requestedNames: unique(scopes.flatMap((scope) => scope.requestedNames)),
        matchedRoomNames: unique(scopes.flatMap((scope) => scope.matchedRoomNames)),
        inactiveRoomNames: unique(scopes.flatMap((scope) => scope.inactiveRoomNames)),
        missingRoomNames: unique(scopes.flatMap((scope) => scope.missingRoomNames)),
        ambiguousRoomNames: unique(scopes.flatMap((scope) => scope.ambiguousRoomNames)),
        activeRoomNames: unique(scopes.flatMap((scope) => scope.activeRoomNames)),
    };
}

function emptyScope(requested: readonly string[]): RoomScopeResolution {
    return {
        requestedNames: [...requested], matchedRoomNames: [], inactiveRoomNames: [],
        missingRoomNames: [], ambiguousRoomNames: [], activeRoomNames: [],
    };
}

function notFoundStatement(scope: RoomScopeResolution): string {
    const names = scope.missingRoomNames.length > 0 ? scope.missingRoomNames : scope.requestedNames;
    const subject = names.length === 1 ? names[0]! : joinNames(names);
    const base = names.length === 1
        ? `${subject} is not configured in OcuTemp.`
        : `${subject} are not configured in OcuTemp.`;
    const inactive = scope.inactiveRoomNames.length === 0 ? ''
        : scope.inactiveRoomNames.length === 1
            ? ` ${scope.inactiveRoomNames[0]} exists in OcuTemp but is inactive.`
            : ` ${joinNames(scope.inactiveRoomNames)} exist in OcuTemp but are inactive.`;
    const active = scope.activeRoomNames.length > 0
        ? ` The active rooms are ${joinNames(scope.activeRoomNames)}.`
        : '';
    return `${base}${inactive}${active}`;
}

function inactiveStatement(scope: RoomScopeResolution): string {
    return scope.inactiveRoomNames.length === 1
        ? `${scope.inactiveRoomNames[0]} exists in OcuTemp but is inactive.`
        : `${joinNames(scope.inactiveRoomNames)} exist in OcuTemp but are inactive.`;
}

function ambiguousStatement(scope: RoomScopeResolution): string {
    return `The name ${joinNames(scope.ambiguousRoomNames)} matches more than one configured room, so OcuGuide did not choose one.`;
}

function leaderStatement(leaders: EnergyReportPresentation['rooms'], energy: EnergyReportPresentation): string {
    if (leaders.length === 1) {
        const leader = leaders[0]!;
        return `${leader.roomName} ranks first from ${energy.range.start} through ${energy.range.end} with an estimated ${leader.estimatedKwh} kWh (${leader.sharePercent}% of the recorded total).`;
    }
    return `${joinNames(leaders.map((room) => room.roomName))} tie for first from ${energy.range.start} through ${energy.range.end} at an estimated ${leaders[0]?.estimatedKwh} kWh each.`;
}

function telemetryFreshness(telemetry: RoomTelemetryPresentation): ChatFreshnessOutcome {
    const statuses = new Set(telemetry.rooms.map((room) => room.measurementStatus));
    if (statuses.size > 1) return 'mixed';
    const status = telemetry.rooms[0]?.measurementStatus;
    if (status === 'current') return 'current';
    if (status === 'stale') return 'stale';
    if (status === 'offline') return 'offline';
    return 'unavailable';
}

function requiredResultsUnavailable(
    focus: ChatQuestionFocus,
    results: readonly ToolExecutionResult[],
): boolean {
    const requiredTool: ChatToolName | null = TELEMETRY_FOCUSES.has(focus)
        ? 'get_room_telemetry'
        : ENERGY_FOCUSES.has(focus)
            ? 'get_energy_report'
            : focus === 'climate_suggestion'
                ? 'get_climate_prediction_logs'
                : focus === 'recent_events'
                    ? 'get_recent_room_events'
                    : focus === 'system_help'
                        ? 'get_system_help'
                        : null;
    if (requiredTool === null) return false;
    const result = results.find((candidate) => candidate.name === requiredTool);
    return !result || result.outcome === 'source_unavailable' ||
        result.presentation.availability === 'unavailable';
}

function unavailableSelection(): { answerability: 'source_unavailable'; freshness: 'unavailable' } {
    return { answerability: 'source_unavailable', freshness: 'unavailable' };
}

function focusMeasurementLabel(focus: ChatQuestionFocus): string {
    switch (focus) {
        case 'current_temperature': case 'last_known_temperature': return 'temperature';
        case 'current_humidity': return 'humidity';
        case 'current_condition': return 'room condition';
        case 'ac_power_status': return 'AC power status';
        default: return 'reading';
    }
}

function focusHeadline(focus: ChatQuestionFocus): string {
    switch (focus) {
        case 'current_temperature': return 'Current temperature';
        case 'last_known_temperature': return 'Last-known temperature';
        case 'current_humidity': return 'Current humidity';
        case 'current_condition': return 'Current room condition';
        case 'ac_power_status': return 'Current AC power status';
        default: return 'OcuGuide result';
    }
}

function findPresentation<K extends ChatPresentation['kind']>(
    presentations: readonly ChatPresentation[],
    kind: K,
): Extract<ChatPresentation, { kind: K }> | undefined {
    return presentations.find((presentation): presentation is Extract<ChatPresentation, { kind: K }> =>
        presentation.kind === kind);
}

function extractNumbers(text: string): string[] {
    return text.match(/-?\d+(?:\.\d+)?/gu) ?? [];
}

function validateNumericAssociations(text: string, evidence: string): void {
    const normalizedText = normalizeForComparison(text);
    const normalizedEvidence = normalizeForComparison(evidence);
    const exactPatterns = [
        /\b-?\d+(?:\.\d+)?\s*kwh\b/gu,
        /\b-?\d+(?:\.\d+)?%\b/gu,
        /\b-?\d+(?:\.\d+)?\s*°\s*c\b/gu,
        /\b\d+\s+of\s+\d+\b/gu,
        /\b\d+\s+runtime\s+seconds\b/gu,
    ];
    for (const pattern of exactPatterns) {
        for (const association of normalizedText.match(pattern) ?? []) {
            if (!normalizedEvidence.includes(association)) throw invalidGeneratedAnswer();
        }
    }
    for (const match of normalizedText.matchAll(/\b(\d+)\s+(?:recorded\s+)?sessions\b/gu)) {
        const value = match[1];
        if (!value || !new RegExp(`\\b${value}\\s+(?:recorded\\s+)?sessions\\b`, 'u')
            .test(normalizedEvidence)) throw invalidGeneratedAnswer();
    }
}

function extractClaimTokens(text: string): string[] {
    return unique(normalizeForComparison(text).match(/[\p{L}][\p{L}\p{N}_-]*/gu) ?? []);
}

function hasWord(text: string, word: string): boolean {
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_-])${word}(?:$|[^\\p{L}\\p{N}_-])`, 'iu').test(text);
}

function containsPhrase(text: string, phrase: string): boolean {
    return normalizeForComparison(text).includes(normalizeForComparison(phrase));
}

function extractMentionedRoomKeys(text: string, roomNames: readonly string[]): Set<string> {
    const normalizedText = normalizeForComparison(text);
    const occupied: Array<{ readonly start: number; readonly end: number }> = [];
    const found = new Set<string>();
    const candidates = [...roomNames]
        .map((roomName) => normalizeForComparison(roomName))
        .filter(Boolean)
        .sort((left, right) => right.length - left.length || left.localeCompare(right));

    for (const roomName of candidates) {
        const escaped = roomName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const pattern = new RegExp(
            `(?:^|[^\\p{L}\\p{N}_-])(${escaped})(?=$|[^\\p{L}\\p{N}_-])`,
            'gu',
        );
        for (const match of normalizedText.matchAll(pattern)) {
            const value = match[1];
            if (!value || match.index === undefined) continue;
            const start = match.index + match[0].indexOf(value);
            const end = start + value.length;
            if (occupied.some((span) => start < span.end && end > span.start)) continue;
            occupied.push({ start, end });
            found.add(roomName);
        }
    }
    return found;
}

function normalizeForComparison(text: string): string {
    return text.normalize('NFKC').toLocaleLowerCase('en-US');
}

function sameNormalizedClaim(left: string, right: string): boolean {
    const normalize = (value: string): string => normalizeForComparison(value)
        .replace(/\s+/gu, ' ')
        .replace(/[.!?]+$/gu, '')
        .trim();
    return normalize(left) === normalize(right);
}

function normalizeUniqueNames(values: readonly unknown[]): string[] {
    const names: string[] = [];
    const keys = new Set<string>();
    for (const value of values) {
        if (!isSafeText(value, 100, false)) throw invalidProviderPlan();
        const name = normalizeText(value);
        const key = name.toLocaleLowerCase('en-US');
        if (keys.has(key)) throw invalidProviderPlan();
        keys.add(key);
        names.push(name);
    }
    return names;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const keys = new Set(left.map((name) => normalizeForComparison(name)));
    return right.every((name) => keys.has(normalizeForComparison(name)));
}

function joinNames(names: readonly string[]): string {
    if (names.length === 0) return 'no rooms';
    if (names.length === 1) return names[0]!;
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

function plural(count: number, singular: string): string {
    return count === 1 ? singular : `${singular}s`;
}

function chunkStrings(values: readonly string[], size: number): string[][] {
    const chunks: string[][] = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
}

function cleanText(value: string, maximum: number): string {
    const normalized = value.normalize('NFKC')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/gu, '')
        .replace(/\s+/gu, ' ').trim();
    return Array.from(normalized).slice(0, maximum).join('');
}

function redactUntrustedText(value: string): string {
    return value.normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ')
        .replace(/https:\/\/[^\s/]+\.(?:firebaseio\.com|firebasedatabase\.app)(?:\/[^\s]*)?/giu, '[redacted Firebase reference]')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[redacted token]')
        .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/giu, 'Bearer [redacted]')
        .replace(/\b(?:api[_ -]?key|access[_ -]?token|id[_ -]?token|state[_ -]?token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
        .replace(/\b(?:gsk_|sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}\b/gu, '[redacted credential]')
        .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, '[redacted credential]')
        .replace(/\b(?:users|devices|rooms|decisionLogs|energy|logs)\/[A-Za-z0-9_.~%/-]+/giu, '[redacted internal reference]')
        .replace(/\b(?=[A-Za-z0-9_+/-]{32,}={0,2}(?=$|[\s,;:.!?"'<>]))(?=[A-Za-z0-9_+/-]*[A-Za-z])(?=[A-Za-z0-9_+/-]*\d)[A-Za-z0-9_+/-]{32,}={0,2}/gu, '[redacted opaque value]')
        .replace(/\s+/gu, ' ').trim();
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isSafeText(value: unknown, maximum: number, allowEmpty: boolean): value is string {
    return typeof value === 'string' && Array.from(value).length <= maximum &&
        !/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u.test(value) &&
        (allowEmpty || Boolean(value.trim()));
}

function normalizeText(value: string): string {
    return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function isIsoCalendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hasExplicitEnergyPeriod(value: string): boolean {
    return /\b(?:today|yesterday|annual|yearly|q[1-4]|quarter|whole[- ]year|january|february|march|april|may|june|july|august|september|october|november|december|\d{4})\b|\b(?:this|last|previous|past)\s+(?:day|week|month|year|7\s+days|12\s+months)\b|\d{4}-\d{2}-\d{2}/iu.test(value);
}

function hasExplicitRoomScope(value: string): boolean {
    return /\b(?:all|every|each)\s+(?:active\s+)?rooms?\b|\b(?:which|what)\s+(?:active\s+)?rooms\b|\bfacility(?:-wide)?\b|\broom\s+(?!(?:rank(?:ed|s|ing)?|is|was|has|had|uses?|consumes?|with|that|which|who|status|temperature|humidity|energy)\b)[\p{L}\p{N}][\p{L}\p{N}_-]*/iu.test(value);
}

function invalidProviderPlan(): ChatApiError {
    return new ChatApiError('assistant_unavailable', 'The semantic plan was invalid.', 502);
}

function invalidGeneratedAnswer(): ChatApiError {
    return new ChatApiError('assistant_unavailable', 'The generated answer was not grounded.', 502);
}

function invalidDisplayPlan(): ChatApiError {
    return new ChatApiError('assistant_unavailable', 'The display plan was invalid.', 502);
}

function unique<T>(values: readonly T[]): T[] {
    return [...new Set(values)];
}
