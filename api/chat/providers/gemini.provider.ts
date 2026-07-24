import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, jsonSchema, tool, type ModelMessage } from 'ai';
import type {
    ChatProvider,
    ProviderGenerateRequest,
    ProviderToolSchema,
} from './provider.interface';
import { ProviderRateLimitError, ProviderUnavailableError } from './provider.interface';
import type { ChatMessage, ChatToolName, ProviderGenerateResult } from '../types/chat.types';

declare const process: { env: Record<string, string | undefined> };


const GEMINI_MODEL_ID = 'gemini-3.1-flash-lite';

const google = createGoogleGenerativeAI({
    apiKey: process.env['GOOGLE_GENERATIVE_AI_API_KEY'],
});

export class GeminiProvider implements ChatProvider {
    readonly id = 'gemini' as const;
    private readonly model = google(GEMINI_MODEL_ID);

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
            throw mapGeminiError(error);
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
 * Translates our provider-agnostic ChatMessage[] into ai-sdk v6's
 * ModelMessage[] shape. 'function' role messages (tool results) become
 * ai-sdk 'tool' role messages, keyed by the tool name they answer.
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

function mapGeminiError(error: unknown): ProviderRateLimitError | ProviderUnavailableError {
    const status = (error as { status?: number })?.status;
    if (status === 429) {
        return new ProviderRateLimitError('gemini', error);
    }
    return new ProviderUnavailableError('gemini', error);
}