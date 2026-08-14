import { createGroq } from '@ai-sdk/groq';
import { generateText, jsonSchema, Output } from 'ai';
import type { ChatProvider, StructuredGenerationRequest } from './provider.interface.js';
import { mapProviderError, ProviderRecoverableError } from './provider.interface.js';

declare const process: { env: Record<string, string | undefined> };

const GROQ_MODEL_ID = 'openai/gpt-oss-120b';

export class GroqProvider implements ChatProvider {
    readonly id = 'groq' as const;

    async generateStructured<T>(request: StructuredGenerationRequest): Promise<T> {
        const apiKey = process.env['GROQ_API_KEY'];
        if (!apiKey) throw new ProviderRecoverableError(this.id, 'unavailable');

        const groq = createGroq({ apiKey });
        try {
            const result = await generateText({
                model: groq(GROQ_MODEL_ID),
                system: request.systemPrompt,
                prompt: request.prompt,
                output: Output.object<T>({
                    schema: jsonSchema<T>(request.schema as never),
                    name: request.schemaName,
                    description: request.schemaDescription,
                }),
                maxOutputTokens: request.maxOutputTokens,
                temperature: request.temperature,
                maxRetries: 0,
                timeout: { totalMs: request.timeoutMs },
                abortSignal: request.abortSignal,
                providerOptions: {
                    groq: {
                        reasoningEffort: request.reasoningEffort ?? 'low',
                        reasoningFormat: 'hidden',
                        structuredOutputs: true,
                        strictJsonSchema: true,
                    },
                },
            });
            return result.output;
        } catch (error: unknown) {
            throw mapProviderError(this.id, error);
        }
    }
}
