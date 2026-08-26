import type { FirebaseRestClient } from './firebase-rest.js';
import {
    CAPABILITY_REGISTRY,
    CapabilityValidationError,
    HELP_TOPIC_ROLES,
    capabilitiesForRole,
    compileSystemQueryPlan,
    plannerCapabilitySlice,
    validateDialoguePlan,
    validateSystemQueryPlan,
} from './capabilities.js';
import { ANSWERER_SYSTEM_PROMPT } from './prompts/answerer.prompt.js';
import {
    PLANNER_REPAIR_SYSTEM_PROMPT,
    PLANNER_SYSTEM_PROMPT,
} from './prompts/planner.prompt.js';
import { GeminiProvider } from './providers/gemini.provider.js';
import { GroqProvider } from './providers/groq.provider.js';
import {
    ProviderRecoverableError,
    ProviderRequestError,
    ProviderResponseError,
} from './providers/provider.interface.js';
import { BothProvidersFailedError, generateWithFallback } from './retry.js';
import { CHAT_STATE_MAX_TURNS } from './state.js';
import { trustedSystemConceptFacts } from './system-concepts.js';
import { ANSWER_OUTPUT_SCHEMA, DIALOGUE_PLAN_SCHEMA } from './tools/schema.js';
import { executeToolPlans } from './tools/executor.js';
import type {
    AnswerPacket,
    ChatAnswerBlock,
    ChatAnswerPart,
    ChatAnswerabilityOutcome,
    ChatDisplayDirective,
    ChatDisplayMode,
    ChatDialogueAct,
    ChatFollowUp,
    ChatPartId,
    ChatPresentation,
    ChatPrincipal,
    ChatQuestionFocus,
    ChatResponseContext,
    ChatStateContext,
    ChatStatePayload,
    ChatStateReferent,
    ChatStateResultMemory,
    ChatStateTurn,
    ChatToolName,
    ClimateSuggestionsPresentation,
    DialoguePart,
    DialoguePlan,
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

const PLANNER_PRIMARY_MS = 4_000;
const PLANNER_FALLBACK_MS = 2_500;
const PLANNER_REPAIR_MS = 2_500;
const PLANNING_RESERVE_MS = 6_000;
const WRITER_MIN_REMAINING_MS = 3_500;
const WRITER_PRIMARY_MS = 3_500;
const WRITER_FALLBACK_MS = 2_500;
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

interface PlannerOutcome {
    readonly plan: DialoguePlan;
    readonly attempts: 1 | 2;
    readonly source: 'primary' | 'fallback' | 'verified_context';
}

const geminiProvider = new GeminiProvider();
const groqProvider = new GroqProvider();

export async function runChatTurn(input: RunChatTurnInput): Promise<ChatTurnCoreResult> {
    assertNotAborted(input.abortSignal);
    const startedAt = Date.now();
    const deadlineAtMs = input.deadlineAtMs ?? startedAt + 20_000;
    const explicitQuestionCount = countExplicitQuestions(input.message);
    let dialoguePlan: DialoguePlan;
    let dialogueSource: 'safety' | 'semantic' | 'provider_fallback' |
        'verified_context_fallback';
    let plannerAttempts: 0 | 1 | 2 = 0;
    const safety = safetyDialoguePlan(input.message);
    if (explicitQuestionCount > 3) {
        dialoguePlan = dialogueClarification('unrelated_parts');
        dialogueSource = 'safety';
    } else if (safety) {
        dialoguePlan = safety;
        dialogueSource = 'safety';
    } else {
        const planned = await planWithProviders(input, deadlineAtMs, startedAt);
        dialoguePlan = planned.plan;
        plannerAttempts = planned.attempts;
        dialogueSource = planned.source === 'primary'
            ? 'semantic'
            : planned.source === 'verified_context'
                ? 'verified_context_fallback'
                : 'provider_fallback';
    }

    let requestedPlan: SystemQueryPlan;
    try {
        dialoguePlan = contextualizeDialoguePlan(dialoguePlan, input.message, input.state);
        requestedPlan = normalizeDialoguePlan(dialoguePlan, input.message, input.user,
            input.state);
        compileSystemQueryPlan(requestedPlan, input.user);
    } catch (error: unknown) {
        if (!(error instanceof CapabilityValidationError)) throw error;
        if (plannerAttempts === 0) throw error;
        const invalidPlanProvider = plannerAttempts === 1 ? 'gemini' : 'groq';
        logSafe(input.requestId, 'planning_semantics', {
            provider: invalidPlanProvider,
            safeFailureCategory: 'invalid_semantics',
            durationBucket: durationBucket(Date.now() - startedAt),
            fallbackOutcome: plannerAttempts === 1 ? 'repair_started' : 'repair_unavailable',
        });
        if (plannerAttempts === 2) {
            throw new BothProvidersFailedError(
                new ProviderResponseError('gemini', 'generated_output_mismatch'),
                new ProviderResponseError('groq', 'invalid_semantics', error),
            );
        }
        const repaired = await repairDialoguePlan(
            input,
            error.reason,
            deadlineAtMs,
            startedAt,
        );
        if (repaired) {
            try {
                dialoguePlan = contextualizeDialoguePlan(repaired, input.message, input.state);
                requestedPlan = normalizeDialoguePlan(dialoguePlan, input.message, input.user,
                    input.state);
                compileSystemQueryPlan(requestedPlan, input.user);
            } catch (repairError: unknown) {
                if (!(repairError instanceof CapabilityValidationError)) throw repairError;
                throw new BothProvidersFailedError(
                    new ProviderResponseError('gemini', 'invalid_semantics', error),
                    new ProviderResponseError('groq', 'invalid_semantics', repairError),
                );
            }
        } else {
            throw new BothProvidersFailedError(
                new ProviderResponseError('gemini', 'invalid_semantics', error),
                new ProviderRecoverableError('groq', 'timeout'),
            );
        }
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
    const displayPlan = selectDisplayPlan(dialoguePlan.act, sameTurn.parts, results);
    const partWorks = buildPartWork(
        requestedPlan.parts,
        sameTurn.parts,
        results,
        sameTurn.unresolved,
        deniedIds,
        displayPlan,
        dialoguePlan.act,
        input.state,
        input.user,
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
        answerParts.push(normalizeAnswerTypography(answer));
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
    const stateTurn = buildStateTurn(dialoguePlan.act, partWorks, finalCompilation.tools,
        displayPlan);

    logSafe(input.requestId, 'orchestration', {
        domain: requestedPlan.parts.map((part) => part.domain).join(','),
        operation: requestedPlan.parts.map((part) => part.operation).join(','),
        dialogueAct: dialoguePlan.act,
        toolCount: new Set(finalCompilation.tools.map((tool) => tool.name)).size,
        durationBucket: durationBucket(Date.now() - startedAt),
        fallbackOutcome: dialogueSource,
    });

    return {
        responseContexts,
        answerParts,
        presentations,
        displayPlan,
        followUps: buildFollowUps(partWorks),
        partial,
        notices,
        evidenceSource: results.some((result) => result.name !== 'get_system_help')
            ? 'facility'
            : requestedPlan.parts.some((part) =>
                ['own_account', 'assistant_capabilities', 'system_concepts', 'app_help']
                    .includes(part.domain))
                ? 'application'
                : 'none',
        stateTurn,
    };
}

async function planWithProviders(
    input: RunChatTurnInput,
    deadlineAtMs: number,
    startedAt: number,
): Promise<PlannerOutcome> {
    const prompt = JSON.stringify({
        currentManilaDate: manilaDateKey(new Date()),
        callerRole: input.user.role,
        permittedSemanticCapabilities: plannerCapabilitySlice(input.user.role),
        typedConversationContext: safeStateForPlanner(input.state),
        untrustedUserMessage: input.message,
    });
    let firstFailure: unknown;
    try {
        const result = validateDialoguePlan(await geminiProvider.generateStructured<DialoguePlan>({
            systemPrompt: PLANNER_SYSTEM_PROMPT,
            prompt,
            schema: DIALOGUE_PLAN_SCHEMA,
            schemaName: 'dialogue_plan',
            schemaDescription: 'A compact semantic interpretation of an OcuTemp turn.',
            maxOutputTokens: 600,
            timeoutMs: boundedProviderTimeout(PLANNER_PRIMARY_MS, deadlineAtMs,
                PLANNING_RESERVE_MS, 'gemini'),
            reasoningEffort: 'low',
            abortSignal: input.abortSignal,
        }));
        logSafe(input.requestId, 'planning', {
            provider: 'gemini',
            durationBucket: durationBucket(Date.now() - startedAt),
            fallbackOutcome: 'primary_succeeded',
        });
        return { plan: result, attempts: 1, source: 'primary' };
    } catch (error: unknown) {
        if (input.abortSignal?.aborted) throw error;
        firstFailure = normalizePlannerFailure(error, 'gemini');
    }

    const failureCategory = plannerFailureCategory(firstFailure);
    logSafe(input.requestId, 'planning', {
        provider: 'gemini',
        safeFailureCategory: failureCategory,
        durationBucket: durationBucket(Date.now() - startedAt),
        fallbackOutcome: 'fallback_started',
    });
    if (deadlineAtMs - Date.now() < 250 + PLANNING_RESERVE_MS) {
        throw new BothProvidersFailedError(firstFailure,
            new ProviderRecoverableError('groq', 'timeout'));
    }
    const semanticRepair = isSemanticPlannerFailure(firstFailure);
    const fallbackPrompt = semanticRepair ? JSON.stringify({
        currentManilaDate: manilaDateKey(new Date()),
        callerRole: input.user.role,
        permittedSemanticCapabilities: plannerCapabilitySlice(input.user.role),
        typedConversationContext: safeStateForPlanner(input.state),
        untrustedUserMessage: input.message,
        safeValidationCategory: failureCategory,
    }) : prompt;
    try {
        const result = validateDialoguePlan(await groqProvider.generateStructured<DialoguePlan>({
            systemPrompt: semanticRepair ? PLANNER_REPAIR_SYSTEM_PROMPT : PLANNER_SYSTEM_PROMPT,
            prompt: fallbackPrompt,
            schema: DIALOGUE_PLAN_SCHEMA,
            schemaName: semanticRepair ? 'repaired_dialogue_plan' : 'dialogue_plan',
            schemaDescription: 'A compact semantic interpretation of an OcuTemp turn.',
            maxOutputTokens: 600,
            temperature: 0,
            timeoutMs: boundedProviderTimeout(PLANNER_FALLBACK_MS, deadlineAtMs,
                PLANNING_RESERVE_MS, 'groq'),
            reasoningEffort: 'low',
            abortSignal: input.abortSignal,
        }));
        logSafe(input.requestId, 'planning', {
            provider: 'groq',
            safeFailureCategory: failureCategory,
            durationBucket: durationBucket(Date.now() - startedAt),
            fallbackOutcome: semanticRepair ? 'repair_succeeded' : 'fallback_succeeded',
        });
        return { plan: result, attempts: 2, source: 'fallback' };
    } catch (error: unknown) {
        if (input.abortSignal?.aborted) throw error;
        const fallbackFailure = normalizePlannerFailure(error, 'groq');
        const verifiedContextPlan = verifiedContextFallbackPlan(input.message, input.state);
        if (verifiedContextPlan) {
            logSafe(input.requestId, 'planning', {
                provider: 'groq',
                safeFailureCategory: plannerFailureCategory(fallbackFailure),
                durationBucket: durationBucket(Date.now() - startedAt),
                fallbackOutcome: 'verified_context_fallback',
            });
            return { plan: verifiedContextPlan, attempts: 2, source: 'verified_context' };
        }
        logSafe(input.requestId, 'planning', {
            provider: 'groq',
            safeFailureCategory: plannerFailureCategory(fallbackFailure),
            durationBucket: durationBucket(Date.now() - startedAt),
            fallbackOutcome: 'providers_unavailable',
        });
        throw new BothProvidersFailedError(firstFailure, fallbackFailure);
    }
}

function verifiedContextFallbackPlan(
    message: string,
    state: ChatStatePayload | null,
): DialoguePlan | null {
    const normalized = cleanText(message, 2_000).toLocaleLowerCase('en-US');
    if (!isCausalConnectivityFollowUp(normalized)) return null;
    if (!latestUnavailableCurrentReadingReference(state)) return null;
    return {
        act: 'confirm',
        clarificationReason: 'none',
        parts: [dialoguePart({
            domain: 'devices',
            intent: 'count',
            concepts: [
                'online_device_count', 'stale_device_count',
                'offline_device_count', 'unknown_device_status_count',
            ],
            freshness: 'current',
            presentationIntent: 'prose',
            reference: 'previous_request',
        })],
    };
}

async function repairDialoguePlan(
    input: RunChatTurnInput,
    validationCategory: string,
    deadlineAtMs: number,
    startedAt: number,
): Promise<DialoguePlan | null> {
    if (deadlineAtMs - Date.now() < PLANNER_REPAIR_MS + FINALIZATION_RESERVE_MS) return null;
    const prompt = JSON.stringify({
        currentManilaDate: manilaDateKey(new Date()),
        callerRole: input.user.role,
        permittedSemanticCapabilities: plannerCapabilitySlice(input.user.role),
        typedConversationContext: safeStateForPlanner(input.state),
        untrustedUserMessage: input.message,
        safeValidationCategory: cleanText(validationCategory, 80),
    });
    try {
        const result = validateDialoguePlan(await groqProvider.generateStructured<DialoguePlan>({
            systemPrompt: PLANNER_REPAIR_SYSTEM_PROMPT,
            prompt,
            schema: DIALOGUE_PLAN_SCHEMA,
            schemaName: 'repaired_dialogue_plan',
            schemaDescription: 'A repaired compact OcuTemp dialogue interpretation.',
            maxOutputTokens: 600,
            temperature: 0,
            timeoutMs: boundedProviderTimeout(PLANNER_REPAIR_MS, deadlineAtMs,
                FINALIZATION_RESERVE_MS, 'groq'),
            reasoningEffort: 'low',
            abortSignal: input.abortSignal,
        }));
        logSafe(input.requestId, 'planning_repair', {
            provider: 'groq',
            durationBucket: durationBucket(Date.now() - startedAt),
            fallbackOutcome: 'repair_succeeded',
        });
        return result;
    } catch (error: unknown) {
        if (input.abortSignal?.aborted) throw error;
        logSafe(input.requestId, 'planning_repair', {
            provider: 'groq',
            safeFailureCategory: plannerFailureCategory(normalizePlannerFailure(error, 'groq')),
            durationBucket: durationBucket(Date.now() - startedAt),
            fallbackOutcome: 'repair_failed',
        });
        return null;
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
                maxOutputTokens: 600,
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
            safeFailureCategory: providerFailureSummary(error),
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
        const located = latestReferenceableResult(state);
        if (!located || !state) {
            return unresolvedPart(part, unresolved,
                'I do not have a verified previous result for that reference. Please name the rooms or scope.');
        }
        const sourceTurn = state.turns[located.turnIndex]!;
        const sourceContext = sourceTurn.contexts.find((context) =>
            context.partId === located.result.sourcePartId);

        if (referenceKind === 'previous_request') {
            if (!sourceContext || !['facility', 'named_rooms'].includes(
                sourceContext.requestedScope.kind,
            )) {
                return unresolvedPart(part, unresolved,
                    'The previous request does not provide one unambiguous room scope. Please name the rooms.');
            }
            return {
                ...part,
                scope: { ...sourceContext.requestedScope },
                timeRange: part.domain === 'energy'
                    ? { ...sourceContext.timeRange } : part.timeRange,
            };
        }

        const referent = sourceTurn.referents.find((item) =>
            item.sourcePartId === located.result.sourcePartId);
        if (referent?.roomNames.length === 0 && referent.complete &&
            part.followUpReference.ordinal === 0) {
            if (sourceContext && ['facility', 'named_rooms'].includes(
                sourceContext.requestedScope.kind,
            )) {
                return {
                    ...part,
                    scope: { ...sourceContext.requestedScope },
                    timeRange: part.domain === 'energy'
                        ? { ...sourceContext.timeRange }
                        : part.timeRange,
                };
            }
        }
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
            timeRange: part.domain === 'energy' && sourceContext
                ? { ...sourceContext.timeRange }
                : part.timeRange,
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

function safetyDialoguePlan(message: string): DialoguePlan | null {
    const normalized = cleanText(message, 2_000).toLocaleLowerCase('en-US');
    const prohibitedControl = /^(?:please\s+)?(?:turn|set|change|apply|disable|enable)\b.*\b(?:ac|device|override|temperature|auto-apply)\b/u;
    const prohibitedMutation = /^(?:please\s+)?(?:delete|create|remove|approve)\b.*\b(?:room|schedule|staff|user|account|assignment)\b/u;
    if (prohibitedControl.test(normalized) || prohibitedMutation.test(normalized)) {
        return { act: 'deny', clarificationReason: 'none', parts: [dialoguePart({
            domain: 'conversation', intent: 'deny', concepts: ['capabilities'],
        })] };
    }
    return null;
}

interface DialoguePartOptions {
    readonly domain: SystemDomain;
    readonly intent: SystemOperation;
    readonly concepts: SystemField[];
    readonly freshness?: DialoguePart['freshness'];
    readonly presentationIntent?: DialoguePart['presentationIntent'];
    readonly reference?: DialoguePart['reference'];
    readonly helpTopic?: string;
}

function dialoguePart(options: DialoguePartOptions): DialoguePart {
    return {
        domain: options.domain,
        intent: options.intent,
        concepts: options.concepts,
        roomNames: [],
        helpTopic: options.helpTopic ?? '',
        reference: 'none',
        referencePartId: '',
        ordinal: 0,
        freshness: options.freshness ?? 'auto',
        presentationIntent: options.presentationIntent ?? 'prose',
        ...(options.reference ? { reference: options.reference } : {}),
    };
}

function dialogueClarification(
    reason: DialoguePlan['clarificationReason'],
): DialoguePlan {
    return { act: 'clarify', clarificationReason: reason, parts: [dialoguePart({
        domain: 'conversation', intent: 'clarify', concepts: ['capabilities'],
    })] };
}

function clarificationForReason(reason: DialoguePlan['clarificationReason']): string {
    const messages: Record<Exclude<DialoguePlan['clarificationReason'], 'none'>, string> = {
        missing_subject: 'Please rephrase what you would like to know about OcuTemp.',
        missing_room: 'Please name the OcuTemp room you want me to check.',
        missing_period: 'Please specify the energy or event period you want me to use.',
        ambiguous_reference: 'Please name the earlier result or room you mean.',
        unrelated_parts: 'Please ask no more than three related OcuTemp questions at a time.',
    };
    return reason === 'none' ? 'Please rephrase that OcuTemp question.' : messages[reason];
}

function outputPreferenceFor(
    intent: DialoguePart['presentationIntent'],
): SystemQueryPart['outputPreference'] {
    if (intent === 'prose' || intent === 'short_list') return 'text';
    if (intent === 'comparison') return 'table';
    if (intent === 'ranking' || intent === 'trend') return 'graph';
    return 'auto';
}

function explicitPresentationIntent(
    message: string,
): DialoguePart['presentationIntent'] | null {
    const asksForGraph = /\b(graph|chart|visuali[sz]e)\b/u.test(message);
    if (asksForGraph && /\b(line|trend|timeline|over time)\b/u.test(message)) return 'trend';
    if (asksForGraph || /\bbar\s+(?:graph|chart)\b/u.test(message)) return 'ranking';
    if (/\btable\b/u.test(message)) return 'comparison';
    if (/\b(?:full\s+)?report\b/u.test(message)) return 'report';
    return null;
}

function normalizeDialoguePlan(
    dialogue: DialoguePlan,
    message: string,
    user: ChatPrincipal,
    state: ChatStatePayload | null,
): SystemQueryPlan {
    const validated = validateDialoguePlan(dialogue);
    const parts = validated.parts.map((dialogueValue, index) =>
        normalizeDialoguePart(validated, dialogueValue, index, message, user, state));
    return validateSystemQueryPlan({ parts: coalesceFacilityCounts(parts) });
}

function contextualizeDialoguePlan(
    dialogue: DialoguePlan,
    message: string,
    state: ChatStatePayload | null,
): DialoguePlan {
    const validated = validateDialoguePlan(dialogue);
    if (!latestUnavailableCurrentReadingReference(state)) return validated;

    const normalizedMessage = cleanText(message, 2_000).toLocaleLowerCase('en-US');
    const semanticPartIndex = validated.parts.findIndex((partValue) =>
        ['confirm', 'follow_up', 'elaborate'].includes(validated.act) &&
            partValue.reference !== 'none' &&
            (partValue.domain === 'devices' || partValue.concepts.some((concept) => [
                'device_status', 'online_device_count', 'stale_device_count',
                'offline_device_count', 'unknown_device_status_count',
            ].includes(concept))));
    const explicitCausalFollowUp = isCausalConnectivityFollowUp(normalizedMessage);
    if (semanticPartIndex < 0 && !explicitCausalFollowUp) {
        return validated;
    }
    const causalPartIndex = semanticPartIndex >= 0 ? semanticPartIndex : 0;
    const parts = validated.parts.map((partValue, index): DialoguePart => index === causalPartIndex
        ? {
            domain: 'devices', intent: 'count', concepts: [
                'online_device_count', 'stale_device_count',
                'offline_device_count', 'unknown_device_status_count',
            ],
            roomNames: [], helpTopic: '', reference: 'previous_request',
            referencePartId: '', ordinal: 0, freshness: 'current',
            presentationIntent: 'prose',
        }
        : partValue);
    return { act: 'confirm', parts, clarificationReason: 'none' };
}

function normalizeDialoguePart(
    plan: DialoguePlan,
    dialogue: DialoguePart,
    index: number,
    message: string,
    _user: ChatPrincipal,
    state: ChatStatePayload | null,
): SystemQueryPart {
    const partId = `part-${index + 1}` as ChatPartId;
    const act = plan.act;
    if (act === 'clarify') {
        return part({
            domain: 'conversation', operation: 'clarify', fields: ['capabilities'],
            clarification: clarificationForReason(plan.clarificationReason),
        }, partId);
    }

    const normalizedMessage = cleanText(message, 2_000).toLocaleLowerCase('en-US');
    const connectivityQuestion = asksAboutDeviceConnectivity(normalizedMessage);
    const requestedAcPower = requestedRoomAcPower(normalizedMessage);
    const requestedOccupancy = requestedRoomOccupancy(normalizedMessage);
    const energyWinnerQuestion = asksForEnergyWinner(normalizedMessage);
    const latestReference = latestReferenceableResult(state);
    const unavailableCurrentReadingReference =
        latestUnavailableCurrentReadingReference(state);
    const inferredHelpTopic = resolveHelpTopic(dialogue.helpTopic, normalizedMessage);
    const requestsRoomTotal = /\b(how many|number of|total|configured)\b.*\brooms?\b/u
        .test(normalizedMessage);
    const explicitRoomCountPart = dialogue.domain === 'rooms' &&
        dialogue.concepts.includes('room_count') && requestsRoomTotal;
    const repairConnectivityDomain = connectivityQuestion && !explicitRoomCountPart &&
        ['rooms', 'devices', 'conversation', 'unsupported'].includes(dialogue.domain);
    let domain: SystemDomain = repairConnectivityDomain
        ? 'devices' : dialogue.domain;
    let intent: SystemOperation = dialogue.intent;
    let concepts = [...dialogue.concepts];
    let presentationIntent = dialogue.presentationIntent;
    let reference = dialogue.reference;
    let ordinal = dialogue.ordinal;
    const definitionConcept = explicitSystemConcept(normalizedMessage);
    const semanticCausalConnectivityFollowUp = plan.act === 'confirm' &&
        dialogue.domain === 'devices' && dialogue.reference !== 'none' &&
        dialogue.concepts.some((concept) => [
            'device_status', 'online_device_count', 'stale_device_count',
            'offline_device_count', 'unknown_device_status_count',
        ].includes(concept));
    const causalConnectivityFollowUp = unavailableCurrentReadingReference !== null &&
        (semanticCausalConnectivityFollowUp ||
            isCausalConnectivityFollowUp(normalizedMessage));

    if (definitionConcept) {
        domain = 'system_concepts';
        intent = 'explain';
        concepts = [definitionConcept];
        presentationIntent = 'prose';
        reference = 'none';
        ordinal = 0;
    }

    if (causalConnectivityFollowUp) {
        domain = 'devices';
        intent = 'count';
        concepts = [
            'online_device_count', 'stale_device_count',
            'offline_device_count', 'unknown_device_status_count',
        ];
        presentationIntent = 'prose';
        reference = 'previous_request';
        ordinal = 0;
    }

    if (requestedAcPower !== null &&
        ['rooms', 'devices', 'ac_control', 'conversation', 'unsupported'].includes(domain)) {
        domain = 'ac_control';
        intent = 'list';
        concepts = ['room_name', 'ac_power', 'device_status'];
        presentationIntent = 'prose';
    }

    if (requestedOccupancy !== null &&
        ['rooms', 'devices', 'occupancy', 'conversation', 'unsupported'].includes(domain)) {
        domain = 'occupancy';
        intent = 'list';
        concepts = ['room_name', 'occupancy', 'device_status'];
        presentationIntent = 'prose';
    }

    if (inferredHelpTopic && asksForAppHelp(normalizedMessage)) {
        domain = 'app_help';
        intent = 'how_to';
        concepts = ['help_topic'];
        presentationIntent = 'short_list';
        reference = 'none';
        ordinal = 0;
    }

    if (causalConnectivityFollowUp && domain === 'devices') {
        intent = 'count';
        concepts = [
            'online_device_count', 'stale_device_count',
            'offline_device_count', 'unknown_device_status_count',
        ];
        presentationIntent = 'prose';
    } else if (connectivityQuestion && domain === 'devices') {
        const stateCountField = connectivityCountField(normalizedMessage);
        if (requestsRoomTotal) {
            concepts = uniqueFields([...concepts, 'room_count', stateCountField]);
        }
        const combinedCounts = concepts.includes('room_count') &&
            concepts.some((field) => ['online_device_count', 'stale_device_count',
                'offline_device_count'].includes(field));
        if (combinedCounts) {
            intent = 'count';
        } else if (asksForConnectivityList(normalizedMessage)) {
            intent = 'list';
            concepts = ['room_name', 'device_status'];
        } else {
            intent = 'count';
            concepts = [stateCountField];
        }
        presentationIntent = 'prose';
    }
    if (energyWinnerQuestion &&
        (domain === 'energy' || latestReference?.result.subject === 'energy')) {
        domain = 'energy';
        intent = 'compare';
        concepts = uniqueFields([...concepts, 'room_name', 'estimated_kwh', 'energy_rank']);
        presentationIntent = 'prose';
        ordinal = 1;
        if (reference === 'none' && latestReference?.result.subject === 'energy' &&
            !mentionsExplicitEnergyPeriod(normalizedMessage)) {
            reference = 'previous_request';
        }
    }
    const explicitPresentation = explicitPresentationIntent(normalizedMessage);
    if (explicitPresentation) {
        presentationIntent = explicitPresentation;
        if (domain === 'energy' && explicitPresentation === 'ranking') {
            intent = 'compare';
            concepts = uniqueFields([...concepts, 'room_name', 'estimated_kwh', 'energy_rank']);
        }
        if (domain === 'energy' && explicitPresentation === 'trend') {
            concepts = uniqueFields([...concepts, 'estimated_kwh', 'energy_trend']);
        }
    }

    const capability = CAPABILITY_REGISTRY.find((candidate) =>
        candidate.domain === domain);
    if (!capability) throw new CapabilityValidationError('unknown_dialogue_domain');
    const operation = capability.operations.includes(intent)
        ? intent
        : defaultOperationFor(domain, act, capability.operations);
    const freshness = requestsCurrentRefresh(normalizedMessage) &&
        liveDataDomain(domain)
        ? 'current'
        : dialogue.freshness;
    let fields = concepts.filter((field) => capability.fields.includes(field));
    fields = applyFreshnessToFields(domain, freshness, fields);
    const mandatoryCountFields: Partial<Record<SystemDomain, SystemField>> = {
        rooms: 'room_count', devices: 'device_count', schedules: 'schedule_count',
    };
    if (operation === 'count' && mandatoryCountFields[domain] &&
        !fields.some((field) => field.endsWith('_count'))) {
        fields = [mandatoryCountFields[domain]!, ...fields];
    }
    if (fields.length === 0) fields = defaultFieldsFor(domain, operation);
    fields = uniqueFields(fields.filter((field) => capability.fields.includes(field))).slice(0, 8);
    if (fields.length === 0) throw new CapabilityValidationError('no_permitted_dialogue_fields');

    const roomNames = uniqueStrings(dialogue.roomNames
        .map((name) => cleanText(name, 100))).slice(0, 50);
    reference = freshness === 'current' &&
        reference === 'previous_result'
        ? 'previous_request'
        : reference;
    if (roomNames.length > 0) reference = 'none';
    const inventory: SystemQueryPart['scope']['inventory'] =
        requestedAcPower !== null || requestedOccupancy !== null ||
            configuredDomain(domain) || operation === 'count'
            ? 'all' : 'active';
    const scopeValue: SystemQueryPart['scope'] = roomNames.length > 0
        ? scope('named_rooms', roomNames, inventory)
        : reference === 'prior_part'
            ? { kind: 'prior_part', roomNames: [], inventory,
                referencePartId: dialogue.referencePartId }
            : reference === 'previous_request' || reference === 'previous_result'
                ? scope(reference, [], inventory)
                : domain === 'own_account'
                    ? scope('own_account', [], 'all')
                    : scope('facility', [], inventory);
    const filters: SystemFilter[] = [];
    const connectivityState = requestedConnectivityState(normalizedMessage);
    if (connectivityQuestion && domain === 'devices' &&
        asksForConnectivityList(normalizedMessage) && connectivityState) {
        filters.push(stringFilter('device_status', connectivityState));
    }
    if (requestedAcPower !== null && domain === 'ac_control') {
        filters.push(booleanFilter('ac_power', requestedAcPower));
    }
    if (requestedOccupancy !== null && domain === 'occupancy') {
        filters.push(booleanFilter('occupancy', requestedOccupancy));
    }
    let clarification = '';
    if (domain === 'app_help') {
        const topic = inferredHelpTopic;
        if (topic) filters.push(stringFilter('help_topic', topic));
        else clarification = clarification ||
            'Please name the OcuTemp feature you want step-by-step help with.';
    }
    const ranking = domain === 'energy' &&
        (operation === 'compare' || fields.includes('energy_rank'));
    if (ranking && !fields.includes('estimated_kwh')) {
        fields = uniqueFields([...fields, 'estimated_kwh']).slice(0, 8);
    }
    const singleRank = ranking && (ordinal > 0 || energyWinnerQuestion ||
        /\b(first|top(?:-ranked)?|rank(?:ed)? one|number one)\b/u.test(normalizedMessage));
    const followReference: SystemQueryPart['followUpReference'] = {
        kind: reference,
        partId: reference === 'prior_part' ? dialogue.referencePartId : '',
        ordinal,
    };
    return part({
        domain,
        operation,
        fields,
        filters,
        scope: scopeValue,
        timeRange: domain === 'energy' || domain === 'decision_events'
            ? energyRangeFor(normalizedMessage)
            : defaultTimeRange(),
        sort: ranking
            ? { field: 'estimated_kwh', direction: 'desc' }
            : { field: fields[0]!, direction: 'none' },
        outputPreference: outputPreferenceFor(presentationIntent),
        followUpReference: followReference,
        limit: singleRank ? 1 : operation === 'report' ? 50 : 25,
        clarification,
    }, partId);
}

function defaultOperationFor(
    domain: SystemDomain,
    act: ChatDialogueAct,
    allowed: readonly SystemOperation[],
): SystemOperation {
    const preferred: Partial<Record<SystemDomain, SystemOperation>> = {
        rooms: 'status', devices: 'status', measurements: 'detail', occupancy: 'status',
        ac_control: 'status', overrides: 'status', ai_auto_apply: 'status', schedules: 'list',
        energy: 'summarize', climate_suggestions: 'list', decision_events: 'list',
        floor_plan: 'status', own_account: 'detail', admin_user_aggregates: 'count',
        app_help: 'how_to', assistant_capabilities: 'list', unsupported: 'clarify',
        system_concepts: 'explain',
        conversation: act === 'greet' ? 'greet' : act === 'deny' ? 'deny' : 'clarify',
    };
    const operation = preferred[domain];
    return operation && allowed.includes(operation) ? operation : allowed[0]!;
}

function defaultFieldsFor(domain: SystemDomain, operation: SystemOperation): SystemField[] {
    const countFields: Partial<Record<SystemDomain, SystemField[]>> = {
        rooms: ['room_count'], devices: ['device_count'], schedules: ['schedule_count'],
        admin_user_aggregates: ['user_total'], floor_plan: ['floor_plan_assignment'],
    };
    if (operation === 'count' && countFields[domain]) return countFields[domain]!;
    const fields: Record<SystemDomain, SystemField[]> = {
        rooms: ['room_name', 'room_status', 'device_assignment'],
        devices: ['room_name', 'device_status', 'last_seen'],
        measurements: ['room_name', 'temperature', 'device_status'],
        occupancy: ['room_name', 'occupancy', 'device_status'],
        ac_control: ['room_name', 'ac_power', 'device_status'],
        overrides: ['room_name', 'override_active', 'override_target_temperature',
            'override_until'],
        ai_auto_apply: ['room_name', 'ai_auto_apply'],
        schedules: ['room_name', 'schedules'],
        energy: ['estimated_kwh', 'runtime_seconds', 'session_count'],
        climate_suggestions: ['room_name', 'climate_suggestion'],
        decision_events: ['room_name', 'decision_event'],
        floor_plan: ['room_name', 'floor_plan_assignment'],
        own_account: ['account_role', 'account_approval'],
        admin_user_aggregates: ['user_total'],
        app_help: ['help_topic'],
        assistant_capabilities: ['capabilities'],
        system_concepts: ['capabilities'],
        conversation: ['capabilities'],
        unsupported: ['capabilities'],
    };
    return fields[domain];
}

function applyFreshnessToFields(
    domain: SystemDomain,
    freshness: DialoguePart['freshness'],
    fields: readonly SystemField[],
): SystemField[] {
    const lastKnown = freshness === 'last_known' || freshness === 'historical';
    if (!lastKnown) return [...fields];
    return fields.map((field): SystemField => {
        if (domain === 'measurements' && field === 'temperature') return 'last_known_temperature';
        if (domain === 'measurements' && field === 'humidity') return 'last_known_humidity';
        if (domain === 'occupancy' && field === 'occupancy') return 'last_known_occupancy';
        if (domain === 'ac_control' && field === 'ac_power') return 'last_known_ac_power';
        return field;
    });
}

function configuredDomain(domain: SystemDomain): boolean {
    return ['rooms', 'devices', 'overrides', 'ai_auto_apply', 'schedules', 'floor_plan']
        .includes(domain);
}

function liveDataDomain(domain: SystemDomain): boolean {
    return ['devices', 'measurements', 'occupancy', 'ac_control'].includes(domain);
}

function requestsCurrentRefresh(message: string): boolean {
    return /\b(now|currently|right now|rn|at the moment)\b/u.test(message);
}

function asksAboutDeviceConnectivity(message: string): boolean {
    return requestedConnectivityState(message) !== null;
}

function requestedConnectivityState(message: string): 'online' | 'stale' | 'offline' | null {
    if (/\b(online|connected|live device|live unit)\b/u.test(message)) return 'online';
    if (/\b(stale)\b/u.test(message)) return 'stale';
    if (/\b(offline|disconnected|down)\b/u.test(message)) return 'offline';
    return null;
}

function requestedRoomAcPower(message: string): boolean | null {
    if (/\boverrides?\b/u.test(message)) return null;
    const roomContext = /\brooms?\b/u.test(message);
    if ((roomContext && /\b(active|running)\b/u.test(message)) ||
        /\b(?:ac|air\s*condition(?:er|ing)?)\b.*\b(on|running)\b/u.test(message)) {
        return true;
    }
    if ((roomContext && /\bidle\b/u.test(message)) ||
        /\b(?:ac|air\s*condition(?:er|ing)?)\b.*\boff\b/u.test(message)) {
        return false;
    }
    return null;
}

function requestedRoomOccupancy(message: string): boolean | null {
    const roomContext = /\brooms?\b/u.test(message);
    const asksReadingAvailability = /\boccupancy\s+(?:reading|readings|data)\b.*\bavailable\b/u
        .test(message) || /\bavailable\b.*\boccupancy\s+(?:reading|readings|data)\b/u
        .test(message);
    if (asksReadingAvailability) return null;
    const occupied = roomContext && /\boccupied\b/u.test(message);
    const available = roomContext && /\b(available|unoccupied|vacant|free)\b/u.test(message);
    if (occupied === available) return null;
    return occupied;
}

function asksForConnectivityList(message: string): boolean {
    return /\b(which|list|show|name|what)\b.*\b(rooms?|devices?|units?)\b/u.test(message) ||
        /\b(rooms?|devices?|units?)\b.*\b(which|list|show|name)\b/u.test(message);
}

function asksForAppHelp(message: string): boolean {
    return /\b(where|how\s+to|how\s+(?:do|can)\s+i|steps?|guide|help)\b/u.test(message);
}

function isCausalConnectivityFollowUp(message: string): boolean {
    return /\b(?:is|was|could)\s+(?:it|that|this)\b.*\b(?:because|beacause|cause|due\s+to)\b.*\b(?:off?line|disconnected|not\s+online)\b/u
        .test(message);
}

function hasUnavailableCurrentReadingReference(located: LocatedStateResult): boolean {
    const liveDomains: readonly SystemDomain[] = [
        'devices', 'measurements', 'occupancy', 'ac_control',
    ];
    return liveDomains.includes(located.result.subject) &&
        (located.context?.answerability === 'no_online_reading' ||
            located.result.emptyReason === 'no_online_reading');
}

function unavailableSubjectLabel(subject: SystemDomain): string {
    if (subject === 'ac_control') return 'current AC power-state result';
    if (subject === 'occupancy') return 'current occupancy result';
    if (subject === 'measurements') return 'current room-measurement result';
    return 'current device-reading result';
}

function explicitSystemConcept(message: string): SystemField | null {
    const asksForDefinition = /\b(?:what\s+(?:is|does)|what\s+is\s+.+\s+for|explain|meaning)\b/u
        .test(message);
    if (!asksForDefinition) return null;
    if (/\b(?:ai\s+auto(?:matic)?(?:[\s-]*apply)?(?:\s+button)?|auto[\s-]*apply)\b/u
        .test(message)) return 'ai_auto_apply';
    return null;
}

function connectivityCountField(message: string): SystemField {
    const state = requestedConnectivityState(message);
    if (state === 'offline') return 'offline_device_count';
    if (state === 'stale') return 'stale_device_count';
    return 'online_device_count';
}

function asksForEnergyWinner(message: string): boolean {
    return /\b(rank(?:ed)? first|first place|number one|top(?:-ranked)?|highest|most|greatest|largest)\b/u
        .test(message) && /\b(energy|usage|consumer|consumption|kwh|rank)\b/u.test(message);
}

function mentionsExplicitEnergyPeriod(message: string): boolean {
    return /\b(today|this week|last week|last 7 days?|this month|last month|last 12 months?|past year|this year|whole year|current year|yearly|annual)\b/u
        .test(message) || /\b\d{4}-\d{2}-\d{2}\b/u.test(message);
}

function uniqueFields(fields: readonly SystemField[]): SystemField[] {
    return [...new Set(fields)];
}

function coalesceFacilityCounts(parts: readonly SystemQueryPart[]): SystemQueryPart[] {
    if (parts.length !== 2 || !parts.every((item) => item.operation === 'count' &&
        (item.domain === 'rooms' || item.domain === 'devices') &&
        item.filters.length === 0 && item.followUpReference.kind === 'none') ||
        queryScopeSignature(parts[0]!) !== queryScopeSignature(parts[1]!) ||
        queryRangeSignature(parts[0]!) !== queryRangeSignature(parts[1]!)) {
        return [...parts];
    }
    const deviceCapability = CAPABILITY_REGISTRY.find((item) => item.domain === 'devices');
    const fields = uniqueFields(parts.flatMap((item) => item.fields));
    if (!deviceCapability || fields.some((field) => !deviceCapability.fields.includes(field))) {
        return [...parts];
    }
    const first = parts[0]!;
    return [{
        ...first,
        partId: 'part-1',
        domain: 'devices',
        fields,
        sort: { field: fields[0]!, direction: 'none' },
        outputPreference: 'text',
        limit: Math.max(first.limit, parts[1]!.limit),
    }];
}

function queryScopeSignature(partValue: SystemQueryPart): string {
    return JSON.stringify({
        kind: partValue.scope.kind,
        inventory: partValue.scope.inventory,
        roomNames: partValue.scope.roomNames.map((name) =>
            name.toLocaleLowerCase('en-US')),
    });
}

function queryRangeSignature(partValue: SystemQueryPart): string {
    return JSON.stringify(partValue.timeRange);
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

function stringFilter(field: SystemField, value: string): SystemFilter {
    return { field, operator: 'eq', valueType: 'string', stringValue: value,
        numberValue: 0, booleanValue: false, stringValues: [] };
}

function booleanFilter(field: SystemField, value: boolean): SystemFilter {
    return { field, operator: 'eq', valueType: 'boolean', stringValue: '',
        numberValue: 0, booleanValue: value, stringValues: [] };
}

function buildPartWork(
    requestedParts: readonly SystemQueryPart[],
    executableParts: readonly SystemQueryPart[],
    results: readonly ToolExecutionResult[],
    unresolved: ReadonlyMap<ChatPartId, string>,
    deniedIds: ReadonlySet<ChatPartId>,
    displayPlan: readonly ChatDisplayDirective[],
    dialogueAct: ChatDialogueAct,
    state: ChatStatePayload | null,
    user: ChatPrincipal,
): PartWork[] {
    return requestedParts.map((requested, index): PartWork => {
        const executable = executableParts[index]!;
        const partResults = results.filter((result) => result.partId === requested.partId);
        const answerability = deniedIds.has(requested.partId) ? 'permission_denied'
            : unresolved.has(requested.partId) || executable.needsClarification
                ? 'clarification_required'
                : determineAnswerability(requested, partResults);
        const facts = augmentGroundingFacts(requested, partResults,
            partResults.flatMap((result) => result.facts)
                .filter((fact) => fact.partId === requested.partId), user,
            dialogueAct, answerability);
        const scopeResolution = mergeScopes(partResults.map((result) => result.scope));
        const range = partResults.map((result) => result.presentation)
            .find((presentation): presentation is EnergyReportPresentation =>
                presentation.kind === 'energy-report')?.range ?? null;
        const causalOrigin = dialogueAct === 'confirm' && requested.domain === 'devices' &&
            requested.fields.includes('online_device_count')
            ? latestUnavailableCurrentReadingReference(state) : null;
        const previousResult = causalOrigin?.result ??
            previousResultFor(state, requested.domain, dialogueAct);
        facts.push(...causalFollowUpFacts(
            requested, partResults, causalOrigin, dialogueAct,
        ));
        const recommendations = buildRecommendations(requested, partResults);
        const packet: AnswerPacket = {
            partId: requested.partId,
            dialogueAct,
            responseGoal: responseGoalFor(
                dialogueAct, requested, answerability, causalOrigin !== null,
            ),
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
            previousResult,
        };
        return { requested, executable, results: partResults, answerability, packet };
    });
}

function augmentGroundingFacts(
    part: SystemQueryPart,
    results: readonly ToolExecutionResult[],
    rawFacts: readonly GroundingFact[],
    user: ChatPrincipal,
    dialogueAct: ChatDialogueAct,
    answerability: ChatAnswerabilityOutcome,
): GroundingFact[] {
    const facts = [...rawFacts];
    for (const result of results) {
        const presentation = result.presentation;
        if (presentation.kind === 'room-data') {
            const filteredResult = part.filters.length > 0;
            facts.push({
                id: `server.${part.partId}.room_count`,
                partId: part.partId,
                statement: filteredResult
                    ? `The verified result contains ${presentation.rooms.length} matching ${presentation.rooms.length === 1 ? 'room row' : 'room rows'} after applying the requested current-state filter; this is not the configured room count.`
                    : `The verified result contains ${presentation.rooms.length} configured ${presentation.rooms.length === 1 ? 'room' : 'rooms'}.`,
            });
            if (presentation.rooms.length > 0) {
                facts.push({
                    id: `server.${part.partId}.room_names`,
                    partId: part.partId,
                    statement: `The matching configured room names are: ${presentation.rooms.map((room) => room.roomName).join('; ')}.`,
                });
            }
            const requestedPower = requestedAcPowerFilter(part);
            if (presentation.rooms.length === 0 && requestedPower !== null &&
                answerability !== 'no_online_reading') {
                facts.push({
                    id: `server.${part.partId}.ac_power_match`,
                    partId: part.partId,
                    statement: requestedPower
                        ? 'No configured room with a current online reading has its AC power on.'
                        : 'No configured room with a current online reading has its AC power off.',
                });
            }
            if (presentation.rooms.length === 0 && requestedPower !== null &&
                answerability === 'no_online_reading' && result.scope.activeRoomNames.length > 0) {
                facts.push({
                    id: `server.${part.partId}.configured_room_context`,
                    partId: part.partId,
                    statement: `OcuTemp still has ${result.scope.activeRoomNames.length} configured ${result.scope.activeRoomNames.length === 1 ? 'room record' : 'room records'} eligible for operation; unavailable current readings do not prove that their AC units are off.`,
                });
            }
            const requestedOccupancyValue = requestedOccupancyFilter(part);
            if (presentation.rooms.length === 0 && requestedOccupancyValue !== null &&
                answerability !== 'no_online_reading') {
                facts.push({
                    id: `server.${part.partId}.occupancy_match`,
                    partId: part.partId,
                    statement: requestedOccupancyValue
                        ? 'No configured room with a current online reading is occupied.'
                        : 'No configured room with a current online reading is available or unoccupied.',
                });
            }
            const statuses = presentation.rooms.flatMap((room) => room.values)
                .filter((value) => value.field === 'device_status' &&
                    typeof value.value === 'string');
            if (statuses.length > 0) {
                const online = statuses.filter((value) => value.value === 'online').length;
                const stale = statuses.filter((value) => value.value === 'stale').length;
                const offline = statuses.filter((value) => value.value === 'offline').length;
                const unknown = statuses.length - online - stale - offline;
                facts.push({
                    id: `server.${part.partId}.device_status_counts`,
                    partId: part.partId,
                    statement: `Of ${statuses.length} rooms with reported device status, ${online} are online, ${stale} are stale, ${offline} are offline, and ${unknown} are unknown.`,
                });
            }
        }
        if (presentation.kind === 'schedule-data') {
            facts.push({
                id: `server.${part.partId}.schedule_count`,
                partId: part.partId,
                statement: `The verified result contains ${presentation.schedules.length} configured ${presentation.schedules.length === 1 ? 'schedule' : 'schedules'}.`,
            });
        }
    }
    if (['measurements', 'occupancy', 'ac_control', 'devices'].includes(part.domain)) {
        facts.push({
            id: `server.${part.partId}.configured_capabilities`,
            partId: part.partId,
            statement: 'OcuGuide can read stored OcuTemp schedules and AI auto-apply configuration while devices are offline, but current temperature and occupancy require an online device.',
        });
    }
    if (part.domain === 'assistant_capabilities') {
        const domains = uniqueStrings(capabilitiesForRole(user.role)
            .map((capability) => domainLabel(capability.domain))
            .filter((label) => !['Conversation', 'Unsupported'].includes(label)));
        facts.push({
            id: `server.${part.partId}.role_capabilities`,
            partId: part.partId,
            statement: `The caller's OcuTemp role permits read-only OcuGuide questions about: ${domains.join('; ')}.`,
        });
    }
    if (part.domain === 'system_concepts') {
        facts.push(...trustedSystemConceptFacts(part.partId, part.fields));
    }
    if (part.domain === 'conversation' && part.operation === 'greet') {
        facts.push({
            id: `server.${part.partId}.greeting_capability`,
            partId: part.partId,
            statement: 'OcuGuide is available to answer read-only questions about OcuTemp system data permitted for the signed-in caller.',
        });
    }
    if (part.domain === 'conversation' && part.operation === 'clarify' &&
        part.clarification) {
        facts.push({
            id: `server.${part.partId}.required_clarification`,
            partId: part.partId,
            statement: `Required clarification: ${part.clarification}`,
        });
    }
    if (dialogueAct === 'correct') {
        facts.push({
            id: `server.${part.partId}.new_request_boundary`,
            partId: part.partId,
            statement: 'The current turn corrects the earlier interpretation and starts a new conversation boundary; it must not be treated as a data follow-up.',
        });
    }
    if (answerability === 'permission_denied') {
        facts.push({
            id: `server.${part.partId}.role_denial`,
            partId: part.partId,
            statement: `The caller's ${user.role} role is not permitted to access the requested OcuTemp information.`,
        });
    }
    if (part.domain === 'unsupported') {
        facts.push({
            id: `server.${part.partId}.unsupported_scope`,
            partId: part.partId,
            statement: 'The request is outside OcuGuide\'s read-only OcuTemp system scope.',
        });
    }
    return deduplicateFacts(facts);
}

function deduplicateFacts(facts: readonly GroundingFact[]): GroundingFact[] {
    const seen = new Set<string>();
    return facts.filter((fact) => {
        if (seen.has(fact.id)) return false;
        seen.add(fact.id);
        return true;
    });
}

function previousResultFor(
    state: ChatStatePayload | null,
    domain: SystemDomain,
    act: ChatDialogueAct,
): ChatStateResultMemory | null {
    const located = latestReferenceableResult(state);
    if (!located) return null;
    if (located.result.subject === domain) return located.result;
    return ['confirm', 'correct', 'follow_up', 'elaborate'].includes(act)
        ? located.result : null;
}

function causalFollowUpFacts(
    part: SystemQueryPart,
    results: readonly ToolExecutionResult[],
    causalOrigin: LocatedStateResult | null,
    act: ChatDialogueAct,
): GroundingFact[] {
    if (act !== 'confirm' || part.domain !== 'devices' ||
        !part.fields.includes('online_device_count') ||
        causalOrigin === null) return [];
    const onlineCount = results.flatMap((result) => {
        const presentation = result.presentation;
        return presentation.kind === 'metric-summary'
            ? presentation.metrics.filter((metric) =>
                metric.field === 'online_device_count' &&
                typeof metric.value === 'number').map((metric) => metric.value as number)
            : [];
    })[0];
    if (onlineCount === undefined) return [];
    return [{
        id: `server.${part.partId}.causal_connectivity`,
        partId: part.partId,
        statement: onlineCount === 0
            ? `The previous ${unavailableSubjectLabel(causalOrigin.result.subject)} was unavailable because the refreshed OcuTemp scope still has zero online devices. This is the immediate data-availability reason; the verified data does not explain why device connectivity was lost.`
            : `The previous unavailable ${unavailableSubjectLabel(causalOrigin.result.subject)} result is no longer supported by a zero-online-device state because the refreshed OcuTemp scope now has ${onlineCount} online ${onlineCount === 1 ? 'device' : 'devices'}.`,
    }];
}

function responseGoalFor(
    act: ChatDialogueAct,
    part: SystemQueryPart,
    answerability: ChatAnswerabilityOutcome,
    previousHadNoOnlineReading: boolean,
): string {
    if (answerability === 'clarification_required') {
        return 'Explain what was understood and ask for only the missing detail.';
    }
    if (act === 'confirm' && answerability === 'no_online_reading' &&
        part.domain === 'ac_control') {
        return 'Correct the inference directly: unavailable current online readings mean AC activity is unknown, not that zero rooms have their AC on.';
    }
    if (act === 'confirm' && part.domain === 'devices' &&
        part.fields.includes('online_device_count') &&
        previousHadNoOnlineReading) {
        return 'Connect the causal follow-up explicitly: begin with yes or no, explain whether the refreshed online-device count is the immediate reason the previous current reading was unavailable, and preserve the original requested subject. Distinguish that data-availability reason from the unknown reason connectivity was lost.';
    }
    if (act === 'confirm') return 'Confirm or correct the user directly, then explain the verified distinction.';
    if (act === 'correct') return 'Acknowledge the correction and treat the next self-contained question as a new request, not a follow-up.';
    if (act === 'acknowledge') return 'Acknowledge the user naturally and briefly.';
    if (act === 'greet') return 'Respond with a natural brief greeting and invite an OcuTemp question.';
    if (act === 'elaborate') return 'Explain the previous verified result in plain language.';
    if (part.outputPreference === 'graph') {
        return 'Introduce the requested graph and explain one useful verified comparison, pattern, or coverage limitation. Do not merely restate the total or chart title.';
    }
    if (act === 'follow_up') return 'Answer the follow-up directly without repeating the prior report or visual.';
    if (part.operation === 'count') return 'State the verified count directly in a natural sentence.';
    if (part.operation === 'list') {
        return 'State what the verified list contains, then explain one useful pattern or scope detail supported by the facts before the structured items.';
    }
    return 'Answer the OcuTemp question directly and naturally from the verified facts.';
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
        const requestedPower = requestedAcPowerFilter(work.requested);
        if (work.packet.dialogueAct === 'confirm' && requestedPower !== null) {
            return base('Not exactly—there are no current online device readings, so OcuTemp cannot determine which rooms have their AC on right now. That does not prove that no room is active.');
        }
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
        if (work.packet.dialogueAct === 'acknowledge') {
            return base('You\'re welcome. Ask me whenever you want to check something in OcuTemp.');
        }
        if (work.packet.dialogueAct === 'correct') {
            return base('Understoodâ€”I will treat your next question as a new request, not a follow-up.');
        }
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
    if (work.requested.domain === 'system_concepts') {
        const definitions = trustedSystemConceptFacts(work.requested.partId,
            work.requested.fields).map((fact) => fact.statement);
        return base(definitions.join(' ') ||
            'I do not have a verified OcuTemp definition for that concept yet.');
    }
    if (work.requested.domain === 'own_account') return ownAccountAnswer(work, user);

    const presentation = work.results[0]?.presentation;
    if (!presentation) return base('There is not enough verified OcuTemp data to answer that question.');
    if (work.requested.domain === 'devices' && presentation.kind === 'room-data') {
        const connectivity = connectivityFallbackAnswer(work, presentation, caveats);
        if (connectivity) return connectivity;
    }
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

function connectivityFallbackAnswer(
    work: PartWork,
    presentation: RoomDataPresentation,
    caveats: string[],
): ChatAnswerPart | null {
    if (work.requested.operation === 'list') return null;
    const statuses = presentation.rooms.flatMap((room) => room.values)
        .filter((value) => value.field === 'device_status' && typeof value.value === 'string');
    if (statuses.length === 0) return null;
    const online = statuses.filter((value) => value.value === 'online').length;
    const stale = statuses.filter((value) => value.value === 'stale').length;
    const offline = statuses.filter((value) => value.value === 'offline').length;
    const unknown = statuses.length - online - stale - offline;
    const configured = presentation.rooms.length;
    let text: string;
    if (work.packet.dialogueAct === 'confirm') {
        text = online === 0
            ? `Correct—OcuTemp has ${configured} configured ${configured === 1 ? 'room' : 'rooms'} in this scope, but none of their devices are online right now.`
            : `Not quite—${online} of ${configured} configured ${configured === 1 ? 'room has an' : 'rooms have'} online device right now.`;
    } else {
        text = `${online} of ${configured} configured ${configured === 1 ? 'room has an' : 'rooms have'} online device right now.`;
    }
    const unavailableStates = [
        stale > 0 ? `${stale} ${stale === 1 ? 'device is' : 'devices are'} stale` : '',
        offline > 0 ? `${offline} ${offline === 1 ? 'device is' : 'devices are'} offline` : '',
        unknown > 0 ? `${unknown} ${unknown === 1 ? 'device status is' : 'device statuses are'} unknown` : '',
    ].filter(Boolean);
    if (unavailableStates.length > 0) text += ` ${unavailableStates.join(' and ')}.`;
    if (online === 0) {
        text += ' Stored schedules and AI auto-apply configuration remain available, but current temperature and occupancy do not.';
    }
    return answer(work.requested.partId, text, [], caveats);
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
    const onlineMetric = metrics.find((metric) => metric.field === 'online_device_count');
    if (work.packet.dialogueAct === 'confirm' &&
        typeof onlineMetric?.value === 'number') {
        if (onlineMetric.value === 0) {
            const subject = work.packet.previousResult?.subject;
            if (subject === 'ac_control') {
                return answer(work.requested.partId,
                    'Yes. Because no assigned devices in that scope are online, OcuTemp cannot determine which rooms currently have their AC on. This does not mean the AC units are off; their current power states are unavailable.',
                    [], caveats);
            }
            if (subject === 'occupancy') {
                return answer(work.requested.partId,
                    'Yes. Because no assigned devices in that scope are online, OcuTemp cannot determine current room occupancy. This does not mean the rooms are unoccupied; their current occupancy readings are unavailable.',
                    [], caveats);
            }
            if (subject === 'measurements') {
                return answer(work.requested.partId,
                    'Yes. Because no assigned devices in that scope are online, OcuTemp cannot provide the requested current room measurements. Last-known values are historical and do not establish current conditions.',
                    [], caveats);
            }
            return answer(work.requested.partId,
                'Yes. Because no assigned devices in that scope are online, the requested current device readings are unavailable. The verified data does not identify why connectivity was lost.',
                [], caveats);
        }
        return answer(work.requested.partId,
            `Not currently. The refreshed OcuTemp status shows ${formatNumber(onlineMetric.value)} online ${onlineMetric.value === 1 ? 'device' : 'devices'}, so the earlier no-online result is no longer current.`,
            [], caveats);
    }
    if (metrics.length === 1) {
        const metric = metrics[0]!;
        const metricValue = metric.value;
        if (typeof metricValue !== 'number') {
            const text = `${metric.label}: ${formatProjectedValue(metric)}`;
            return answer(work.requested.partId, text, [], caveats);
        }
        if (metric.field === 'room_count') {
            return answer(work.requested.partId,
                `OcuTemp has ${formatNumber(metricValue)} configured ${metricValue === 1 ? 'room' : 'rooms'} in this scope.`, [], caveats);
        }
        if (metric.field === 'device_count') {
            return answer(work.requested.partId,
                `OcuTemp has ${formatNumber(metricValue)} configured ${metricValue === 1 ? 'device' : 'devices'} in this scope.`, [], caveats);
        }
        if (metric.field === 'schedule_count') {
            return answer(work.requested.partId,
                `There ${metricValue === 1 ? 'is' : 'are'} ${formatNumber(metricValue)} valid configured ${metricValue === 1 ? 'schedule' : 'schedules'} in this scope.`, [], caveats);
        }
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
        const requestedPower = requestedAcPowerFilter(work.requested);
        if (requestedPower !== null) {
            return answer(work.requested.partId, requestedPower
                ? 'No room with a current online reading has its AC on right now.'
                : 'No room with a current online reading has its AC off right now.', [], caveats);
        }
        const requestedOccupancyValue = requestedOccupancyFilter(work.requested);
        if (requestedOccupancyValue !== null) {
            return answer(work.requested.partId, requestedOccupancyValue
                ? 'No room with a current online reading is occupied right now.'
                : 'No room with a current online reading is available right now.', [], caveats);
        }
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

function requestedAcPowerFilter(partValue: SystemQueryPart): boolean | null {
    const filter = partValue.filters.find((item) => item.field === 'ac_power' &&
        item.operator === 'eq' && item.valueType === 'boolean');
    return filter?.booleanValue ?? null;
}

function requestedOccupancyFilter(partValue: SystemQueryPart): boolean | null {
    const filter = partValue.filters.find((item) => item.field === 'occupancy' &&
        item.operator === 'eq' && item.valueType === 'boolean');
    return filter?.booleanValue ?? null;
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
    const schedulesByRoom = new Map<string, number>();
    for (const schedule of presentation.schedules) {
        schedulesByRoom.set(schedule.roomName,
            (schedulesByRoom.get(schedule.roomName) ?? 0) + 1);
    }
    const roomCounts = [...schedulesByRoom.entries()];
    const highestCount = Math.max(...roomCounts.map(([, count]) => count));
    const lowestCount = Math.min(...roomCounts.map(([, count]) => count));
    const busiestRooms = roomCounts.filter(([, count]) => count === highestCount)
        .map(([roomName]) => roomName);
    const context = roomCounts.length === 1
        ? ` All of them belong to ${roomCounts[0]![0]}.`
        : highestCount === lowestCount
            ? ` Each of the ${roomCounts.length} rooms has ${highestCount} ${highestCount === 1 ? 'schedule' : 'schedules'}.`
            : ` ${formatNames(busiestRooms)} ${busiestRooms.length === 1 ? 'has' : 'have'} the most, with ${highestCount} schedules.`;
    return answer(work.requested.partId,
        `${presentation.schedules.length} configured ${presentation.schedules.length === 1 ? 'schedule is' : 'schedules are'} available across ${roomCounts.length} ${roomCounts.length === 1 ? 'room' : 'rooms'}.${context}`,
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
    if (work.requested.outputPreference === 'graph') {
        const ranked = [...recorded].sort((left, right) =>
            (left.rank ?? 999) - (right.rank ?? 999));
        const firstRank = ranked[0]?.rank;
        const leaders = ranked.filter((room) => room.rank === firstRank);
        const leadingValue = leaders[0]?.estimatedKwh;
        const comparison = leadingValue === null || leadingValue === undefined
            ? ''
            : ` ${formatNames(leaders.map((room) => room.roomName))} ${leaders.length === 1 ? 'has' : 'tie for'} the highest recorded estimate at ${formatNumber(leadingValue)} kWh.`;
        return answer(work.requested.partId,
            `The graph compares ${recorded.length} rooms with recorded estimated energy for ${presentation.range.label}.${comparison} Their combined recorded estimate is ${formatNumber(presentation.metrics.totalKwh)} kWh.`,
            [], caveats);
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
    dialogueAct: ChatDialogueAct,
    parts: readonly SystemQueryPart[],
    results: readonly ToolExecutionResult[],
): ChatDisplayDirective[] {
    if (['confirm', 'correct', 'elaborate', 'clarify', 'greet', 'acknowledge', 'deny']
        .includes(dialogueAct)) return [];
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

function validateWriterDraft(
    value: GroundedAnswerDraft,
    packet: AnswerPacket,
): GroundedAnswerDraft {
    if (!isRecord(value) || !hasExactKeys(value, ['clauses', 'highlights']) ||
        !Array.isArray(value['clauses']) || value['clauses'].length < 1 ||
        value['clauses'].length > 4 || !Array.isArray(value['highlights'])) {
        throw new Error('invalid_writer_shape');
    }
    const factById = new Map(packet.facts.map((fact) => [fact.id, fact]));
    const clauses = value['clauses'].map((clause, index) => {
        if (!isRecord(clause) || !hasExactKeys(clause, ['role', 'text', 'evidenceRefs']) ||
            !['direct_answer', 'context', 'next_step'].includes(String(clause['role'])) ||
            typeof clause['text'] !== 'string' || !Array.isArray(clause['evidenceRefs'])) {
            throw new Error('invalid_writer_clause');
        }
        if (index === 0 && clause['role'] !== 'direct_answer') {
            throw new Error('missing_direct_answer');
        }
        const evidenceRefs = validateEvidenceRefs(clause['evidenceRefs'], factById);
        if (clause['role'] === 'next_step') {
            const approvedRecommendation = packet.recommendations.some((recommendation) =>
                recommendation.text === cleanText(clause['text'], 1_200) &&
                recommendation.evidenceRefs.every((ref) => evidenceRefs.includes(ref)));
            const verifiedCapability = evidenceRefs.some((ref) =>
                ref.endsWith('.configured_capabilities') ||
                ref.endsWith('.role_capabilities') ||
                ref.endsWith('.greeting_capability') ||
                ref.endsWith('.required_clarification'));
            if (!approvedRecommendation && !verifiedCapability) {
                throw new Error('unapproved_next_step');
            }
        }
        return {
            role: clause['role'] as 'direct_answer' | 'context' | 'next_step',
            text: validateGroundedText(clause['text'], clause['evidenceRefs'], factById,
                packet.scope.matchedRoomNames),
            evidenceRefs,
        };
    });
    if (clauses.filter((clause) => clause.role === 'direct_answer').length !== 1) {
        throw new Error('invalid_direct_answer_count');
    }
    if (packet.responseGoal.startsWith('Connect the causal follow-up')) {
        const directAnswer = clauses[0]!;
        if (!directAnswer.evidenceRefs.some((ref) => ref.endsWith('.causal_connectivity')) ||
            !/^(?:yes|no)\b/iu.test(directAnswer.text) ||
            !/\b(?:because|reason)\b/iu.test(directAnswer.text)) {
            throw new Error('missing_causal_connection');
        }
    }
    const requiresExplanation = packet.responseGoal.includes('explain one useful');
    if (requiresExplanation && !clauses.some((clause) => clause.role === 'context')) {
        throw new Error('missing_context_explanation');
    }
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
    return { clauses, highlights };
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
    return {
        partId: work.requested.partId,
        text: draft.clauses.map((clause) => clause.text).join(' '),
        blocks: [],
        highlights: draft.highlights.map((highlight) => ({ text: highlight.text })),
        caveats: work.packet.notices.slice(0, 3),
    };
}

function normalizeAnswerTypography(partValue: ChatAnswerPart): ChatAnswerPart {
    const normalize = (value: string): string => value
        .replace(/(\d)\s*[\u2013\u2014\u2015]\s*(\d)/gu, '$1 to $2')
        .replace(/\s*[\u2013\u2014\u2015]\s*/gu, ', ')
        .replace(/[\u2010\u2011\u2012]/gu, ' ')
        .replace(/\s+,/gu, ',')
        .replace(/,\s*,+/gu, ', ')
        .replace(/\s{2,}/gu, ' ')
        .trim();
    return {
        ...partValue,
        text: normalize(partValue.text),
        blocks: partValue.blocks.map((block) => ({
            ...block,
            text: normalize(block.text),
            items: block.items.map(normalize),
            entries: block.entries.map((entry) => ({
                label: normalize(entry.label),
                value: normalize(entry.value),
            })),
        })),
        highlights: partValue.highlights.map((highlight) => ({
            text: normalize(highlight.text),
        })),
        caveats: partValue.caveats.map(normalize),
    };
}

function shouldUseWriter(work: PartWork): boolean {
    return work.requested.domain !== 'own_account';
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
    act: ChatDialogueAct,
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
    const referents: ChatStateReferent[] = works.map((work): ChatStateReferent => {
        const energy = work.results.map((result) => result.presentation)
            .find((presentation): presentation is EnergyReportPresentation =>
                presentation.kind === 'energy-report');
        const orderedNames = energy
            ? energy.rooms.filter((room) => room.status === 'recorded')
                .sort((left, right) => (left.rank ?? 999) - (right.rank ?? 999))
                .map((room) => room.roomName)
            : work.packet.scope.matchedRoomNames;
        const names = uniqueStrings(orderedNames).slice(0, 50);
        return {
            sourcePartId: work.requested.partId,
            kind: 'room_result',
            roomNames: names,
            complete: !work.results.some((result) => result.partial) && orderedNames.length <= 50,
            ordering: energy ? 'ranking' : 'query',
        };
    });
    const results: ChatStateResultMemory[] = works.map((work) => {
        const outcome = stateOutcomeFor(work);
        const directive = displayPlan.find((item) => item.partId === work.requested.partId);
        return {
            sourcePartId: work.requested.partId,
            subject: work.requested.domain,
            outcome: outcome.outcome,
            emptyReason: outcome.emptyReason,
            counts: stateCountsFor(work),
            roomNames: uniqueStrings(work.packet.scope.matchedRoomNames).slice(0, 50),
            complete: !work.results.some((result) => result.partial) &&
                work.packet.scope.matchedRoomNames.length <= 50,
            freshness: work.packet.freshness,
            asOf: stateTimestampFor(work),
            visual: directive?.mode ?? 'none',
            referenceEligible: isReferenceEligible(work),
        };
    });
    return { act, referenceBoundary: act === 'correct', contexts, referents, results };
}

function isReferenceEligible(work: PartWork): boolean {
    if (['conversation', 'unsupported'].includes(work.requested.domain)) return false;
    if (['system_concepts', 'assistant_capabilities', 'app_help'].includes(
        work.requested.domain,
    )) return true;
    return ![
        'permission_denied', 'room_ambiguous', 'source_unavailable',
        'insufficient_evidence', 'clarification_required', 'not_applicable',
    ].includes(work.answerability);
}

function stateOutcomeFor(work: PartWork): Pick<ChatStateResultMemory, 'outcome' | 'emptyReason'> {
    if (work.answerability === 'partial') {
        const hasNoOnlineReading = work.results.some((result) =>
            result.outcome === 'no_online_reading');
        return {
            outcome: 'partial',
            emptyReason: hasNoOnlineReading ? 'no_online_reading' : 'none',
        };
    }
    if (work.answerability === 'permission_denied') {
        return { outcome: 'denied', emptyReason: 'none' };
    }
    if (work.answerability === 'room_ambiguous' ||
        work.answerability === 'clarification_required') {
        return { outcome: 'ambiguous', emptyReason: 'none' };
    }
    if (work.answerability === 'source_unavailable') {
        return { outcome: 'unavailable', emptyReason: 'none' };
    }
    const emptyReasons: Partial<Record<ChatAnswerabilityOutcome,
        ChatStateResultMemory['emptyReason']>> = {
        no_online_reading: 'no_online_reading',
        no_energy_records: 'no_records',
        room_not_found: 'room_not_found',
        room_inactive: 'room_inactive',
        insufficient_evidence: 'insufficient_evidence',
    };
    const reason = emptyReasons[work.answerability];
    if (reason) return { outcome: 'empty', emptyReason: reason };
    const hasZeroRoomResult = work.results.some((result) =>
        result.presentation.kind === 'room-data' && result.presentation.rooms.length === 0);
    const roomCountIsZero = work.results.some((result) =>
        result.presentation.kind === 'metric-summary' &&
        result.presentation.metrics.some((metric) => metric.field === 'room_count' &&
            metric.value === 0));
    if (hasZeroRoomResult || roomCountIsZero) {
        return { outcome: 'empty', emptyReason: 'no_matches' };
    }
    return { outcome: 'matched', emptyReason: 'none' };
}

function stateCountsFor(work: PartWork): ChatStateResultMemory['counts'] {
    const counts: Array<{ field: SystemField; value: number }> = [];
    for (const result of work.results) {
        const presentation = result.presentation;
        if (presentation.kind === 'metric-summary') {
            for (const metric of presentation.metrics) {
                if (metric.unit === 'count' && typeof metric.value === 'number' &&
                    Number.isSafeInteger(metric.value) && metric.value >= 0) {
                    counts.push({ field: metric.field, value: metric.value });
                }
            }
        }
        if (presentation.kind === 'room-data') {
            counts.push({ field: 'room_count', value: presentation.rooms.length });
        }
        if (presentation.kind === 'schedule-data') {
            counts.push({ field: 'schedule_count', value: presentation.schedules.length });
        }
        if (presentation.kind === 'energy-report') {
            counts.push({ field: 'room_count', value: presentation.metrics.roomsWithRecords });
        }
    }
    const seen = new Set<SystemField>();
    return counts.filter((count) => {
        if (seen.has(count.field)) return false;
        seen.add(count.field);
        return true;
    }).slice(0, 8);
}

function stateTimestampFor(work: PartWork): string {
    const timestamps = work.results.flatMap((result) => {
        const presentation = result.presentation;
        if (presentation.kind === 'metric-summary') {
            return presentation.metrics.map((metric) => metric.asOf).filter(isString);
        }
        if (presentation.kind === 'room-data') {
            return presentation.rooms.flatMap((room) => room.values.map((value) => value.asOf))
                .filter(isString);
        }
        return [];
    }).filter((value) => Number.isFinite(new Date(value).getTime()));
    const latest = timestamps.map((value) => new Date(value))
        .sort((left, right) => right.getTime() - left.getTime())[0];
    return latest?.toISOString() ?? new Date().toISOString();
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
    return state.turns.slice(-CHAT_STATE_MAX_TURNS).map((turn) => ({
        act: turn.act,
        referenceBoundary: turn.referenceBoundary,
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
        results: turn.results,
    }));
}

interface LocatedStateResult {
    readonly turnIndex: number;
    readonly result: ChatStateResultMemory;
    readonly context: ChatStateContext | null;
}

function latestReferenceableResult(
    state: ChatStatePayload | null,
): LocatedStateResult | null {
    if (!state) return null;
    let newestEligible: LocatedStateResult | null = null;
    for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
        const turn = state.turns[turnIndex]!;
        for (let resultIndex = turn.results.length - 1; resultIndex >= 0; resultIndex -= 1) {
            const result = turn.results[resultIndex]!;
            if (!result.referenceEligible) continue;
            const context = turn.contexts.find((candidate) =>
                candidate.partId === result.sourcePartId) ?? null;
            const located = { turnIndex, result, context };
            if (!newestEligible) newestEligible = located;
            return located;
        }
        if (turn.referenceBoundary) break;
    }
    return newestEligible;
}

function latestUnavailableCurrentReadingReference(
    state: ChatStatePayload | null,
): LocatedStateResult | null {
    if (!state) return null;
    for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
        const turn = state.turns[turnIndex]!;
        const result = [...turn.results].reverse().find((candidate) =>
            candidate.referenceEligible);
        const located: LocatedStateResult | null = result ? {
            turnIndex,
            result,
            context: turn.contexts.find((context) =>
                context.partId === result.sourcePartId) ?? null,
        } : null;
        if (located && hasUnavailableCurrentReadingReference(located)) return located;
        if (turn.referenceBoundary || !isConnectivityConfirmationTurn(turn)) return null;
    }
    return null;
}

function isConnectivityConfirmationTurn(turn: ChatStateTurn): boolean {
    if (!['confirm', 'follow_up', 'elaborate'].includes(turn.act)) return false;
    return turn.contexts.some((context) => context.domain === 'devices' &&
        context.fields.some((field) => [
            'device_status', 'online_device_count', 'stale_device_count',
            'offline_device_count', 'unknown_device_status_count',
        ].includes(field)));
}

function normalizePlannerFailure(
    error: unknown,
    provider: 'gemini' | 'groq',
): ProviderRecoverableError | ProviderRequestError | ProviderResponseError {
    if (error instanceof ProviderRecoverableError || error instanceof ProviderRequestError ||
        error instanceof ProviderResponseError) {
        return error;
    }
    if (error instanceof CapabilityValidationError) {
        return new ProviderResponseError(provider, 'invalid_semantics', error);
    }
    return new ProviderResponseError(provider, 'generated_output_mismatch', error);
}

function plannerFailureCategory(error: unknown): string {
    if (error instanceof ProviderRecoverableError) return error.category;
    if (error instanceof ProviderRequestError) return error.category;
    if (error instanceof ProviderResponseError) {
        if (error.category === 'invalid_semantics' &&
            error.cause instanceof CapabilityValidationError) {
            return safeCapabilityValidationReason(error.cause.reason);
        }
        return error.category;
    }
    return 'generated_output_mismatch';
}

function isSemanticPlannerFailure(error: unknown): boolean {
    return error instanceof ProviderResponseError && error.category === 'invalid_semantics';
}

function safeCapabilityValidationReason(reason: string): string {
    return /^[a-z][a-z0-9_]{0,63}$/u.test(reason) ? reason : 'invalid_semantics';
}

function providerFailureSummary(error: unknown): string {
    if (error instanceof BothProvidersFailedError) {
        return `${plannerFailureCategory(error.primaryError)}_then_${
            plannerFailureCategory(error.fallbackError)}`;
    }
    return plannerFailureCategory(error);
}

function boundedProviderTimeout(
    desiredMs: number,
    deadlineAtMs: number,
    reserveMs: number,
    provider: 'gemini' | 'groq',
): number {
    const timeoutMs = Math.floor(Math.min(desiredMs, deadlineAtMs - Date.now() - reserveMs));
    if (timeoutMs < 250) throw new ProviderRecoverableError(provider, 'timeout');
    return timeoutMs;
}

function resolveHelpTopic(plannedTopic: string, message: string): string | null {
    const planned = normalizeHelpTopic(plannedTopic);
    if (planned) return planned;
    if (/\b(password|change\s+pass(?:word)?)\b/u.test(message)) return 'change-password';
    if (/\b(add|create|new)\b.*\broom\b/u.test(message)) return 'add-room';
    if (/\b(edit|update|modify)\b.*\broom\b/u.test(message)) return 'edit-room';
    if (/\bassign\b.*\bfloor|\bfloor\b.*\bassign/u.test(message)) return 'assign-floor-plan-cell';
    if (/floor.*legend/u.test(message)) return 'floor-plan-legend';
    if (/schedule/u.test(message)) return 'manage-schedules';
    if (/approve.*staff/u.test(message)) return 'approve-staff';
    if (/energy.*report|report.*energy/u.test(message)) return 'view-energy-reports';
    if (/forced?.*off/u.test(message)) return 'forced-off';
    if (/override/u.test(message)) return 'manual-override';
    if (/ocu.?guide|chat/u.test(message)) return 'ocu-guide';
    return null;
}

function normalizeHelpTopic(value: string): string | null {
    const token = cleanText(value, 80).toLocaleLowerCase('en-US')
        .replace(/[\s_]+/gu, '-');
    if (Object.prototype.hasOwnProperty.call(HELP_TOPIC_ROLES, token)) return token;
    const aliases: Readonly<Record<string, string>> = {
        password: 'change-password', 'change-pass': 'change-password',
        room: 'add-room', 'room-add': 'add-room', 'create-room': 'add-room',
        'room-edit': 'edit-room', 'update-room': 'edit-room',
        'floor-plan': 'assign-floor-plan-cell', schedules: 'manage-schedules',
        energy: 'view-energy-reports', overrides: 'manual-override', chat: 'ocu-guide',
    };
    const resolved = aliases[token];
    return resolved && Object.prototype.hasOwnProperty.call(HELP_TOPIC_ROLES, resolved)
        ? resolved : null;
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
        system_concepts: 'OcuTemp system concepts',
        unsupported: 'Unsupported',
    };
    return labels[domain] ?? domain;
}

function requiresCurrentReading(part: SystemQueryPart): boolean {
    return part.fields.some((field) =>
        ['temperature', 'humidity', 'condition', 'occupancy', 'ac_power'].includes(field));
}

function deterministicDomain(domain: SystemDomain): boolean {
    return ['conversation', 'unsupported', 'assistant_capabilities', 'system_concepts',
        'own_account'].includes(domain);
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

function isString(value: string | null): value is string {
    return typeof value === 'string';
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
