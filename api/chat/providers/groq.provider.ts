import { createGroq } from '@ai-sdk/groq';
import { generateText, jsonSchema, tool, type ModelMessage } from 'ai';
import type {
    ChatProvider,
    ProviderGenerateRequest,
    ProviderToolSchema,
} from './provider.interface';
import { ProviderRateLimitError, ProviderUnavailableError } from './provider.interface';
import type { ChatMessage, ChatToolName, ProviderGenerateResult } from '../types/chat.types';

declare const process: { env: Record<string, string | undefined> };

/**
 * Fallback provider, used only when Gemini hits a rate limit or is
 * unavailable see retry.ts. Must support tool calling since it may
 * be substituted mid-conversation for either the planning or answering
 * step.
 */
const GROQ_MODEL_ID = 'llama-3.3-70b-versatile';

const groq = createGroq({
    apiKey: process.env['GROQ_API_KEY'],
});

export class GroqProvider implements ChatProvider {
    readonly id = 'groq' as const;
    private readonly model = groq(GROQ_MODEL_ID);

    supportsTools(): boolean {
        return true;
    }

    async generate(request: ProviderGenerateRequest): Promise<ProviderGenerateResult> {
        try {
            const result = await generateText({
                model: this.model,
                system: request.systemPrompt,
                messages: toModelMessages(request.messages),
                tools: request.toolSchema ? toAiSdkTools(request.toolSchema) : undefined,
            });

            const requestedCall = result.toolCalls?.[0];
            if (requestedCall) {
                return {
                    toolCall: {
                        name: requestedCall.toolName as ChatToolName,
                        args: requestedCall.input as Record<string, unknown>,
                    },
                };
            }

            return { answer: result.text };
        } catch (error: unknown) {
            throw mapGroqError(error);
        }
    }
}

function toAiSdkTools(schema: readonly ProviderToolSchema[]) {
    const tools: Record<string, ReturnType<typeof tool>> = {};
    for (const entry of schema) {
        tools[entry.name] = tool({
            description: entry.description,
            inputSchema: jsonSchema(entry.parameters),
        });
    }
    return tools;
}

/**
 * Same translation logic as gemini.provider.ts's toModelMessages —
 * both providers consume the same ai-sdk v6 ModelMessage[] shape,
 * since both go through the same 'ai' core package.
 */
function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
    return messages.map((msg): ModelMessage => {
        if (msg.role === 'function' && msg.toolResult) {
            return {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: msg.toolResult.name,
                        toolName: msg.toolResult.name,
                        output: { type: 'json', value: msg.toolResult.data as never },
                    },
                ],
            };
        }

        if (msg.role === 'model' && msg.toolCall) {
            return {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: msg.toolCall.name,
                        toolName: msg.toolCall.name,
                        input: msg.toolCall.args,
                    },
                ],
            };
        }

        return {
            role: msg.role === 'model' ? 'assistant' : 'user',
            content: msg.content,
        };
    });
}

function mapGroqError(error: unknown): ProviderRateLimitError | ProviderUnavailableError {
    const status = (error as { status?: number })?.status;
    if (status === 429) {
        return new ProviderRateLimitError('groq', error);
    }
    return new ProviderUnavailableError('groq', error);
}