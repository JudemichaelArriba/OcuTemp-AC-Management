import type { ChatApiRequest, ChatMessage, ChatUserRole } from '../types/chat.types';
import { ChatApiError } from '../types/chat.types';

const VALID_ROLES: readonly ChatUserRole[] = ['staff', 'admin'];
const VALID_MESSAGE_ROLES = ['user', 'model', 'function'] as const;
const MAX_MESSAGES = 20;
const MAX_CONTENT_LENGTH = 2000;

/**
 * Validates an incoming request body before anything touches a model
 * call. Throws ChatApiError with a 400 status on any structural
 * problem. This is a cheap, synchronous check its entire purpose is
 * to reject malformed or malicious payloads before they cost a Gemini
 * or Groq request.
 */
export function validateChatRequest(body: unknown): ChatApiRequest {
    if (typeof body !== 'object' || body === null) {
        throw new ChatApiError('Request body must be a JSON object', 400);
    }

    const { messages, userRole } = body as Record<string, unknown>;

    if (!VALID_ROLES.includes(userRole as ChatUserRole)) {
        throw new ChatApiError("userRole must be 'staff' or 'admin'", 400);
    }

    if (!Array.isArray(messages) || messages.length === 0) {
        throw new ChatApiError('messages must be a non-empty array', 400);
    }

    if (messages.length > MAX_MESSAGES) {
        throw new ChatApiError(
            `messages exceeds maximum allowed length of ${MAX_MESSAGES}`,
            400,
        );
    }

    const validatedMessages = messages.map((msg, index) => validateMessage(msg, index));

    return {
        messages: validatedMessages,
        userRole: userRole as ChatUserRole,
    };
}

function validateMessage(msg: unknown, index: number): ChatMessage {
    if (typeof msg !== 'object' || msg === null) {
        throw new ChatApiError(`messages[${index}] must be an object`, 400);
    }

    const { id, role, content, createdAt, toolCall, toolResult } = msg as Record<string, unknown>;

    if (typeof id !== 'string' || id.length === 0) {
        throw new ChatApiError(`messages[${index}].id must be a non-empty string`, 400);
    }

    if (!VALID_MESSAGE_ROLES.includes(role as (typeof VALID_MESSAGE_ROLES)[number])) {
        throw new ChatApiError(`messages[${index}].role is invalid`, 400);
    }

    if (typeof content !== 'string') {
        throw new ChatApiError(`messages[${index}].content must be a string`, 400);
    }

    if (content.length > MAX_CONTENT_LENGTH) {
        throw new ChatApiError(
            `messages[${index}].content exceeds maximum length of ${MAX_CONTENT_LENGTH}`,
            400,
        );
    }

    if (typeof createdAt !== 'string') {
        throw new ChatApiError(`messages[${index}].createdAt must be a string`, 400);
    }

    return {
        id,
        role: role as ChatMessage['role'],
        content,
        createdAt,
        toolCall: toolCall as ChatMessage['toolCall'],
        toolResult: toolResult as ChatMessage['toolResult'],
    };
}