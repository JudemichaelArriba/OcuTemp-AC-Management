/**
 * Backend mirror of src/app/models/chat.models.ts.
 * These two files define the contract crossing the browser  Vercel
 * boundary and must be kept in sync manually changing one without
 * the other will break request/response parsing silently at runtime,
 * since this boundary has no shared build step to catch drift.
 */

export type ChatRole = 'user' | 'model' | 'function';

export type ChatToolName =
    | 'get_room_telemetry'
    | 'get_energy_rankings'
    | 'get_climate_prediction_logs'
    | 'get_system_help';

export type ChatProviderId = 'gemini' | 'groq';

export type ChatUserRole = 'staff' | 'admin';

export interface ChatMessage {
    readonly id: string;
    readonly role: ChatRole;
    readonly content: string;
    readonly createdAt: string;
    readonly toolCall?: ChatToolCall;
    readonly toolResult?: ChatToolResult;
}

export interface ChatToolCall {
    readonly name: ChatToolName;
    readonly args: Record<string, unknown>;
}

export interface ChatToolResult {
    readonly name: ChatToolName;
    readonly data: unknown;
    readonly fetchedAt: string;
}

export interface ChatApiRequest {
    readonly messages: ChatMessage[];
    readonly userRole: ChatUserRole;
}

export interface ChatApiResponse {
    readonly toolCall?: ChatToolCall;
    readonly answer?: string;
    readonly providerUsed: ChatProviderId;
    readonly usedFallback: boolean;
}

/**
 * Internal-only type: what orchestrator.ts gets back from a provider
 * before it's translated into a ChatApiResponse. Not sent over the wire.
 */
export interface ProviderGenerateResult {
    readonly toolCall?: ChatToolCall;
    readonly answer?: string;
}

/**
 * Internal-only type: the shape validate-request.ts checks incoming
 * requests against before anything touches a model call.
 */
export interface ValidatedChatRequest extends ChatApiRequest {
    readonly clientIp: string;
}

/** Thrown by middleware or orchestrator on malformed/unauthorized requests. */
export class ChatApiError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
        override readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'ChatApiError';
    }
}