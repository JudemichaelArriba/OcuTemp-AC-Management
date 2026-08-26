import { getChatConfig } from '../../server/chat/config.js';
import { FirebaseRestClient } from '../../server/chat/firebase-rest.js';
import { authenticateChatRequest } from '../../server/chat/middleware/auth.js';
import {
    acquireAuthenticatedLimits,
    enforcePreAuthRateLimit,
} from '../../server/chat/middleware/rate-limit.js';
import {
    assertAllowedOrigin,
    assertJsonContentType,
    assertPostMethod,
    readJsonBody,
    validateChatRequest,
} from '../../server/chat/middleware/validate-request.js';
import { runChatTurn } from '../../server/chat/orchestrator.js';
import { BothProvidersFailedError } from '../../server/chat/retry.js';
import {
    CHAT_STATE_LIFETIME_SECONDS,
    decodeChatState,
    encodeChatState,
} from '../../server/chat/state.js';
import type {
    ChatErrorResponse,
    ChatPrincipal,
    ChatStatePayload,
    ChatTurnResponse,
} from '../../server/chat/types/chat.types.js';
import { ChatApiError } from '../../server/chat/types/chat.types.js';

const MAX_PUBLIC_RESPONSE_BYTES = 256 * 1024;
const TURN_DEADLINE_MS = 20_000;
const textEncoder = new TextEncoder();

async function handler(request: Request): Promise<Response> {
    const requestId = globalThis.crypto.randomUUID();
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + TURN_DEADLINE_MS;
    let stage = 'request_headers';
    let lease: Awaited<ReturnType<typeof acquireAuthenticatedLimits>> | undefined;
    const turnController = new AbortController();
    const abortTurn = (): void => turnController.abort();
    if (request.signal.aborted) turnController.abort();
    else request.signal.addEventListener('abort', abortTurn, { once: true });
    const turnDeadline = setTimeout(abortTurn, TURN_DEADLINE_MS);

    try {
        assertPostMethod(request);
        assertAllowedOrigin(request);
        assertJsonContentType(request);
        stage = 'pre_auth_limit';
        await enforcePreAuthRateLimit(request, turnController.signal);
        stage = 'request_body';
        const rawBody = await readJsonBody(request, turnController.signal);
        const input = validateChatRequest(rawBody);
        stage = 'authentication';
        const authenticated = await authenticateChatRequest(request, turnController.signal);
        stage = 'authenticated_limits';
        lease = await acquireAuthenticatedLimits(authenticated.uid, turnController.signal);

        stage = 'state_decode';
        const decoded = await decodeChatState(
            input.stateToken,
            authenticated.uid,
            turnController.signal,
        );
        const runtimeConfig = getChatConfig();
        // The ID token is confined to the authenticated Firebase transport.
        const firebase = new FirebaseRestClient({
            databaseUrl: runtimeConfig.firebaseDatabaseUrl,
            idToken: authenticated.idToken,
            abortSignal: turnController.signal,
        });
        const principal: ChatPrincipal = {
            uid: authenticated.uid,
            role: authenticated.role,
            approved: true,
            emailVerified: authenticated.emailVerified,
            fullName: authenticated.fullName,
            email: authenticated.email,
        };

        stage = 'orchestration';
        const result = await runChatTurn({
            requestId,
            message: input.message,
            user: principal,
            state: decoded.state,
            firebase,
            abortSignal: turnController.signal,
            deadlineAtMs,
        });

        const nowSeconds = Math.floor(Date.now() / 1_000);
        const state: ChatStatePayload = {
            version: 5,
            uid: principal.uid,
            conversationId: decoded.state?.conversationId ?? globalThis.crypto.randomUUID(),
            issuedAt: nowSeconds,
            expiresAt: nowSeconds + CHAT_STATE_LIFETIME_SECONDS,
            turns: [...(decoded.state?.turns ?? []), result.stateTurn].slice(-5),
        };

        stage = 'state_encode';
        const response: ChatTurnResponse = {
            turnId: requestId,
            responseContexts: result.responseContexts,
            answerParts: result.answerParts,
            presentations: result.presentations,
            displayPlan: result.displayPlan,
            evidence: {
                asOf: new Date().toISOString(),
                timeZone: 'Asia/Manila',
                source: result.evidenceSource,
                partial: result.partial,
                notices: result.notices,
            },
            followUps: result.followUps,
            stateToken: await encodeChatState(state, turnController.signal),
            contextReset: decoded.contextReset,
        };

        const serialized = JSON.stringify(response);
        if (textEncoder.encode(serialized).byteLength > MAX_PUBLIC_RESPONSE_BYTES) {
            throw new ChatApiError('facility_too_large',
                'The response exceeds the safe public response limit.', 413);
        }
        return jsonResponse(serialized, 200);
    } catch (error: unknown) {
        const mappedError = turnController.signal.aborted && !isExpectedClientError(error)
            ? new ChatApiError('assistant_unavailable',
                'The assistant request exceeded its safe processing deadline.', 503,
                undefined, error)
            : error;
        return handleError(mappedError, requestId, stage, Date.now() - startedAt);
    } finally {
        clearTimeout(turnDeadline);
        request.signal.removeEventListener('abort', abortTurn);
        await lease?.release();
    }
}

export default { fetch: handler };

function handleError(
    error: unknown,
    requestId: string,
    stage: string,
    durationMs: number,
): Response {
    if (error instanceof ChatApiError) {
        if (error.statusCode >= 500) logFailure(requestId, stage, safeCategory(error), durationMs);
        const body: ChatErrorResponse = {
            error: {
                code: error.code,
                message: publicErrorMessage(error),
                ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
            },
            requestId,
        };
        return jsonResponse(JSON.stringify(body), error.statusCode, error.retryAfterSeconds);
    }
    if (error instanceof BothProvidersFailedError) {
        logFailure(requestId, stage, 'providers_unavailable', durationMs);
        return jsonResponse(JSON.stringify({
            error: { code: 'assistant_unavailable',
                message: 'OcuGuide is temporarily unavailable. Please try again shortly.' },
            requestId,
        } satisfies ChatErrorResponse), 503);
    }
    logFailure(requestId, stage, 'internal_failure', durationMs);
    return jsonResponse(JSON.stringify({
        error: { code: 'assistant_unavailable',
            message: 'OcuGuide is temporarily unavailable. Please try again shortly.' },
        requestId,
    } satisfies ChatErrorResponse), 500);
}

function publicErrorMessage(error: ChatApiError): string {
    if (error.statusCode < 500) return error.message;
    if (error.code === 'data_unavailable') {
        return 'The requested OcuTemp data is temporarily unavailable. Please try again shortly.';
    }
    return 'OcuGuide is temporarily unavailable. Please try again shortly.';
}

function safeCategory(error: ChatApiError): string {
    if (error.code === 'configuration_error') return 'configuration';
    if (error.code === 'data_unavailable') return 'data_unavailable';
    if (error.code === 'assistant_unavailable') return 'deadline_or_provider';
    return 'server_rejection';
}

function logFailure(
    requestId: string,
    stage: string,
    safeFailureCategory: string,
    durationMs: number,
): void {
    console.error('[chat] request failed', {
        requestId,
        stage,
        safeFailureCategory,
        durationBucket: durationBucket(durationMs),
        fallbackOutcome: 'request_failed',
    });
}

function durationBucket(durationMs: number): string {
    if (durationMs < 500) return 'under_500ms';
    if (durationMs < 1_500) return '500_1499ms';
    if (durationMs < 3_000) return '1500_2999ms';
    if (durationMs < 6_000) return '3000_5999ms';
    return '6000ms_or_more';
}

function isExpectedClientError(error: unknown): boolean {
    return error instanceof ChatApiError && error.statusCode < 500;
}

function jsonResponse(body: string, status: number, retryAfterSeconds?: number): Response {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        Vary: 'Origin, Authorization',
    };
    if (retryAfterSeconds) headers['Retry-After'] = String(retryAfterSeconds);
    if (status === 405) headers['Allow'] = 'POST';
    return new Response(body, { status, headers });
}
