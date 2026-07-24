/**
 * Shared chat contract between the Angular frontend and the /api/chat
 * Vercel serverless endpoint. Keep this file's shape in sync with
 * api/chat/types/chat.types.ts on the backend they must match exactly.
 */

export type ChatRole = 'user' | 'model' | 'function';

export type ChatToolName =
    | 'get_room_telemetry'
    | 'get_energy_rankings'
    | 'get_energy_usage'
    | 'get_climate_prediction_logs'
    | 'get_system_help';

export type ChatProviderId = 'gemini' | 'groq';

/**
 * A single message in a conversation. Mirrors Gemini's function-calling
 * message shape closely enough to pass through with minimal transformation,
 * while staying provider-agnostic at the type level.
 */
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

/**
 * Request body sent from chat.service.ts to /api/chat.
 * `messages` should already be trimmed by chat-history-trimmer.ts
 * before this is constructed — this type does not enforce a window size.
 */
export interface ChatApiRequest {
    readonly messages: ChatMessage[];
    readonly userRole: 'staff' | 'admin';
}

/**
 * Response shape from /api/chat. Exactly one of `toolCall` or `answer`
 * will be present, never both the frontend branches on which one it got.
 */
export interface ChatApiResponse {
    readonly toolCall?: ChatToolCall;
    readonly answer?: string;
    readonly providerUsed: ChatProviderId;
    readonly usedFallback: boolean;
}

/**
 * Result of chat-response-validator.ts checking a model answer
 * against the clean tool data it was supposed to be grounded in.
 */
export interface ChatValidationResult {
    readonly isValid: boolean;
    readonly reason?: string;
}

/**
 * A single entry in system-help-content.ts. Distinct from tool
 * telemetry data — this is static, hand-authored content.
 */
export interface SystemHelpEntry {
    readonly topic: string;
    readonly title: string;
    readonly steps: readonly string[];
    readonly route: string;
    readonly adminOnly: boolean;
}

/** Thrown by chat.service.ts on request validation or network failure. */
export class ChatRequestError extends Error {
    constructor(message: string, override readonly cause?: unknown) {
        super(message);
        this.name = 'ChatRequestError';
    }
}

export type ChatUserRole = 'staff' | 'admin';