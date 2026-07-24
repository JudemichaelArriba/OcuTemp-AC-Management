import { GeminiProvider } from './providers/gemini.provider';
import { GroqProvider } from './providers/groq.provider';
import { generateWithFallback } from './retry';
import { PLANNER_SYSTEM_PROMPT } from './prompts/planner.prompt';
import { ANSWERER_SYSTEM_PROMPT } from './prompts/answerer.prompt';
import { CHAT_TOOL_SCHEMA, CHAT_TOOL_NAMES } from './tools/schema';
import type { ChatApiRequest, ChatApiResponse } from './types/chat.types';
import { ChatApiError } from './types/chat.types';

const geminiProvider = new GeminiProvider();
const groqProvider = new GroqProvider();

/**
 * Runs one turn of the chat pipeline. Which step runs  planning or
 * answering is inferred from the conversation itself, not passed in
 * explicitly: if the most recent message is a tool result, this is the
 * answering step; otherwise it's the planning step.
 *
 * This function does not execute tools. It only ever decides whether
 * one should be called, or produces the final natural-language answer
 * once chat.service.ts has already run the tool and appended its
 * result to the conversation.
 */
export async function runChatTurn(request: ChatApiRequest): Promise<ChatApiResponse> {
    const lastMessage = request.messages[request.messages.length - 1];
    const isAnsweringStep = lastMessage?.role === 'function';

    const { result, providerUsed, usedFallback } = await generateWithFallback(
        geminiProvider,
        groqProvider,
        {
            messages: request.messages,
            systemPrompt: isAnsweringStep ? ANSWERER_SYSTEM_PROMPT : PLANNER_SYSTEM_PROMPT,
            toolSchema: isAnsweringStep ? undefined : CHAT_TOOL_SCHEMA,
        },
    );

    if (usedFallback) {

        console.warn('[chat] provider fallback triggered', {
            step: isAnsweringStep ? 'answer' : 'plan',
            providerUsed,
        });
    }

    if (result.toolCall) {
        if (!CHAT_TOOL_NAMES.includes(result.toolCall.name)) {
            throw new ChatApiError(
                `Model requested an unknown tool: ${result.toolCall.name}`,
                502,
            );
        }

        return {
            toolCall: result.toolCall,
            providerUsed,
            usedFallback,
        };
    }

    if (!result.answer) {
        throw new ChatApiError('Provider returned neither a tool call nor an answer', 502);
    }

    return {
        answer: result.answer,
        providerUsed,
        usedFallback,
    };
}