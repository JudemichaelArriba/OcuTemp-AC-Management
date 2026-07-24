import { enforceRateLimit } from './middleware/rate-limit';
import { validateChatRequest } from './middleware/validate-request';
import { runChatTurn } from './orchestrator';
import { ChatApiError } from './types/chat.types';
import { BothProvidersFailedError } from './retry';

export const config = { runtime: 'edge' };

/**
 * Single Vercel entry point for the chatbot. Kept deliberately thin
 * this file's only job is HTTP plumbing: parse, validate, rate-limit,
 * delegate to the orchestrator, map errors to status codes. All real
 * logic lives in orchestrator.ts, retry.ts, and the middleware files.
 */
export default async function handler(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
        await enforceRateLimit(req);

        let rawBody: unknown;
        try {
            rawBody = await req.json();
        } catch {
            return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }

        const validatedRequest = validateChatRequest(rawBody);
        const response = await runChatTurn(validatedRequest);

        return jsonResponse(response, 200);
    } catch (error: unknown) {
        return handleError(error);
    }
}

function handleError(error: unknown): Response {
    if (error instanceof ChatApiError) {
        return jsonResponse({ error: error.message }, error.statusCode);
    }

    if (error instanceof BothProvidersFailedError) {
        // eslint-disable-next-line no-console
        console.error('[chat] both providers failed', {
            primary: serializeError(error.primaryError),
            fallback: serializeError(error.fallbackError),
        });
        return jsonResponse(
            { error: 'The assistant is temporarily unavailable. Please try again shortly.' },
            503,
        );
    }


    console.error('[chat] unhandled error', serializeError(error));
    return jsonResponse({ error: 'Something went wrong.' }, 500);
}

function serializeError(error: unknown): unknown {
    if (error instanceof Error) {
        return { name: error.name, message: error.message };
    }
    return error;
}

function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}