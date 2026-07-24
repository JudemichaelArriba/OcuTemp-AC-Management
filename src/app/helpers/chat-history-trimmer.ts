import { ChatMessage } from '../models/chat.models';

/**
 * Trims a full conversation down to a token-safe window before it's
 * sent to /api/chat. Two separate concerns, applied in order:
 *
 * 1. Keep only the last N turns (a turn = user message, plus any
 *    model/function messages that resulted from it, plus the final
 *    model answer). Slicing by turn — not raw message count — avoids
 *    ever separating a tool-call message from its matching
 *    tool-result message, which would break the conversation shape
 *    Gemini/Groq expect.
 * 2. Within the retained window, strip the raw tool-call/tool-result
 *    pair out of turns that are already answered and not the most
 *    recent — keeping only the user question and the model's final
 *    text for older turns. Raw telemetry JSON is bulkier than a
 *    sentence of text, so this usually saves more tokens than
 *    trimming turn count alone.
 *
 * This function is only ever used to build the request body sent to
 * /api/chat. It must never be used to derive what's shown on screen —
 * chat.service.ts keeps a separate, untrimmed array for rendering, so
 * a user's own earlier messages never visibly disappear from the UI.
 */

interface ChatTurn {
    readonly messages: ChatMessage[];
}

const DEFAULT_MAX_TURNS = 5;

export function trimChatHistory(
    fullHistory: ChatMessage[],
    maxTurns = DEFAULT_MAX_TURNS,
): ChatMessage[] {
    const turns = groupIntoTurns(fullHistory);
    const recentTurns = turns.slice(-maxTurns);

    return recentTurns.flatMap((turn, index) => {
        const isMostRecentTurn = index === recentTurns.length - 1;
        return isMostRecentTurn ? turn.messages : stripStaleToolPayloads(turn.messages);
    });
}


function groupIntoTurns(messages: ChatMessage[]): ChatTurn[] {
    const turns: ChatTurn[] = [];
    let current: ChatMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'user' && current.length > 0) {
            turns.push({ messages: current });
            current = [];
        }
        current.push(msg);
    }

    if (current.length > 0) {
        turns.push({ messages: current });
    }

    return turns;
}


function stripStaleToolPayloads(turnMessages: ChatMessage[]): ChatMessage[] {
    return turnMessages
        .filter((msg) => msg.role === 'user' || (msg.role === 'model' && !msg.toolCall))
        .map((msg) => ({
            ...msg,
            toolCall: undefined,
            toolResult: undefined,
        }));
}