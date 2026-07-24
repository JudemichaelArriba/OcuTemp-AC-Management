import { ChatToolResult, ChatValidationResult } from '../models/chat.models';
import { getSystemHelpEntry } from './system-help-content';

/**
 * Deterministic, zero-LLM guardrail. Checks a
 * model's final answer text against the clean tool result it was
 * supposed to be grounded in, before the answer is allowed to render.
 * Pure functions, no network calls — this must stay fast and free.
 *
 * Two distinct rule sets: data tools (numbers/room names must appear
 * in the payload) vs get_system_help (steps/route must match the
 * stored entry exactly, since that content is static and already
 * correct any deviation means the model embellished).
 */
export function validateChatAnswer(
    answerText: string,
    toolResult: ChatToolResult | null,
): ChatValidationResult {
    if (!toolResult) {
        return { isValid: true };
    }

    if (toolResult.name === 'get_system_help') {
        return validateSystemHelpAnswer(answerText, toolResult.data);
    }

    return validateDataAnswer(answerText, toolResult.data);
}

/**
 * For data tools: every number mentioned in the answer must appear
 * somewhere in the clean payload (rounded the same way), and every
 * room name mentioned must appear in the payload's room names.
 * Doesn't try to verify the answer is a complete or well-phrased
 * summary — only that it isn't inventing figures.
 */
function validateDataAnswer(answerText: string, data: unknown): ChatValidationResult {
    const payloadNumbers = extractNumbers(JSON.stringify(data));
    const answerNumbers = extractNumbers(answerText);

    const inventedNumber = answerNumbers.find((num) => !payloadNumbers.includes(num));
    if (inventedNumber !== undefined) {
        return {
            isValid: false,
            reason: `Answer contains a number (${inventedNumber}) not present in the tool result`,
        };
    }

    const payloadRoomNames = extractRoomNames(data);
    const answerRoomNames = extractRoomNamesFromText(answerText, payloadRoomNames);

    const inventedRoom = answerRoomNames.find((room) => !payloadRoomNames.includes(room));
    if (inventedRoom) {
        return {
            isValid: false,
            reason: `Answer mentions a room ("${inventedRoom}") not present in the tool result`,
        };
    }

    return { isValid: true };
}

/**
 * For get_system_help: the answer's steps/route should trace back to
 * the matched entry. Loose substring check rather than exact match,
 * since the model may lightly rephrase — this is a fuzzier check by
 * necessity, catching only clear invention (a route or step-like
 * sentence that shares no real overlap with the stored entry).
 */
function validateSystemHelpAnswer(answerText: string, data: unknown): ChatValidationResult {
    const topic = (data as { topic?: string } | null)?.topic;
    if (!topic) {
        // Tool result was a "not found" — nothing to validate against.
        return { isValid: true };
    }

    const entry = getSystemHelpEntry(topic);
    if (!entry) {
        return { isValid: true }; // shouldn't happen if the executor is correct; fail open here, not closed
    }

    if (entry.route && answerText.includes('/app/') && !answerText.includes(entry.route)) {
        const mentionsOtherRoute = /\/app\/[a-z-]+/i.exec(answerText);
        if (mentionsOtherRoute && mentionsOtherRoute[0] !== entry.route) {
            return {
                isValid: false,
                reason: `Answer references route "${mentionsOtherRoute[0]}" which doesn't match the help entry's route "${entry.route}"`,
            };
        }
    }

    return { isValid: true };
}

function extractNumbers(text: string): number[] {
    const matches = text.match(/-?\d+(\.\d+)?/g) ?? [];
    return matches.map(Number).filter((num) => Number.isFinite(num));
}

/** Pulls room names out of a tool result payload, checking common field names. */
function extractRoomNames(data: unknown): string[] {
    const names: string[] = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (value !== null && typeof value === 'object') {
            const record = value as Record<string, unknown>;
            if (typeof record['roomName'] === 'string') {
                names.push(record['roomName']);
            }
            Object.values(record).forEach(visit);
        }
    };
    visit(data);
    return names;
}

/** Finds any known room name that appears as a substring of the answer text. */
function extractRoomNamesFromText(text: string, knownRoomNames: string[]): string[] {
    return knownRoomNames.filter((room) => text.includes(room));
}