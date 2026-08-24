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
    ChatStatePayload,
    ChatTurnResponse,
} from '../../server/chat/types/chat.types.js';
import { ChatApiError } from '../../server/chat/types/chat.types.js';


const MAX_PUBLIC_RESPONSE_BYTES = 256 * 1024;
const TURN_DEADLINE_MS = 20_000;
const textEncoder = new TextEncoder();

async function handler(request: Request): Promise<Response> {
    const requestId = globalThis.crypto.randomUUID();
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
        const user = await authenticateChatRequest(request, turnController.signal);
        stage = 'authenticated_limits';
        lease = await acquireAuthenticatedLimits(user.uid, turnController.signal);

        stage = 'state_decode';
        const decoded = await decodeChatState(input.stateToken, user.uid, turnController.signal);
        const runtimeConfig = getChatConfig();
        const firebase = new FirebaseRestClient({
            databaseUrl: runtimeConfig.firebaseDatabaseUrl,
            idToken: user.idToken,
            abortSignal: turnController.signal,
        });

        stage = 'orchestration';
        const result = await runChatTurn({
            requestId,
            message: input.message,
            user,
            state: decoded.state,
            firebase,
            abortSignal: turnController.signal,
        });

        const nowSeconds = Math.floor(Date.now() / 1_000);
        const state: ChatStatePayload = {
            version: 2,
            uid: user.uid,
            conversationId: decoded.state?.conversationId ?? globalThis.crypto.randomUUID(),
            issuedAt: nowSeconds,
            expiresAt: nowSeconds + CHAT_STATE_LIFETIME_SECONDS,
            turns: [
                ...(decoded.state?.turns ?? []),
                {
                    user: input.message,
                    assistant: result.stateSummary,
                    context: result.stateContext,
                },
            ].slice(-5),
        };

        stage = 'state_encode';
        const response: ChatTurnResponse = {
            turnId: requestId,
            questionFocus: result.questionFocus,
            answer: result.answer,
            presentations: result.presentations,
            displayPlan: result.displayPlan,
            evidence: {
                asOf: new Date().toISOString(),
                timeZone: 'Asia/Manila',
                partial: result.partial,
                notices: result.notices,
            },
            stateToken: await encodeChatState(state, turnController.signal),
            contextReset: decoded.contextReset,
        };

        const serialized = JSON.stringify(response);
        if (textEncoder.encode(serialized).byteLength > MAX_PUBLIC_RESPONSE_BYTES) {
            throw new ChatApiError(
                'facility_too_large',
                'The facility report is too large to return safely. Narrow the room scope.',
                413,
            );
        }
        return jsonResponse(serialized, 200);
    } catch (error: unknown) {
        const mappedError = turnController.signal.aborted && !isExpectedClientError(error)
            ? new ChatApiError(
                'assistant_unavailable',
                'The assistant request exceeded its safe processing deadline.',
                503,
                undefined,
                error,
            )
            : error;
        return handleError(mappedError, requestId, stage);
    } finally {
        clearTimeout(turnDeadline);
        request.signal.removeEventListener('abort', abortTurn);
        await lease?.release();
    }
}

export default { fetch: handler };

function handleError(error: unknown, requestId: string, stage: string): Response {
    if (error instanceof ChatApiError) {
        if (error.statusCode >= 500) {
            console.error('[chat] request failed', {
                requestId,
                stage,
                code: error.code,
                status: error.statusCode,
            });
        }
        const body: ChatErrorResponse = {
            error: {
                code: error.code,
                message: publicErrorMessage(error),
                ...(error.retryAfterSeconds
                    ? { retryAfterSeconds: error.retryAfterSeconds }
                    : {}),
            },
            requestId,
        };
        return jsonResponse(JSON.stringify(body), error.statusCode, error.retryAfterSeconds);
    }

    if (error instanceof BothProvidersFailedError) {
        console.error('[chat] both providers unavailable', { requestId, stage });
        return jsonResponse(
            JSON.stringify({
                error: {
                    code: 'assistant_unavailable',
                    message: 'OcuGuide is temporarily unavailable. Please try again shortly.',
                },
                requestId,
            } satisfies ChatErrorResponse),
            503,
        );
    }

    console.error('[chat] unhandled request failure', {
        requestId,
        stage,
        category: error instanceof Error ? error.name : 'unknown',
    });
    return jsonResponse(
        JSON.stringify({
            error: {
                code: 'assistant_unavailable',
                message: 'OcuGuide is temporarily unavailable. Please try again shortly.',
            },
            requestId,
        } satisfies ChatErrorResponse),
        500,
    );
}

function isExpectedClientError(error: unknown): boolean {
    return error instanceof ChatApiError && error.statusCode < 500;
}

function publicErrorMessage(error: ChatApiError): string {
    return error.message;
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
