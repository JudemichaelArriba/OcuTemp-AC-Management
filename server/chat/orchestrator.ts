import type { FirebaseRestClient } from './firebase-rest.js';
import {
    CapabilityValidationError,
    capabilitiesForRole,
    compileSystemQueryPlan,
    plannerCapabilitySlice,
    validateSystemQueryPlan,
} from './capabilities.js';
import { ANSWERER_SYSTEM_PROMPT } from './prompts/answerer.prompt.js';
import { PLANNER_SYSTEM_PROMPT } from './prompts/planner.prompt.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { GroqProvider } from './providers/groq.provider.js';
import { ProviderResponseError } from './providers/provider.interface.js';
import { BothProvidersFailedError, generateWithFallback } from './retry.js';
import { ANSWER_OUTPUT_SCHEMA, PLANNER_OUTPUT_SCHEMA } from './tools/schema.js';
import { executeToolPlans } from './tools/executor.js';
import type {
    AnswerPacket,
    ChatAnswerBlock,
    ChatAnswerPart,
    ChatAnswerabilityOutcome,
    ChatDisplayDirective,
    ChatDisplayMode,
    ChatFollowUp,
    ChatPartId,
    ChatPresentation,
    ChatPrincipal,
    ChatQuestionFocus,
    ChatResponseContext,
    ChatStateContext,
    ChatStatePayload,
    ChatStateReferent,
    ChatStateTurn,
    ChatToolName,
    ClimateSuggestionsPresentation,
    EnergyRange,
    EnergyReportPresentation,
    EvidenceBackedRecommendation,
    GroundedAnswerDraft,
    GroundingFact,
    MetricSummaryPresentation,
    PlannerToolPlan,
    ProjectedValue,
    RecentEventsPresentation,
    RoomDataPresentation,
    RoomScopeResolution,
    ScheduleDataPresentation,
    SystemDomain,
    SystemField,
    SystemFilter,
    SystemOperation,
    SystemQueryPart,
    SystemQueryPlan,
    SystemTimeRange,
    ToolExecutionResult,
    ToolOutcome,
} from './types/chat.types.js';

const PLANNER_PRIMARY_MS = 5_000;
const PLANNER_FALLBACK_MS = 3_000;
const PLANNING_RESERVE_MS = 6_000;
const WRITER_MIN_REMAINING_MS = 4_500;
const WRITER_PRIMARY_MS = 3_000;
const WRITER_FALLBACK_MS = 2_000;
const FINALIZATION_RESERVE_MS = 1_000;
const MAX_PROVIDER_FACTS = 80;
const MAX_PROVIDER_PACKET_BYTES = 48 * 1024;
const MAX_PUBLIC_NOTICES = 12;
const textEncoder = new TextEncoder();

export interface RunChatTurnInput {
    readonly requestId: string;
    readonly message: string;
    readonly user: ChatPrincipal;
    readonly state: ChatStatePayload | null;
    readonly firebase: FirebaseRestClient;
    readonly abortSignal?: AbortSignal;
    readonly deadlineAtMs?: number;
}

export interface ChatTurnCoreResult {
    readonly responseContexts: ChatResponseContext[];
    readonly answerParts: ChatAnswerPart[];
    readonly presentations: ChatPresentation[];
    readonly displayPlan: ChatDisplayDirective[];
    readonly followUps: ChatFollowUp[];
    readonly partial: boolean;
    readonly notices: string[];
    readonly evidenceSource: 'facility' | 'application' | 'none';
    readonly stateTurn: ChatStateTurn;
}

interface ReferenceResolution {
    readonly parts: SystemQueryPart[];
    readonly unresolved: ReadonlyMap<ChatPartId, string>;
}

interface PartWork {
    readonly requested: SystemQueryPart;
    readonly executable: SystemQueryPart;
    readonly results: ToolExecutionResult[];
    readonly answerability: ChatAnswerabilityOutcome;
    readonly packet: AnswerPacket;
}

const geminiProvider = new GeminiProvider();
const groqProvider = new GroqProvider();

export async function runChatTurn(input: RunChatTurnInput): Promise<ChatTurnCoreResult> {
    assertNotAborted(input.abortSignal);
    const startedAt = Date.now();
    const deadlineAtMs = input.deadlineAtMs ?? startedAt + 20_000;
    let requestedPlan: SystemQueryPlan;
    const explicitQuestionCount = countExplicitQuestions(input.message);
    const deterministic = explicitQuestionCount <= 1 && !hasMultipleSystemTopics(input.message)
        ? deterministicPlan(input.message, input.state)
        : null;

    if (deterministic) {
        try {
            requestedPlan = validateSystemQueryPlan(deterministic);
            compileSystemQueryPlan(requestedPlan, input.user);
        } catch (error: unknown) {
            if (!(error instanceof CapabilityValidationError)) throw error;
            requestedPlan = clarificationPlan(
                'That OcuTemp request is too broad or ambiguous to process safely. Please narrow the room scope or rephrase the question.',
            );
        }
    } else if (explicitQuestionCount > 3) {
        requestedPlan = clarificationPlan(
            'Please split that into no more than three related OcuTemp questions.',
        );
    } else {
        requestedPlan = await planWithProviders(input, deadlineAtMs, startedAt);
    }

    const visualConflict = conflictingExplicitVisuals(requestedPlan.parts);
    if (visualConflict) {
        requestedPlan = clarificationPlan(
            'That request asks for different visuals. Which single table or graph should I show?',
        );
    }

    const historical = resolveHistoricalReferences(requestedPlan, input.state);
    const initialCompilation = compileSystemQueryPlan(
        requestedPlan,
        input.user,
        historical.parts,
    );
    const dependentIds = new Set(historical.parts
        .filter(isPriorPartDependency)
        .map((part) => part.partId));
    const firstWavePlans = initialCompilation.tools.filter(
        (tool) => !dependentIds.has(tool.partId),
    );

    const results: ToolExecutionResult[] = [];
    if (firstWavePlans.length > 0) {
        const wave = await executeToolPlans(firstWavePlans, {
            firebase: input.firebase,
            user: input.user,
            questionFocus: legacyFocusFor(requestedPlan.parts[0]!),
            now: new Date(),
            abortSignal: input.abortSignal,
        });
        results.push(...wave);
    }

    const sameTurn = resolvePriorPartReferences(
        historical.parts,
        historical.unresolved,
        results,
    );
    const finalCompilation = compileSystemQueryPlan(
        requestedPlan,
        input.user,
        sameTurn.parts,
    );
    const secondWavePlans = finalCompilation.tools.filter(
        (tool) => dependentIds.has(tool.partId) && !sameTurn.unresolved.has(tool.partId),
    );
    if (secondWavePlans.length > 0) {
        const wave = await executeToolPlans(secondWavePlans, {
            firebase: input.firebase,
            user: input.user,
            questionFocus: legacyFocusFor(requestedPlan.parts[0]!),
            now: new Date(),
            abortSignal: input.abortSignal,
        });
        results.push(...wave);
    }

    const deniedIds = new Set(finalCompilation.deniedParts.map((item) => item.partId));
    const displayPlan = selectDisplayPlan(sameTurn.parts, results);
    const partWorks = buildPartWork(
        requestedPlan.parts,
        sameTurn.parts,
        results,
        sameTurn.unresolved,
        deniedIds,
        displayPlan,
    );
    const answerParts: ChatAnswerPart[] = [];
    let remainingFactBudget = MAX_PROVIDER_FACTS;

    for (const work of partWorks) {
        const deterministicAnswer = buildDeterministicAnswer(work, input.user);
        let answer = deterministicAnswer;
        const boundedPacket = boundPacket(work.packet, remainingFactBudget);
        remainingFactBudget -= boundedPacket.facts.length;
        if (shouldUseWriter(work) && boundedPacket.facts.length > 0 &&
            deadlineAtMs - Date.now() >= WRITER_MIN_REMAINING_MS) {
            answer = await writeWithFallback(
                input.requestId,
                work,
                boundedPacket,
                deterministicAnswer,
                deadlineAtMs,
                input.abortSignal,
            );
        }
        answerParts.push(answer);
    }

    const responseContexts = partWorks.map((work): ChatResponseContext => ({
        partId: work.requested.partId,
        domain: work.requested.domain,
        operation: work.requested.operation,
        fields: [...work.requested.fields],
        scope: work.executable.scope.kind,
        answerability: work.answerability,
    }));
    const presentations = results.map((result) => result.presentation);
    const notices = uniqueStrings(results.flatMap((result) => result.notices))
        .slice(0, MAX_PUBLIC_NOTICES);
    const partial = results.some((result) => result.partial) ||
        partWorks.some((work) => work.answerability === 'partial');
    const stateTurn = buildStateTurn(partWorks, finalCompilation.tools, displayPlan);

    logSafe(input.requestId, 'orchestration', {
        domain: requestedPlan.parts.map((part) => part.domain).join(','),
        operation: requestedPlan.parts.map((part) => part.operation).join(','),
        toolCount: new Set(finalCompilation.tools.map((tool) => tool.name)).size,
        durationBucket: durationBucket(Date.now() - startedAt),
        fallbackOutcome: deterministic ? 'deterministic_plan' : 'semantic_plan',
    });

    return {
        responseContexts,
        answerParts,
        presentations,
        displayPlan,
        followUps: buildFollowUps(partWorks),
        partial,
        notices,
        evidenceSource: results.length > 0 ? 'facility'
            : requestedPlan.parts.some((part) =>
                ['own_account', 'assistant_capabilities', 'app_help'].includes(part.domain))
                ? 'application'
                : 'none',
        stateTurn,
    };
}

async function planWithProviders(
    input: RunChatTurnInput,
    deadlineAtMs: number,
    startedAt: number,
): Promise<SystemQueryPlan> {
    const prompt = JSON.stringify({
        currentManilaDate: manilaDateKey(new Date()),
        callerRole: input.user.role,
        permittedSemanticCapabilities: plannerCapabilitySlice(input.user.role),
        typedConversationContext: safeStateForPlanner(input.state),
        untrustedUserMessage: input.message,
    });
    try {
        const generated = await generateWithFallback<SystemQueryPlan>(
            geminiProvider,
            groqProvider,
            {
                systemPrompt: PLANNER_SYSTEM_PROMPT,
                prompt,
                schema: PLANNER_OUTPUT_SCHEMA,
                schemaName: 'system_query_plan',
                schemaDescription: 'A bounded semantic OcuTemp query plan.',
                maxOutputTokens: 2_400,
                temperature: 0,
                timeoutMs: PLANNER_PRIMARY_MS,
                reasoningEffort: 'low',
                abortSignal: input.abortSignal,
            },
            (rawPlan) => {
                const plan = validateSystemQueryPlan(rawPlan);
                compileSystemQueryPlan(plan, input.user);
                return plan;
            },
            {
                fallbackTimeoutMs: PLANNER_FALLBACK_MS,
                deadlineAtMs,
                reserveMs: PLANNING_RESERVE_MS,
            },
        );
        logSafe(input.requestId, 'planning', {
            provider: generated.providerUsed,
            durationBucket: durationBucket(Date.now() - startedAt),
            fallbackOutcome: generated.usedFallback ? 'fallback_succeeded' : 'primary_succeeded',
        });
        return generated.result;
    } catch (error: unknown) {
        if (input.abortSignal?.aborted) throw error;
        if (isSemanticPlanningFailure(error)) {
            logSafe(input.requestId, 'planning', {
                provider: 'none',
                durationBucket: durationBucket(Date.now() - startedAt),
                fallbackOutcome: 'invalid_plan_clarified',
            });
            return clarificationPlan(
                'I could not safely interpret that OcuTemp request. Please name the system data you want and, if relevant, the room or period.',
            );
        }
        throw error;
    }
}

async function writeWithFallback(
    requestId: string,
    work: PartWork,
    packet: AnswerPacket,
    deterministicAnswer: ChatAnswerPart,
    deadlineAtMs: number,
    abortSignal?: AbortSignal,
): Promise<ChatAnswerPart> {
    const startedAt = Date.now();
    const allowFallback = deadlineAtMs - Date.now() >=
        WRITER_PRIMARY_MS + WRITER_FALLBACK_MS + FINALIZATION_RESERVE_MS;
    try {
        const generated = await generateWithFallback<GroundedAnswerDraft>(
            groqProvider,
            geminiProvider,
            {
                systemPrompt: ANSWERER_SYSTEM_PROMPT,
                prompt: JSON.stringify({ answerPacket: packet }),
                schema: ANSWER_OUTPUT_SCHEMA,
                schemaName: 'grounded_answer',
                schemaDescription: 'A concise answer supported by supplied fact IDs.',
                maxOutputTokens: 1_200,
                temperature: 0.15,
                timeoutMs: WRITER_PRIMARY_MS,
                reasoningEffort: 'low',
                abortSignal,
            },
            (draft) => validateWriterDraft(draft, packet),
            {
                fallbackTimeoutMs: WRITER_FALLBACK_MS,
                deadlineAtMs,
                reserveMs: FINALIZATION_RESERVE_MS,
                allowFallback,
            },
        );
        logSafe(requestId, 'writing', {
            provider: generated.providerUsed,
            domain: work.requested.domain,
            operation: work.requested.operation,
            durationBucket: durationBucket(Date.now() - startedAt),
            fallbackOutcome: generated.usedFallback ? 'fallback_succeeded' : 'primary_succeeded',
        });
        return answerPartFromDraft(work, generated.result);
    } catch (error: unknown) {
        if (abortSignal?.aborted) throw error;
        logSafe(requestId, 'writing', {
            provider: 'none',
            domain: work.requested.domain,
            operation: work.requested.operation,
            durationBucket: durationBucket(Date.now() - startedAt),
            fallbackOutcome: 'deterministic_fallback',
        });
        return deterministicAnswer;
    }
}

function resolveHistoricalReferences(
    plan: SystemQueryPlan,
    state: ChatStatePayload | null,
): ReferenceResolution {
    const unresolved = new Map<ChatPartId, string>();
    const latest = state?.turns[state.turns.length - 1];
    const parts = plan.parts.map((part): SystemQueryPart => {
        if (part.scope.kind === 'prior_part' ||
            part.followUpReference.kind === 'prior_part') return part;
        const referenceKind = part.scope.kind === 'previous_request' ||
            part.scope.kind === 'previous_result'
            ? part.scope.kind
            : part.followUpReference.kind === 'previous_request' ||
                part.followUpReference.kind === 'previous_result'
                ? part.followUpReference.kind
                : null;
        if (!referenceKind) return part;
        if (!latest) {
            return unresolvedPart(part, unresolved,
                'I do not have a verified previous result for that reference. Please name the rooms or scope.');
        }

        if (referenceKind === 'previous_request') {
            const candidates = latest.contexts.filter((context) =>
                context.domain === part.domain || latest.contexts.length === 1);
            const context = candidates[candidates.length - 1];
            if (!context || !['facility', 'named_rooms'].includes(context.requestedScope.kind)) {
                return unresolvedPart(part, unresolved,
                    'The previous request does not provide one unambiguous room scope. Please name the rooms.');
            }
            return {
                ...part,
                scope: { ...context.requestedScope },
                timeRange: part.domain === 'energy' ? { ...context.timeRange } : part.timeRange,
            };
        }

        const candidates = latest.referents.filter((referent) =>
            latest.contexts.find((context) => context.partId === referent.sourcePartId)?.domain ===
                part.domain || latest.referents.length === 1);
        const referent = candidates[candidates.length - 1];
        if (!referent || referent.roomNames.length === 0 ||
            (!referent.complete && part.followUpReference.ordinal === 0)) {
            return unresolvedPart(part, unresolved,
                'The previous result does not contain one complete, unambiguous room set. Please name the rooms.');
        }
        const ordinal = part.followUpReference.ordinal;
        const roomNames = ordinal > 0
            ? referent.roomNames[ordinal - 1]
                ? [referent.roomNames[ordinal - 1]!]
                : []
            : referent.roomNames;
        if (roomNames.length === 0) {
            return unresolvedPart(part, unresolved,
                'That numbered room is not present in the previous verified result.');
        }
        return {
            ...part,
            scope: {
                kind: 'named_rooms', roomNames: [...roomNames],
                inventory: part.scope.inventory, referencePartId: '',
            },
        };
    });
    return { parts, unresolved };
}

function resolvePriorPartReferences(
    parts: readonly SystemQueryPart[],
    existingUnresolved: ReadonlyMap<ChatPartId, string>,
    results: readonly ToolExecutionResult[],
): ReferenceResolution {
    const unresolved = new Map(existingUnresolved);
    const resolved = parts.map((part): SystemQueryPart => {
        if (!isPriorPartDependency(part)) return part;
        const referencePartId = part.scope.referencePartId || part.followUpReference.partId;
        const referenced = results.filter((result) => result.partId === referencePartId);
        if (referenced.length === 0) {
            return unresolvedPart(part, unresolved,
                'The earlier part did not produce a verified room result for this follow-up.');
        }
        const names = uniqueStrings(referenced.flatMap((result) =>
            result.scope.matchedRoomNames));
        const incomplete = referenced.some((result) => result.partial);
        if (names.length === 0) {
            return unresolvedPart(part, unresolved,
                'There are no rooms in the earlier verified result to use for this part.');
        }
        if (names.length > 50 || incomplete) {
            return unresolvedPart(part, unresolved,
                'The earlier result is incomplete or too large to use safely as “those rooms.” Please name the rooms.');
        }
        const ordinal = part.followUpReference.ordinal;
        const selected = ordinal > 0 ? names[ordinal - 1] ? [names[ordinal - 1]!] : [] : names;
        if (selected.length === 0) {
            return unresolvedPart(part, unresolved,
                'That numbered room is not present in the earlier verified result.');
        }
        return {
            ...part,
            scope: {
                kind: 'named_rooms', roomNames: selected,
                inventory: part.scope.inventory, referencePartId: '',
            },
        };
    });
    return { parts: resolved, unresolved };
}

function unresolvedPart(
    part: SystemQueryPart,
    unresolved: Map<ChatPartId, string>,
    message: string,
): SystemQueryPart {
    unresolved.set(part.partId, message);
    return {
        ...part,
        scope: { kind: 'facility', roomNames: [], inventory: part.scope.inventory,
            referencePartId: '' },
        needsClarification: true,
        clarification: message,
    };
}

function deterministicPlan(message: string, state: ChatStatePayload | null): SystemQueryPlan | null {
    const normalized = cleanText(message, 2_000).toLocaleLowerCase('en-US');
    const roomNames = explicitRoomNames(message);
    const namedScope = roomNames.length > 0
        ? scope('named_rooms', roomNames, 'all')
        : scope('facility', [], 'active');

    if (/^(hi|hello|hey|good (morning|afternoon|evening))[!. ]*$/u.test(normalized)) {
        return onePart(part({ domain: 'conversation', operation: 'greet',
            fields: ['capabilities'] }));
    }
    if (/\b(what (can|do) you do|what (is|are) your (job|role|capabilit)|how can you help)\b/u
        .test(normalized)) {
        return onePart(part({ domain: 'assistant_capabilities', operation: 'list',
            fields: ['capabilities'] }));
    }
    const helpTopic = deterministicHelpTopic(normalized);
    if (helpTopic) {
        return onePart(part({ domain: 'app_help', operation: 'how_to', fields: ['help_topic'],
            filters: [stringFilter('help_topic', helpTopic)] }));
    }
    if (/^(please\s+)?(turn|set|change|delete|create|remove|approve|apply|disable|enable)\b/u
        .test(normalized)) {
        return onePart(part({ domain: 'conversation', operation: 'deny',
            fields: ['capabilities'] }));
    }
    if (/\b(my (name|email|role)|who am i|is my account approved|my account status)\b/u
        .test(normalized)) {
        const fields: SystemField[] = [];
        if (/name|who am i/u.test(normalized)) fields.push('account_name');
        if (/email/u.test(normalized)) fields.push('account_email');
        if (/role|who am i/u.test(normalized)) fields.push('account_role');
        if (/approved|status/u.test(normalized)) fields.push('account_approval');
        return onePart(part({ domain: 'own_account', operation: 'detail', fields,
            scope: scope('own_account', [], 'all') }));
    }
    if (/\b(how many|total|count).*(users?|accounts?|admins?|staff)\b/u.test(normalized)) {
        const fields: SystemField[] = [];
        if (/users?|accounts?/u.test(normalized)) fields.push('user_total');
        if (/admins?/u.test(normalized)) fields.push('admin_count');
        if (/pending/u.test(normalized)) fields.push('pending_staff_count');
        if (/approved/u.test(normalized)) fields.push('approved_staff_count');
        if (fields.length === 0) fields.push('user_total');
        return onePart(part({ domain: 'admin_user_aggregates', operation: 'count', fields }));
    }
    if (/\b(how many|total|count).*(rooms?)\b/u.test(normalized)) {
        return onePart(part({ domain: 'rooms', operation: 'count',
            fields: ['room_count'], scope: scope('facility', [], 'all') }));
    }
    if (/\b(how many|total|count).*(devices?)\b/u.test(normalized)) {
        return onePart(part({ domain: 'devices', operation: 'count',
            fields: ['device_count'], scope: scope('facility', [], 'all') }));
    }
    if (/\b(schedule|timetable)\b/u.test(normalized)) {
        const isCount = /\b(how many|count|total)\b/u.test(normalized);
        const those = /\b(those rooms|them)\b/u.test(normalized);
        return onePart(part({
            domain: 'schedules', operation: isCount ? 'count' : 'list',
            fields: isCount ? ['schedule_count'] : ['room_name', 'schedules'],
            scope: those ? scope('previous_result', [], 'all') :
                roomNames.length > 0 ? namedScope : scope('facility', [], 'all'),
            followUpReference: those ? follow('previous_result') : undefined,
            limit: 50,
        }));
    }
    if (/\b(occupancy|occupied|occupants?)\b/u.test(normalized)) {
        const lastKnown = /\b(last[- ]?known|historical|previous)\b/u.test(normalized);
        return onePart(part({ domain: 'occupancy', operation: roomNames.length > 1 ? 'compare' : 'status',
            fields: ['room_name', lastKnown ? 'last_known_occupancy' : 'occupancy', 'device_status'],
            scope: namedScope }));
    }
    if (/\b(active override|overrides?)\b/u.test(normalized)) {
        const activeOnly = /\b(active|currently)\b/u.test(normalized);
        return onePart(part({ domain: 'overrides', operation: /which|what room|list/u.test(normalized)
            ? 'list' : 'status', fields: ['room_name', 'override_active',
                'override_target_temperature', 'override_until'],
            filters: activeOnly ? [booleanFilter('override_active', true)] : [],
            scope: roomNames.length > 0 ? namedScope : scope('facility', [], 'all') }));
    }
    if (/\b(ai auto[- ]?apply|auto[- ]?apply|ai toggle)\b/u.test(normalized)) {
        const enabledOnly = /\b(which|what room|enabled rooms?)\b/u.test(normalized);
        return onePart(part({ domain: 'ai_auto_apply', operation: enabledOnly ? 'list' : 'status',
            fields: ['room_name', 'ai_auto_apply'],
            filters: enabledOnly ? [booleanFilter('ai_auto_apply', true)] : [],
            scope: roomNames.length > 0 ? namedScope : scope('facility', [], 'all') }));
    }
    if (/\b(floor[ -]?plan|map layout|assigned cells?)\b/u.test(normalized)) {
        const layout = /map layout|shapes?|dynamic/u.test(normalized);
        return onePart(part({ domain: 'floor_plan', operation: /how many|count/u.test(normalized)
            ? 'count' : 'list', fields: ['room_name', layout ? 'floor_plan_layout' :
                'floor_plan_assignment'], scope: scope('facility', [], 'all') }));
    }
    if (/\b(climate suggestion|ml suggestion|temperature suggestion)\b/u.test(normalized)) {
        return onePart(part({ domain: 'climate_suggestions', operation: 'list',
            fields: ['room_name', 'climate_suggestion'], scope: namedScope }));
    }
    if (/\b(recent events?|decision events?|operational logs?)\b/u.test(normalized)) {
        return onePart(part({ domain: 'decision_events', operation: 'list',
            fields: ['room_name', 'decision_event'], scope: namedScope,
            timeRange: energyRangeFor(normalized), limit: 25 }));
    }
    if (/\b(energy|kwh|waste|efficien)/u.test(normalized) ||
        /\b(ranked? first|rank(ing)?|top consumer)\b/u.test(normalized)) {
        const winner = /\b(ranked? first|who (is|was) first|top consumer|rank one)\b/u
            .test(normalized);
        const ranking = winner || /\b(rank|ranking|compare)\b/u.test(normalized);
        const efficiency = /\b(waste|efficien|reduce)\b/u.test(normalized);
        const report = /\breport\b/u.test(normalized);
        const trend = /\b(trend|over time)\b/u.test(normalized);
        const inherit = winner && roomNames.length === 0 && state !== null &&
            !hasExplicitEnergyRange(normalized);
        return onePart(part({
            domain: 'energy',
            operation: efficiency ? 'explain' : report ? 'report' : ranking ? 'compare' :
                trend ? 'detail' : 'summarize',
            fields: report
                ? ['estimated_kwh', 'runtime_seconds', 'session_count', 'energy_rank', 'energy_trend']
                : ranking ? ['room_name', 'estimated_kwh', 'energy_rank']
                    : trend ? ['estimated_kwh', 'energy_trend']
                        : ['estimated_kwh', 'runtime_seconds', 'session_count'],
            scope: inherit ? scope('previous_request', [], 'active') : namedScope,
            timeRange: energyRangeFor(normalized),
            sort: ranking ? { field: 'estimated_kwh', direction: 'desc' } : undefined,
            followUpReference: inherit ? follow('previous_request') : undefined,
            limit: winner ? 1 : 50,
        }));
    }
    if (/\b(temperature|humidity|hot|heat|condition)\b/u.test(normalized)) {
        const lastKnown = /\b(last[- ]?known|historical|previous)\b/u.test(normalized);
        const fields: SystemField[] = ['room_name', 'device_status'];
        if (/temperature|hot|heat|condition/u.test(normalized)) {
            fields.push(lastKnown ? 'last_known_temperature' : 'temperature');
        }
        if (/humidity/u.test(normalized)) {
            fields.push(lastKnown ? 'last_known_humidity' : 'humidity');
        }
        if (/hot|heat|condition|why/u.test(normalized)) fields.push('condition');
        return onePart(part({ domain: 'measurements', operation: /why|cause/u.test(normalized)
            ? 'explain' : roomNames.length === 1 ? 'detail' : 'compare', fields,
            scope: namedScope }));
    }
    if (/\b(ac (power|state|status)|aircon (on|off)|air conditioner (on|off))\b/u
        .test(normalized)) {
        return onePart(part({ domain: 'ac_control', operation: roomNames.length === 1
            ? 'status' : 'list', fields: ['room_name', 'ac_power', 'device_status'],
            scope: namedScope }));
    }
    if (/\b(device status|online rooms?|offline rooms?|room status|list rooms?)\b/u
        .test(normalized)) {
        const domain: SystemDomain = /device|online|offline/u.test(normalized) ? 'devices' : 'rooms';
        const inventory = /\binactive\b/u.test(normalized) ? 'inactive'
            : /\b(all|every|configured)\b/u.test(normalized) ? 'all' : 'active';
        const statusFilters: SystemFilter[] = domain === 'devices' && /\boffline\b/u.test(normalized)
            ? [stringFilter('device_status', 'offline')]
            : domain === 'devices' && /\bonline\b/u.test(normalized)
                ? [stringFilter('device_status', 'online')]
                : [];
        return onePart(part({ domain, operation: /list|which|what room/u.test(normalized)
            ? 'list' : 'status', fields: domain === 'devices'
                ? ['room_name', 'device_status', 'last_seen']
                : ['room_name', 'room_status', 'device_assignment'],
            filters: statusFilters,
            scope: roomNames.length > 0 ? namedScope : scope('facility', [], inventory) }));
    }
    return null;
}

interface PartOptions {
    readonly domain: SystemDomain;
    readonly operation: SystemOperation;
    readonly fields: SystemField[];
    readonly filters?: SystemFilter[];
    readonly scope?: SystemQueryPart['scope'];
    readonly timeRange?: SystemTimeRange;
    readonly sort?: SystemQueryPart['sort'];
    readonly outputPreference?: SystemQueryPart['outputPreference'];
    readonly followUpReference?: SystemQueryPart['followUpReference'];
    readonly limit?: number;
    readonly clarification?: string;
}

function part(options: PartOptions, partId: ChatPartId = 'part-1'): SystemQueryPart {
    const clarification = cleanText(options.clarification ?? '', 240);
    return {
        partId,
        domain: options.domain,
        operation: options.operation,
        fields: options.fields,
        filters: options.filters ?? [],
        sort: options.sort ?? { field: options.fields[0]!, direction: 'none' },
        scope: options.scope ?? scope('facility', [], 'all'),
        timeRange: options.timeRange ?? defaultTimeRange(),
        outputPreference: options.outputPreference ?? 'auto',
        followUpReference: options.followUpReference ?? follow('none'),
        limit: options.limit ?? 25,
        needsClarification: clarification.length > 0,
        clarification,
    };
}

function onePart(value: SystemQueryPart): SystemQueryPlan { return { parts: [value] }; }

function clarificationPlan(message: string): SystemQueryPlan {
    return onePart(part({ domain: 'conversation', operation: 'clarify',
        fields: ['capabilities'], clarification: message }));
}

function scope(
    kind: SystemQueryPart['scope']['kind'],
    roomNames: string[],
    inventory: SystemQueryPart['scope']['inventory'],
): SystemQueryPart['scope'] {
    return { kind, roomNames, inventory, referencePartId: '' };
}

function follow(kind: SystemQueryPart['followUpReference']['kind']): SystemQueryPart['followUpReference'] {
    return { kind, partId: '', ordinal: 0 };
}

function defaultTimeRange(): SystemTimeRange {
    return { preset: 'this_month', startDate: '', endDate: '', bucket: 'auto' };
}

function booleanFilter(field: SystemField, value: boolean): SystemFilter {
    return { field, operator: 'eq', valueType: 'boolean', stringValue: '',
        numberValue: 0, booleanValue: value, stringValues: [] };
}

function stringFilter(field: SystemField, value: string): SystemFilter {
    return { field, operator: 'eq', valueType: 'string', stringValue: value,
        numberValue: 0, booleanValue: false, stringValues: [] };
}

function buildPartWork(
    requestedParts: readonly SystemQueryPart[],
    executableParts: readonly SystemQueryPart[],
    results: readonly ToolExecutionResult[],
    unresolved: ReadonlyMap<ChatPartId, string>,
    deniedIds: ReadonlySet<ChatPartId>,
    displayPlan: readonly ChatDisplayDirective[],
): PartWork[] {
    return requestedParts.map((requested, index): PartWork => {
        const executable = executableParts[index]!;
        const partResults = results.filter((result) => result.partId === requested.partId);
        const answerability = deniedIds.has(requested.partId) ? 'permission_denied'
            : unresolved.has(requested.partId) || executable.needsClarification
                ? 'clarification_required'
                : determineAnswerability(requested, partResults);
        const facts = partResults.flatMap((result) => result.facts)
            .filter((fact) => fact.partId === requested.partId);
        const scopeResolution = mergeScopes(partResults.map((result) => result.scope));
        const range = partResults.map((result) => result.presentation)
            .find((presentation): presentation is EnergyReportPresentation =>
                presentation.kind === 'energy-report')?.range ?? null;
        const recommendations = buildRecommendations(requested, partResults);
        const packet: AnswerPacket = {
            partId: requested.partId,
            domain: requested.domain,
            operation: requested.operation,
            fields: [...requested.fields],
            scope: scopeResolution,
            range,
            answerability,
            freshness: determineFreshness(partResults),
            facts,
            recommendations,
            notices: uniqueStrings(partResults.flatMap((result) => result.notices)).slice(0, 6),
            displayPlan: displayPlan.filter((directive) => directive.partId === requested.partId),
        };
        return { requested, executable, results: partResults, answerability, packet };
    });
}

function determineAnswerability(
    part: SystemQueryPart,
    results: readonly ToolExecutionResult[],
): ChatAnswerabilityOutcome {
    if (results.length === 0) return deterministicDomain(part.domain) ? 'not_applicable'
        : 'insufficient_evidence';
    const outcomes = results.map((result) => result.outcome);
    if (outcomes.includes('ok') && (results.some((result) => result.partial) ||
        outcomes.some((outcome) =>
            outcome === 'source_unavailable' || outcome === 'insufficient_evidence'))) {
        return 'partial';
    }
    const priority: readonly ToolOutcome[] = [
        'permission_denied', 'room_ambiguous', 'room_not_found', 'room_inactive',
        'no_online_reading', 'no_energy_records', 'source_unavailable',
        'insufficient_evidence', 'ok',
    ];
    const selected = priority.find((outcome) => outcomes.includes(outcome)) ?? 'ok';
    if (selected === 'ok' && results.some((result) => result.partial)) return 'partial';
    if (selected !== 'ok') return selected;

    if (requiresCurrentReading(part)) {
        const roomPresentations = results.map((result) => result.presentation)
            .filter((presentation): presentation is RoomDataPresentation =>
                presentation.kind === 'room-data');
        const currentValues = roomPresentations.flatMap((presentation) => presentation.rooms)
            .flatMap((room) => room.values)
            .filter((value) => part.fields.includes(value.field));
        if (currentValues.length > 0 && !currentValues.some((value) =>
            value.state === 'current' && value.value !== null)) return 'no_online_reading';
    }
    return 'answerable';
}

function determineFreshness(results: readonly ToolExecutionResult[]): AnswerPacket['freshness'] {
    const states = results.flatMap((result) => {
        const presentation = result.presentation;
        if (presentation.kind === 'room-data') {
            return presentation.rooms.flatMap((room) => room.values.map((value) => value.state));
        }
        if (presentation.kind === 'metric-summary') {
            return presentation.metrics.map((value) => value.state);
        }
        return [];
    });
    if (states.length === 0) return 'not_applicable';
    if (states.every((state) => state === 'current')) return 'current';
    if (states.some((state) => state === 'current')) return 'mixed';
    if (states.some((state) => state === 'historical' || state === 'expired')) return 'stale';
    if (states.every((state) => state === 'unavailable' || state === 'unknown')) return 'unavailable';
    return 'mixed';
}

function buildRecommendations(
    part: SystemQueryPart,
    results: readonly ToolExecutionResult[],
): EvidenceBackedRecommendation[] {
    if (part.domain !== 'energy' || part.operation !== 'explain') return [];
    const facts = results.flatMap((result) => result.facts);
    const recommendations: EvidenceBackedRecommendation[] = [];
    const energy = results.map((result) => result.presentation)
        .find((presentation): presentation is EnergyReportPresentation =>
            presentation.kind === 'energy-report');
    if (energy) {
        const coverageFact = facts.find((fact) => /coverage|recorded day/iu.test(fact.statement));
        if (energy.metrics.dataCoveragePercent < 100 && coverageFact) {
            recommendations.push({
                category: 'collect_missing_energy_data',
                text: 'Review the missing OcuTemp energy records before treating this as a complete facility comparison.',
                evidenceRefs: [coverageFact.id],
            });
        }
        const highest = energy.rooms.filter((room) => room.status === 'recorded' &&
            room.runtimeSeconds !== null).sort((left, right) =>
            (right.runtimeSeconds ?? 0) - (left.runtimeSeconds ?? 0))[0];
        const highestFact = highest ? facts.find((fact) =>
            fact.statement.includes(highest.roomName) && /runtime/iu.test(fact.statement)) : undefined;
        if (highest && highestFact) {
            recommendations.push({
                category: 'inspect_high_runtime_room',
                text: `Review ${highest.roomName}'s recorded OcuTemp runtime and configured schedule for the selected period.`,
                evidenceRefs: [highestFact.id],
            });
        }
    }
    const offlineFact = facts.find((fact) => /offline|unavailable assigned-device/iu.test(fact.statement));
    if (offlineFact) {
        recommendations.push({
            category: 'investigate_offline_device',
            text: 'Investigate the OcuTemp rooms whose assigned devices are offline or unavailable before comparing live operation.',
            evidenceRefs: [offlineFact.id],
        });
    }
    return recommendations.slice(0, 5);
}

function buildDeterministicAnswer(work: PartWork, user: ChatPrincipal): ChatAnswerPart {
    const caveats = uniqueStrings(work.packet.notices).slice(0, 3);
    const base = (text: string, blocks: ChatAnswerBlock[] = []): ChatAnswerPart => ({
        partId: work.requested.partId,
        text,
        blocks,
        highlights: [],
        caveats,
    });
    if (work.answerability === 'permission_denied') {
        return base('Your OcuTemp role does not permit access to that information.');
    }
    if (work.answerability === 'clarification_required') {
        return base(work.executable.clarification ||
            'Please clarify the OcuTemp room, scope, or period you want me to use.');
    }
    if (work.answerability === 'room_not_found') {
        const names = work.packet.scope.missingRoomNames;
        return base(`${formatNames(names)} ${names.length === 1 ? 'is' : 'are'} not configured in OcuTemp, so I cannot assess the requested system data.`);
    }
    if (work.answerability === 'room_inactive') {
        const names = work.packet.scope.inactiveRoomNames;
        return base(`${formatNames(names)} ${names.length === 1 ? 'exists' : 'exist'} in OcuTemp but ${names.length === 1 ? 'is' : 'are'} inactive.`);
    }
    if (work.answerability === 'room_ambiguous') {
        return base(`More than one configured room matches ${formatNames(work.packet.scope.ambiguousRoomNames)}. Please use the exact room name.`);
    }
    if (work.answerability === 'no_online_reading') {
        return base('No selected room has an online device with a current reading, so I cannot answer that as a current measurement. You can ask for the last-known value instead.');
    }
    if (work.answerability === 'no_energy_records') {
        const period = work.packet.range?.label ?? 'the selected period';
        return base(`There are no recorded OcuTemp energy values for ${period}.`);
    }
    if (work.answerability === 'source_unavailable') {
        return base('The requested OcuTemp data could not be read safely right now. Please try again shortly.');
    }
    if (work.requested.domain === 'conversation') {
        return work.requested.operation === 'greet'
            ? base('Hi! What would you like to know about your OcuTemp system?')
            : work.requested.operation === 'deny'
                ? base('I can inspect permitted OcuTemp data, but I cannot perform controls, writes, approvals, or configuration changes from chat.')
                : base(work.executable.clarification || 'Please clarify the OcuTemp question you want me to answer.');
    }
    if (work.requested.domain === 'unsupported') {
        return base('I can answer questions grounded in your permitted OcuTemp system data, but I cannot answer that outside-system request.');
    }
    if (work.requested.domain === 'assistant_capabilities') {
        const domains = capabilitiesForRole(user.role)
            .map((capability) => domainLabel(capability.domain));
        const items = uniqueStrings(domains).filter((domain) =>
            !['Conversation', 'Unsupported'].includes(domain));
        return base(
            'I can answer read-only questions about the OcuTemp data your role is allowed to access.',
            [{ kind: 'bullet-list', text: '', items, entries: [], tone: 'info' }],
        );
    }
    if (work.requested.domain === 'own_account') return ownAccountAnswer(work, user);

    const presentation = work.results[0]?.presentation;
    if (!presentation) return base('There is not enough verified OcuTemp data to answer that question.');
    switch (presentation.kind) {
        case 'metric-summary': return metricAnswer(work, presentation, caveats);
        case 'room-data': return roomDataAnswer(work, presentation, caveats);
        case 'schedule-data': return scheduleAnswer(work, presentation, caveats);
        case 'energy-report': return energyAnswer(work, presentation, caveats);
        case 'climate-suggestions': return climateAnswer(work, presentation, caveats);
        case 'recent-events': return eventsAnswer(work, presentation, caveats);
        case 'system-help': return helpAnswer(work, presentation, caveats);
        case 'room-telemetry':
            return base('The verified room result is available, but it could not be projected into the current answer format.');
    }
}

function ownAccountAnswer(work: PartWork, user: ChatPrincipal): ChatAnswerPart {
    const entries: Array<{ label: string; value: string }> = [];
    for (const field of work.requested.fields) {
        if (field === 'account_name') entries.push({ label: 'Name', value: user.fullName ?? 'Not available' });
        if (field === 'account_email') entries.push({ label: 'Email', value: user.email ?? 'Not available' });
        if (field === 'account_role') entries.push({ label: 'Role', value: user.role === 'admin' ? 'Administrator' : 'Staff' });
        if (field === 'account_approval') entries.push({ label: 'Approval', value: 'Approved' });
    }
    return {
        partId: work.requested.partId,
        text: entries.map((entry) => `${entry.label}: ${entry.value}`).join(' · '),
        blocks: [{ kind: 'key-value', text: '', items: [], entries, tone: 'neutral' }],
        highlights: [], caveats: [],
    };
}

function metricAnswer(
    work: PartWork,
    presentation: MetricSummaryPresentation,
    caveats: string[],
): ChatAnswerPart {
    const scopeNames = work.packet.scope.matchedRoomNames;
    if (work.requested.operation === 'list' && scopeNames.length > 0) {
        return answer(work.requested.partId,
            `${scopeNames.length} ${scopeNames.length === 1 ? 'room matches' : 'rooms match'}: ${formatNames(scopeNames)}.`, [], caveats);
    }
    const metrics = presentation.metrics.filter((metric) =>
        work.requested.fields.includes(metric.field));
    if (metrics.length === 0) {
        return answer(work.requested.partId,
            'The requested OcuTemp value is unknown or unavailable.', [], caveats);
    }
    const text = metrics.map((metric) => `${metric.label}: ${formatProjectedValue(metric)}`).join(' · ');
    return answer(work.requested.partId, text, [{ kind: 'key-value', text: '', items: [],
        entries: metrics.map((metric) => ({ label: metric.label,
            value: formatProjectedValue(metric) })), tone: 'neutral' }], caveats);
}

function roomDataAnswer(
    work: PartWork,
    presentation: RoomDataPresentation,
    caveats: string[],
): ChatAnswerPart {
    if (presentation.rooms.length === 0) {
        return answer(work.requested.partId, 'No rooms matched the requested OcuTemp scope.', [], caveats);
    }
    const relevant = presentation.rooms.map((room) => ({
        roomName: room.roomName,
        values: room.values.filter((value) => work.requested.fields.includes(value.field)),
    }));
    if (relevant.length === 1) {
        const room = relevant[0]!;
        const values = room.values.map((value) => `${value.label}: ${formatProjectedValue(value)}`);
        const causeBoundary = work.requested.operation === 'explain' &&
            work.requested.domain === 'measurements'
            ? ' OcuTemp does not contain verified data that identifies the cause.'
            : '';
        return answer(work.requested.partId,
            `${room.roomName} — ${values.join(' · ')}.${causeBoundary}`,
            [], caveats);
    }
    const items = relevant.slice(0, 8).map((room) =>
        `${room.roomName}: ${room.values.map((value) =>
            `${value.label} ${formatProjectedValue(value)}`).join(', ')}`);
    return answer(work.requested.partId,
        `${relevant.length} rooms have verified projected results for this request.`,
        items.length <= 6
            ? [{ kind: 'bullet-list', text: '', items, entries: [], tone: 'neutral' }]
            : [], caveats);
}

function scheduleAnswer(
    work: PartWork,
    presentation: ScheduleDataPresentation,
    caveats: string[],
): ChatAnswerPart {
    if (presentation.schedules.length === 0) {
        return answer(work.requested.partId,
            'There are no valid configured schedules in the selected room scope.', [], caveats);
    }
    const items = presentation.schedules.slice(0, 8).map((schedule) =>
        `${schedule.roomName}: ${schedule.day}, ${schedule.startTime}–${schedule.endTime}` +
        (schedule.subject ? ` (${schedule.subject})` : ''));
    return answer(work.requested.partId,
        `${presentation.schedules.length} configured ${presentation.schedules.length === 1 ? 'schedule is' : 'schedules are'} available.`,
        presentation.schedules.length <= 8
            ? [{ kind: 'bullet-list', text: '', items, entries: [], tone: 'neutral' }]
            : [], caveats);
}

function energyAnswer(
    work: PartWork,
    presentation: EnergyReportPresentation,
    caveats: string[],
): ChatAnswerPart {
    const recorded = presentation.rooms.filter((room) => room.status === 'recorded');
    if (recorded.length === 0 || presentation.metrics.totalKwh === null) {
        return answer(work.requested.partId,
            `There are no recorded estimated energy values for ${presentation.range.label}.`, [], caveats);
    }
    if (work.requested.operation === 'compare' && work.requested.limit === 1) {
        const rank = Math.min(...recorded.map((room) => room.rank ?? Number.MAX_SAFE_INTEGER));
        const winners = recorded.filter((room) => room.rank === rank);
        const value = winners[0]?.estimatedKwh;
        return answer(work.requested.partId,
            `${formatNames(winners.map((room) => room.roomName))} ${winners.length === 1 ? 'ranked' : 'tied for'} first for ${presentation.range.label}` +
            `${value === null || value === undefined ? '' : ` at ${formatNumber(value)} kWh`} (estimated).`, [], caveats);
    }
    if (work.requested.operation === 'compare') {
        const top = [...recorded].sort((left, right) =>
            (left.rank ?? 999) - (right.rank ?? 999)).slice(0, 3);
        return answer(work.requested.partId,
            `${recorded.length} rooms have recorded estimated energy for ${presentation.range.label}.`,
            [{ kind: 'bullet-list', text: '', items: top.map((room) =>
                `#${room.rank ?? '—'} ${room.roomName}: ${formatNumber(room.estimatedKwh ?? 0)} kWh`),
            entries: [], tone: 'neutral' }], caveats);
    }
    return answer(work.requested.partId,
        `Estimated OcuTemp energy for ${presentation.range.label} is ${formatNumber(presentation.metrics.totalKwh)} kWh across ${presentation.metrics.roomsWithRecords} rooms with records.`,
        [], caveats);
}

function climateAnswer(
    work: PartWork,
    presentation: ClimateSuggestionsPresentation,
    caveats: string[],
): ChatAnswerPart {
    const available = presentation.rooms.filter((room) => room.status === 'available');
    if (available.length === 0) {
        return answer(work.requested.partId,
            'No stored climate suggestion is available for the selected rooms.', [], caveats);
    }
    const items = available.slice(0, 6).map((row) =>
        `${row.roomName}: ${row.suggestedTemp === null ? 'unknown' : `${formatNumber(row.suggestedTemp)} °C`}` +
        `${row.reason ? ` — ${row.reason}` : ''}`);
    return answer(work.requested.partId,
        `${available.length} ${available.length === 1 ? 'room has' : 'rooms have'} a stored climate suggestion.`,
        [{ kind: 'bullet-list', text: '', items, entries: [], tone: 'neutral' }], caveats);
}

function eventsAnswer(
    work: PartWork,
    presentation: RecentEventsPresentation,
    caveats: string[],
): ChatAnswerPart {
    if (presentation.events.length === 0) {
        return answer(work.requested.partId,
            'No matching recorded OcuTemp decision events were found in the selected scope and period.', [], caveats);
    }
    const items = presentation.events.slice(0, 6).map((event) =>
        `${event.roomName}: ${event.eventType} — ${event.detail}`);
    return answer(work.requested.partId,
        `${presentation.events.length} matching recorded ${presentation.events.length === 1 ? 'event was' : 'events were'} found.`,
        [{ kind: 'bullet-list', text: '', items, entries: [], tone: 'neutral' }], caveats);
}

function helpAnswer(
    work: PartWork,
    presentation: Extract<ChatPresentation, { kind: 'system-help' }>,
    caveats: string[],
): ChatAnswerPart {
    if (presentation.restricted) {
        return answer(work.requested.partId,
            'That OcuTemp task is restricted to administrators.', [], caveats);
    }
    if (presentation.steps.length === 0) {
        return answer(work.requested.partId,
            'No verified OcuTemp guidance matched that topic.', [], caveats);
    }
    return answer(work.requested.partId, presentation.title,
        [{ kind: 'numbered-list', text: '', items: [...presentation.steps], entries: [],
            tone: 'info' }], caveats);
}

function answer(
    partId: ChatPartId,
    text: string,
    blocks: ChatAnswerBlock[],
    caveats: string[],
): ChatAnswerPart {
    return { partId, text: cleanText(text, 1_500), blocks, highlights: [], caveats };
}

function selectDisplayPlan(
    parts: readonly SystemQueryPart[],
    results: readonly ToolExecutionResult[],
): ChatDisplayDirective[] {
    for (const part of parts) {
        if (part.outputPreference === 'text' || part.needsClarification) continue;
        const partResults = results.filter((result) => result.partId === part.partId);
        if (!partResults.some((result) => result.outcome === 'ok')) continue;
        if (requiresCurrentReading(part)) {
            const requestedCurrentFields = part.fields.filter((field) =>
                ['temperature', 'humidity', 'condition', 'occupancy', 'ac_power'].includes(field));
            const hasCurrentValue = partResults.some((result) =>
                result.presentation.kind === 'room-data' &&
                result.presentation.rooms.some((room) => room.values.some((value) =>
                    requestedCurrentFields.includes(value.field) &&
                    value.state === 'current' && value.value !== null)));
            if (!hasCurrentValue) continue;
        }
        const presentations = partResults
            .map((result) => result.presentation);
        for (const presentation of presentations) {
            const mode = compatibleDisplayMode(part, presentation);
            if (mode) return [{ partId: part.partId, presentationId: presentation.id, mode }];
        }
    }
    return [];
}

function compatibleDisplayMode(
    part: SystemQueryPart,
    presentation: ChatPresentation,
): ChatDisplayMode | null {
    if (presentation.availability === 'unavailable') return null;
    if (part.outputPreference === 'table') {
        return hasMeaningfulRows(presentation) ? 'table' : null;
    }
    if (part.outputPreference === 'graph') {
        if (presentation.kind !== 'energy-report') return null;
        if (part.fields.includes('energy_trend') &&
            presentation.trend.filter((point) => point.estimatedKwh !== null).length >= 2) {
            return 'trend_chart';
        }
        const recorded = presentation.rooms.filter((room) => room.status === 'recorded').length;
        return recorded >= 2 && recorded <= 20 ? 'ranking_chart' : null;
    }
    if (part.operation === 'report' && presentation.kind === 'energy-report') {
        return 'full_report';
    }
    if (part.operation === 'compare' && presentation.kind === 'energy-report') {
        const recorded = presentation.rooms.filter((room) => room.status === 'recorded').length;
        if (part.limit === 1) return null;
        return recorded >= 2 && recorded <= 20 ? 'ranking_chart' : null;
    }
    if (part.fields.includes('energy_trend') && presentation.kind === 'energy-report' &&
        presentation.trend.filter((point) => point.estimatedKwh !== null).length >= 2) {
        return 'trend_chart';
    }
    if (presentation.kind === 'room-data' && presentation.rooms.length >= 2 &&
        presentation.rooms.some((room) => room.values.length >= 2)) return 'table';
    if (presentation.kind === 'schedule-data' && presentation.schedules.length > 8) return 'table';
    return null;
}

function hasMeaningfulRows(presentation: ChatPresentation): boolean {
    if (presentation.kind === 'room-data') return presentation.rooms.length >= 2;
    if (presentation.kind === 'schedule-data') return presentation.schedules.length >= 2;
    if (presentation.kind === 'energy-report') return presentation.rooms.length >= 2;
    if (presentation.kind === 'climate-suggestions') return presentation.rooms.length >= 2;
    if (presentation.kind === 'recent-events') return presentation.events.length >= 2;
    return false;
}

function conflictingExplicitVisuals(parts: readonly SystemQueryPart[]): boolean {
    const requested = parts.filter((part) =>
        part.outputPreference === 'table' || part.outputPreference === 'graph')
        .map((part) => part.outputPreference === 'table' ? 'table'
            : part.fields.includes('energy_trend') ? 'trend_graph' : 'ranking_graph');
    return new Set(requested).size > 1;
}

function validateWriterDraft(
    value: GroundedAnswerDraft,
    packet: AnswerPacket,
): GroundedAnswerDraft {
    if (!isRecord(value) || !hasExactKeys(value, ['text', 'evidenceRefs', 'highlights',
        'recommendations']) || typeof value['text'] !== 'string' ||
        !Array.isArray(value['evidenceRefs']) || !Array.isArray(value['highlights']) ||
        !Array.isArray(value['recommendations'])) throw new Error('invalid_writer_shape');
    const factById = new Map(packet.facts.map((fact) => [fact.id, fact]));
    const text = validateGroundedText(value['text'], value['evidenceRefs'], factById,
        packet.scope.matchedRoomNames);
    const highlights = value['highlights'].map((highlight) => {
        if (!isRecord(highlight) || !hasExactKeys(highlight, ['text', 'evidenceRefs']) ||
            typeof highlight['text'] !== 'string' || !Array.isArray(highlight['evidenceRefs'])) {
            throw new Error('invalid_highlight');
        }
        return {
            text: validateGroundedText(highlight['text'], highlight['evidenceRefs'], factById,
                packet.scope.matchedRoomNames),
            evidenceRefs: validateEvidenceRefs(highlight['evidenceRefs'], factById),
        };
    }).slice(0, 6);
    const evidenceRefs = validateEvidenceRefs(value['evidenceRefs'], factById);
    const recommendations = value['recommendations'].map((recommendation) => {
        if (!isRecord(recommendation)) throw new Error('invalid_recommendation');
        const exact = packet.recommendations.find((allowed) =>
            recommendation['category'] === allowed.category &&
            recommendation['text'] === allowed.text &&
            JSON.stringify(recommendation['evidenceRefs']) === JSON.stringify(allowed.evidenceRefs));
        if (!exact) throw new Error('unapproved_recommendation');
        return { ...exact };
    });
    return { text, evidenceRefs, highlights, recommendations };
}

function validateGroundedText(
    rawText: string,
    rawRefs: unknown[],
    factById: ReadonlyMap<string, GroundingFact>,
    roomNames: readonly string[],
): string {
    const text = cleanText(rawText, 1_200);
    if (!text || /```|<\/?[a-z]|\b(filters?|insulation|refrigerant|electrical repair|service the|setpoint)\b/iu
        .test(text)) throw new Error('unsafe_writer_text');
    const refs = validateEvidenceRefs(rawRefs, factById);
    const support = refs.map((ref) => factById.get(ref)!.statement).join(' ');
    const supportedNumbers = new Set(numberTokens(support));
    if (numberTokens(text).some((number) => !supportedNumbers.has(number))) {
        throw new Error('invented_number');
    }
    const supportedUnitClaims = new Set(numericUnitClaims(support));
    if (numericUnitClaims(text).some((claim) => !supportedUnitClaims.has(claim))) {
        throw new Error('invented_value_unit_association');
    }
    for (const match of text.matchAll(/\broom\s+\d[\p{L}\p{N}_-]{0,40}\b/giu)) {
        if (!support.toLocaleLowerCase('en-US').includes(
            match[0].toLocaleLowerCase('en-US'),
        )) throw new Error('invented_room_reference');
    }
    for (const roomName of roomNames) {
        const normalizedRoomName = roomName.toLocaleLowerCase('en-US');
        if (text.toLocaleLowerCase('en-US').includes(normalizedRoomName) &&
            !support.toLocaleLowerCase('en-US').includes(normalizedRoomName)) {
            throw new Error('room_fact_mismatch');
        }
        const relatedSupport = refs.map((ref) => factById.get(ref)!.statement)
            .filter((statement) => statement.toLocaleLowerCase('en-US').includes(normalizedRoomName))
            .join(' ');
        if (!relatedSupport) continue;
        const relatedClaims = new Set(numericUnitClaims(relatedSupport));
        for (const sentence of text.split(/[.!?\n]+/u)) {
            if (!sentence.toLocaleLowerCase('en-US').includes(normalizedRoomName)) continue;
            if (numericUnitClaims(sentence).some((claim) => !relatedClaims.has(claim))) {
                throw new Error('room_value_association_mismatch');
            }
        }
    }
    return text;
}

function validateEvidenceRefs(
    values: unknown[],
    factById: ReadonlyMap<string, GroundingFact>,
): string[] {
    if (values.length < 1 || values.length > 12 || values.some((value) =>
        typeof value !== 'string' || !factById.has(value))) throw new Error('invalid_evidence');
    const refs = [...new Set(values as string[])];
    if (refs.length !== values.length) throw new Error('duplicate_evidence');
    return refs;
}

function answerPartFromDraft(work: PartWork, draft: GroundedAnswerDraft): ChatAnswerPart {
    const blocks: ChatAnswerBlock[] = draft.recommendations.length > 0 ? [{
        kind: 'bullet-list', text: 'Grounded next steps',
        items: draft.recommendations.map((recommendation) => recommendation.text),
        entries: [], tone: 'info',
    }] : [];
    return {
        partId: work.requested.partId,
        text: draft.text,
        blocks,
        highlights: draft.highlights.map((highlight) => ({ text: highlight.text })),
        caveats: work.packet.notices.slice(0, 3),
    };
}

function shouldUseWriter(work: PartWork): boolean {
    return ['compare', 'summarize', 'report', 'explain'].includes(work.requested.operation) &&
        (work.answerability === 'answerable' || work.answerability === 'partial') &&
        work.requested.domain !== 'own_account';
}

function boundPacket(packet: AnswerPacket, factLimit: number): AnswerPacket {
    let facts = packet.facts.slice(0, Math.max(0, factLimit));
    const validIds = new Set(facts.map((fact) => fact.id));
    let recommendations = packet.recommendations.filter((recommendation) =>
        recommendation.evidenceRefs.every((ref) => validIds.has(ref)));
    let candidate: AnswerPacket = { ...packet, facts, recommendations };
    while (facts.length > 0 && textEncoder.encode(JSON.stringify(candidate)).byteLength >
        MAX_PROVIDER_PACKET_BYTES) {
        facts = facts.slice(0, -1);
        const ids = new Set(facts.map((fact) => fact.id));
        recommendations = recommendations.filter((recommendation) =>
            recommendation.evidenceRefs.every((ref) => ids.has(ref)));
        candidate = { ...candidate, facts, recommendations };
    }
    return candidate;
}

function buildStateTurn(
    works: readonly PartWork[],
    tools: readonly PlannerToolPlan[],
    displayPlan: readonly ChatDisplayDirective[],
): ChatStateTurn {
    const contexts: ChatStateContext[] = works.map((work) => ({
        partId: work.requested.partId,
        domain: work.requested.domain,
        operation: work.requested.operation,
        fields: [...work.requested.fields],
        requestedScope: { ...work.executable.scope,
            roomNames: [...work.executable.scope.roomNames] },
        timeRange: { ...work.executable.timeRange },
        toolNames: uniqueStrings(tools.filter((tool) => tool.partId === work.requested.partId)
            .map((tool) => tool.name)) as ChatToolName[],
        answerability: work.answerability,
        hadVisual: displayPlan.some((directive) => directive.partId === work.requested.partId),
    }));
    const referents: ChatStateReferent[] = works.map((work): ChatStateReferent | null => {
        const energy = work.results.map((result) => result.presentation)
            .find((presentation): presentation is EnergyReportPresentation =>
                presentation.kind === 'energy-report');
        const orderedNames = energy
            ? energy.rooms.filter((room) => room.status === 'recorded')
                .sort((left, right) => (left.rank ?? 999) - (right.rank ?? 999))
                .map((room) => room.roomName)
            : work.packet.scope.matchedRoomNames;
        const names = uniqueStrings(orderedNames).slice(0, 50);
        if (names.length === 0) return null;
        return {
            sourcePartId: work.requested.partId,
            kind: 'room_result',
            roomNames: names,
            complete: !work.results.some((result) => result.partial) && orderedNames.length <= 50,
            ordering: energy ? 'ranking' : 'query',
        };
    }).filter((referent): referent is ChatStateReferent => referent !== null);
    return { contexts, referents };
}

function buildFollowUps(works: readonly PartWork[]): ChatFollowUp[] {
    const result: ChatFollowUp[] = [];
    for (const work of works) {
        if (!['answerable', 'partial'].includes(work.answerability)) continue;
        if (work.requested.domain === 'energy' && work.requested.operation !== 'compare') {
            result.push({ label: 'Top-ranked room',
                prompt: 'Which room ranked first for that same energy period?' });
        }
        const rooms = work.packet.scope.matchedRoomNames;
        if (rooms.length > 0 && rooms.length <= 10 && work.requested.domain !== 'schedules') {
            result.push({ label: 'Room schedules',
                prompt: 'List the configured schedules for those rooms.' });
        }
        if (rooms.length > 0 && work.requested.domain !== 'ai_auto_apply') {
            result.push({ label: 'AI auto-apply',
                prompt: 'Which of those rooms have AI auto-apply enabled?' });
        }
    }
    const seen = new Set<string>();
    return result.filter((item) => {
        const key = item.prompt.toLocaleLowerCase('en-US');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 3);
}

function mergeScopes(scopes: readonly RoomScopeResolution[]): RoomScopeResolution {
    return {
        requestedNames: uniqueStrings(scopes.flatMap((scopeValue) => scopeValue.requestedNames)),
        matchedRoomNames: uniqueStrings(scopes.flatMap((scopeValue) => scopeValue.matchedRoomNames)),
        inactiveRoomNames: uniqueStrings(scopes.flatMap((scopeValue) => scopeValue.inactiveRoomNames)),
        missingRoomNames: uniqueStrings(scopes.flatMap((scopeValue) => scopeValue.missingRoomNames)),
        ambiguousRoomNames: uniqueStrings(scopes.flatMap((scopeValue) => scopeValue.ambiguousRoomNames)),
        activeRoomNames: uniqueStrings(scopes.flatMap((scopeValue) => scopeValue.activeRoomNames)),
    };
}

function emptyScopeResolution(): RoomScopeResolution {
    return { requestedNames: [], matchedRoomNames: [], inactiveRoomNames: [],
        missingRoomNames: [], ambiguousRoomNames: [], activeRoomNames: [] };
}

function safeStateForPlanner(state: ChatStatePayload | null): unknown {
    if (!state) return null;
    return state.turns.map((turn) => ({
        contexts: turn.contexts.map((context) => ({
            partId: context.partId,
            domain: context.domain,
            operation: context.operation,
            fields: context.fields,
            requestedScope: context.requestedScope,
            timeRange: context.timeRange,
            answerability: context.answerability,
        })),
        referents: turn.referents,
    }));
}

function isSemanticPlanningFailure(error: unknown): boolean {
    if (error instanceof ProviderResponseError) return true;
    if (!(error instanceof BothProvidersFailedError)) return false;
    return error.primaryError instanceof ProviderResponseError ||
        error.fallbackError instanceof ProviderResponseError ||
        error.primaryError instanceof CapabilityValidationError ||
        error.fallbackError instanceof CapabilityValidationError;
}

function deterministicHelpTopic(message: string): string | null {
    if (!/\b(how (do|can) i|where (do|can) i|steps? to)\b/u.test(message)) return null;
    if (/change.*password/u.test(message)) return 'change-password';
    if (/add|create.*room/u.test(message)) return 'add-room';
    if (/edit|update.*room/u.test(message)) return 'edit-room';
    if (/assign.*floor|floor.*assign/u.test(message)) return 'assign-floor-plan-cell';
    if (/floor.*legend/u.test(message)) return 'floor-plan-legend';
    if (/schedule/u.test(message)) return 'manage-schedules';
    if (/approve.*staff/u.test(message)) return 'approve-staff';
    if (/energy.*report|report.*energy/u.test(message)) return 'view-energy-reports';
    if (/forced?.*off/u.test(message)) return 'forced-off';
    if (/override/u.test(message)) return 'manual-override';
    if (/ocu.?guide|chat/u.test(message)) return 'ocu-guide';
    return null;
}

function explicitRoomNames(message: string): string[] {
    const values: string[] = [];
    for (const match of message.matchAll(/\broom\s+([\p{L}\p{N}][\p{L}\p{N}_-]{0,40})\b/giu)) {
        values.push(`Room ${match[1]}`);
    }
    for (const match of message.matchAll(/["“]([^"”]{1,100})["”]/gu)) {
        if (/room/iu.test(match[1]!)) values.push(match[1]!);
    }
    return uniqueStrings(values.map((value) => cleanText(value, 100)));
}

function energyRangeFor(message: string): SystemTimeRange {
    let preset: SystemTimeRange['preset'] = 'this_month';
    if (/\btoday\b/u.test(message)) preset = 'today';
    else if (/\blast 7 days?\b/u.test(message)) preset = 'last_7_days';
    else if (/\blast week\b/u.test(message)) preset = 'last_week';
    else if (/\bthis week\b/u.test(message)) preset = 'this_week';
    else if (/\blast month\b/u.test(message)) preset = 'last_month';
    else if (/\b(last 12 months?|past year)\b/u.test(message)) preset = 'last_12_months';
    else if (/\b(this|whole|current) year|\byearly\b|\bannual\b/u.test(message)) preset = 'this_year';
    const dates = message.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
    if (dates.length === 1) {
        return { preset: 'custom', startDate: dates[0]!, endDate: dates[0]!, bucket: 'day' };
    }
    if (dates.length >= 2) {
        return { preset: 'custom', startDate: dates[0]!, endDate: dates[1]!,
            bucket: requestedBucket(message) };
    }
    return { preset, startDate: '', endDate: '', bucket: requestedBucket(message) };
}

function requestedBucket(message: string): SystemTimeRange['bucket'] {
    if (/\bdaily\b/u.test(message)) return 'day';
    if (/\bweekly\b/u.test(message)) return 'week';
    if (/\bmonthly\b/u.test(message)) return 'month';
    if (/\byearly\b|\bannual\b/u.test(message)) return 'year';
    return 'auto';
}

function hasExplicitEnergyRange(message: string): boolean {
    return /\b(today|week|month|year|annual|\d{4}-\d{2}-\d{2})\b/u.test(message);
}

function formatProjectedValue(value: ProjectedValue): string {
    if (value.value === null) return value.state === 'expired' ? 'expired'
        : value.state === 'unavailable' ? 'unavailable' : 'unknown';
    let formatted: string;
    if (typeof value.value === 'boolean') formatted = value.value ? 'Yes' : 'No';
    else if (typeof value.value === 'number') formatted = formatNumber(value.value);
    else formatted = value.value;
    if (value.unit === 'celsius') formatted += ' °C';
    if (value.unit === 'percent') formatted += '%';
    if (value.unit === 'kwh') formatted += ' kWh';
    if (value.unit === 'seconds') formatted += ' seconds';
    if (value.state === 'historical') formatted += ' (last known)';
    if (value.state === 'configured') formatted += ' (configured)';
    if (value.state === 'expired') formatted += ' (expired)';
    return formatted;
}

function formatNames(names: readonly string[]): string {
    if (names.length === 0) return 'The requested room';
    if (names.length === 1) return names[0]!;
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function domainLabel(domain: SystemDomain): string {
    const labels: Partial<Record<SystemDomain, string>> = {
        rooms: 'Rooms and room inventory', devices: 'Devices and connectivity',
        measurements: 'Current and last-known room readings', occupancy: 'Occupancy readings',
        ac_control: 'AC power state', overrides: 'Stored override configuration',
        ai_auto_apply: 'AI auto-apply configuration', schedules: 'Configured schedules',
        energy: 'Estimated energy reports and rankings',
        climate_suggestions: 'Stored climate suggestions',
        decision_events: 'Recorded decision events', floor_plan: 'Floor-plan assignments',
        own_account: 'Your own account facts', admin_user_aggregates: 'Aggregate user counts',
        app_help: 'Verified OcuTemp how-to guidance',
        assistant_capabilities: 'Assistant capabilities', conversation: 'Conversation',
        unsupported: 'Unsupported',
    };
    return labels[domain] ?? domain;
}

function requiresCurrentReading(part: SystemQueryPart): boolean {
    return part.fields.some((field) =>
        ['temperature', 'humidity', 'condition', 'occupancy', 'ac_power'].includes(field));
}

function deterministicDomain(domain: SystemDomain): boolean {
    return ['conversation', 'unsupported', 'assistant_capabilities', 'own_account'].includes(domain);
}

function isPriorPartDependency(part: SystemQueryPart): boolean {
    return part.scope.kind === 'prior_part' || part.followUpReference.kind === 'prior_part';
}

function legacyFocusFor(part: SystemQueryPart): ChatQuestionFocus {
    if (part.domain === 'measurements') {
        if (part.fields.includes('last_known_temperature')) return 'last_known_temperature';
        if (part.fields.includes('humidity')) return 'current_humidity';
        if (part.fields.includes('condition')) return 'current_condition';
        return 'current_temperature';
    }
    if (part.domain === 'energy') {
        if (part.operation === 'report') return 'energy_report';
        if (part.operation === 'compare' && part.limit === 1) return 'energy_rank_winner';
        if (part.operation === 'compare') return 'energy_ranking';
        if (part.fields.includes('energy_trend')) return 'energy_trend';
        if (part.operation === 'explain') return 'facility_efficiency_analysis';
        return 'energy_total';
    }
    if (part.domain === 'schedules') return part.operation === 'count'
        ? 'schedule_count' : 'schedule_list';
    if (part.domain === 'ai_auto_apply') return 'ai_auto_apply_status';
    if (part.domain === 'devices') return 'device_status';
    if (part.domain === 'ac_control') return 'ac_power_status';
    if (part.domain === 'app_help') return 'system_help';
    if (part.domain === 'conversation' && part.operation === 'greet') return 'greeting';
    if (part.domain === 'conversation' && part.operation === 'deny') return 'control_request';
    return 'unsupported';
}

function numberTokens(value: string): string[] {
    return value.match(/-?\d+(?:\.\d+)?/gu) ?? [];
}

function numericUnitClaims(value: string): string[] {
    return [...value.matchAll(
        /(-?\d+(?:\.\d+)?)\s*(°\s*c|degrees?\s+c(?:elsius)?|%|kwh|seconds?|minutes?|hours?)/giu,
    )].map((match) => {
        const rawUnit = match[2]!.replace(/\s+/gu, '').toLocaleLowerCase('en-US');
        const unit = rawUnit.includes('°') || rawUnit.startsWith('degree')
            ? 'celsius'
            : rawUnit.startsWith('second') ? 'seconds'
                : rawUnit.startsWith('minute') ? 'minutes'
                    : rawUnit.startsWith('hour') ? 'hours' : rawUnit;
        return `${match[1]}:${unit}`;
    });
}

function countExplicitQuestions(message: string): number {
    return (message.match(/\?/gu) ?? []).length;
}

function hasMultipleSystemTopics(message: string): boolean {
    const normalized = cleanText(message, 2_000).toLocaleLowerCase('en-US');
    const topicPatterns: readonly RegExp[] = [
        /\b(room count|total rooms?|how many rooms?|list rooms?|room status)\b/u,
        /\b(devices?|online|offline|last seen)\b/u,
        /\b(temperature|humidity|hot|heat|condition)\b/u,
        /\b(occupancy|occupied|occupants?)\b/u,
        /\b(ac power|ac state|aircon|air conditioner)\b/u,
        /\b(overrides?)\b/u,
        /\b(ai auto[- ]?apply|auto[- ]?apply|ai toggle)\b/u,
        /\b(schedules?|timetable)\b/u,
        /\b(energy|kwh|waste|efficien|ranked? first|ranking|top consumer)\b/u,
        /\b(climate suggestion|ml suggestion|temperature suggestion)\b/u,
        /\b(decision events?|operational logs?)\b/u,
        /\b(floor[ -]?plan|map layout|assigned cells?)\b/u,
        /\b(users?|accounts?|admins?|staff)\b/u,
    ];
    return topicPatterns.filter((pattern) => pattern.test(normalized)).length > 1;
}

function manilaDateKey(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const value = Object.fromEntries(parts.map((partValue) => [partValue.type, partValue.value]));
    return `${value['year']}-${value['month']}-${value['day']}`;
}

function cleanText(value: string, maximum: number): string {
    return Array.from(value.normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ')
        .replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('');
}

function uniqueStrings(values: readonly string[]): string[] {
    const seen = new Set<string>();
    return values.filter((value) => {
        const key = value.toLocaleLowerCase('en-US');
        if (!value || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function numberOrZero(value: number | null): number { return value ?? 0; }
void numberOrZero;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new Error('chat_turn_aborted');
}

function durationBucket(durationMs: number): string {
    if (durationMs < 500) return 'under_500ms';
    if (durationMs < 1_500) return '500_1499ms';
    if (durationMs < 3_000) return '1500_2999ms';
    if (durationMs < 6_000) return '3000_5999ms';
    return '6000ms_or_more';
}

function logSafe(
    requestId: string,
    stage: string,
    fields: Readonly<Record<string, string | number>>,
): void {
    console.info('[chat] stage', { requestId, stage, ...fields });
}

void emptyScopeResolution;
