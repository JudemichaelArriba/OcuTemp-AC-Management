import { getChatConfig } from '../config.js';
import type { ValidatedChatRequest } from '../types/chat.types.js';
import { ChatApiError } from '../types/chat.types.js';

export const MAX_CHAT_MESSAGE_CHARACTERS = 500;
export const MAX_CHAT_STATE_TOKEN_BYTES = 12 * 1024;
export const MAX_CHAT_REQUEST_BODY_BYTES = 16 * 1024;

const ALLOWED_BODY_KEYS = new Set(['message', 'stateToken']);
const textEncoder = new TextEncoder();

/** Performs all cheap HTTP-envelope checks and returns the parsed JSON body. */
export async function validateRequestEnvelope(
    request: Request,
    abortSignal?: AbortSignal,
): Promise<unknown> {
    assertPostMethod(request);
    assertAllowedOrigin(request);
    assertJsonContentType(request);
    return readJsonBody(request, abortSignal);
}

export function assertPostMethod(request: Request): void {
    if (request.method.toUpperCase() !== 'POST') {
        throw new ChatApiError(
            'method_not_allowed',
            'Only POST requests are accepted by this endpoint.',
            405,
        );
    }
}

export function assertAllowedOrigin(request: Request): string {
    const origin = request.headers.get('origin')?.trim();
    const allowedOrigins = getChatConfig().allowedOrigins;
    const candidate = origin ? normalizeExactOrigin(origin) : deriveRequestOrigin(request);
    if (!candidate || !allowedOrigins.has(candidate)) {
        throw new ChatApiError(
            'origin_not_allowed',
            'This website is not allowed to use the assistant.',
            403,
        );
    }
    return candidate;
}

function normalizeExactOrigin(origin: string): string | null {
    try {
        const parsed = new URL(origin);
        return parsed.origin === origin ? origin : null;
    } catch {
        return null;
    }
}

function deriveRequestOrigin(request: Request): string | null {
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    if (
        !host ||
        host.length > 255 ||
        /[\s,/@\\?#]/.test(host) ||
        host.includes('..')
    ) {
        return null;
    }
    const forwardedProtoHeader = request.headers.get('x-forwarded-proto');
    if (forwardedProtoHeader?.includes(',')) return null;
    const forwardedProto = forwardedProtoHeader?.trim().toLowerCase();
    if (forwardedProtoHeader && forwardedProto !== 'http' && forwardedProto !== 'https') {
        return null;
    }
    let requestProtocol: string;
    try {
        requestProtocol = new URL(request.url).protocol.replace(':', '');
    } catch {
        return null;
    }
    const protocol = forwardedProto ?? requestProtocol;
    if (protocol !== 'http' && protocol !== 'https') return null;
    try {
        const parsed = new URL(`${protocol}://${host}`);
        if (parsed.username || parsed.password || (parsed.pathname !== '/' && parsed.pathname !== '')) {
            return null;
        }
        return parsed.origin;
    } catch {
        return null;
    }
}

export function assertJsonContentType(request: Request): void {
    const contentType = request.headers.get('content-type');
    const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
        throw new ChatApiError(
            'invalid_request',
            'Content-Type must be application/json.',
            415,
        );
    }
}

/** Reads the body as a capped UTF-8 stream before parsing JSON. */
export async function readJsonBody(
    request: Request,
    abortSignal?: AbortSignal,
): Promise<unknown> {
    const declaredLength = request.headers.get('content-length');
    if (declaredLength !== null) {
        if (!/^\d+$/.test(declaredLength)) {
            throw invalidRequest('Content-Length is invalid.');
        }
        if (Number(declaredLength) > MAX_CHAT_REQUEST_BODY_BYTES) {
            throw requestTooLarge();
        }
    }

    if (!request.body) {
        throw invalidRequest('A JSON request body is required.');
    }
    if (abortSignal?.aborted) {
        throw requestDeadlineExceeded();
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let bodyAborted = false;
    const abortBody = (): void => {
        bodyAborted = true;
        void reader.cancel().catch(() => undefined);
    };
    abortSignal?.addEventListener('abort', abortBody, { once: true });

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (bodyAborted) {
                throw requestDeadlineExceeded();
            }
            if (done) {
                break;
            }

            byteLength += value.byteLength;
            if (byteLength > MAX_CHAT_REQUEST_BODY_BYTES) {
                await reader.cancel().catch(() => undefined);
                throw requestTooLarge();
            }
            chunks.push(value);
        }
    } catch (error: unknown) {
        if (bodyAborted) {
            throw requestDeadlineExceeded();
        }
        throw error;
    } finally {
        abortSignal?.removeEventListener('abort', abortBody);
        reader.releaseLock();
    }

    if (byteLength === 0) {
        throw invalidRequest('A JSON request body is required.');
    }

    const bodyBytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bodyBytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    let bodyText: string;
    try {
        bodyText = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
    } catch {
        throw invalidRequest('The request body must contain valid UTF-8.');
    }

    try {
        return JSON.parse(bodyText) as unknown;
    } catch {
        throw invalidRequest('The request body is not valid JSON.');
    }
}

/** Validates the exact browser-to-server chat payload contract. */
export function validateChatRequest(body: unknown): ValidatedChatRequest {
    if (!isRecord(body)) {
        throw invalidRequest('Request body must be a JSON object.');
    }

    const keys = Object.keys(body);
    if (keys.some((key) => !ALLOWED_BODY_KEYS.has(key))) {
        throw invalidRequest('Request body contains an unsupported field.');
    }
    if (!Object.hasOwn(body, 'message')) {
        throw invalidRequest('message is required.');
    }

    const rawMessage = body['message'];
    if (typeof rawMessage !== 'string') {
        throw invalidRequest('message must be a string.');
    }

    const message = rawMessage.trim();
    const rawMessageLength = Array.from(rawMessage).length;
    const messageLength = Array.from(message).length;
    if (
        rawMessageLength > MAX_CHAT_MESSAGE_CHARACTERS ||
        messageLength < 1 ||
        messageLength > MAX_CHAT_MESSAGE_CHARACTERS
    ) {
        throw invalidRequest(
            `message must contain between 1 and ${MAX_CHAT_MESSAGE_CHARACTERS} characters.`,
        );
    }

    if (!Object.hasOwn(body, 'stateToken')) {
        return { message };
    }

    const stateToken = body['stateToken'];
    if (
        typeof stateToken !== 'string' ||
        stateToken.length === 0 ||
        textEncoder.encode(stateToken).byteLength > MAX_CHAT_STATE_TOKEN_BYTES
    ) {
        throw invalidRequest(
            `stateToken must be a non-empty string no larger than ${MAX_CHAT_STATE_TOKEN_BYTES} bytes.`,
        );
    }

    return { message, stateToken };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): ChatApiError {
    return new ChatApiError('invalid_request', message, 400);
}

function requestTooLarge(): ChatApiError {
    return new ChatApiError(
        'invalid_request',
        `Request body exceeds the ${MAX_CHAT_REQUEST_BODY_BYTES}-byte limit.`,
        413,
    );
}

function requestDeadlineExceeded(): ChatApiError {
    return new ChatApiError(
        'assistant_unavailable',
        'The assistant request took too long. Please try again.',
        503,
    );
}
