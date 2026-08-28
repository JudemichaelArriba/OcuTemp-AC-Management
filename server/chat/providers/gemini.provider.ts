import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, jsonSchema, Output } from 'ai';
import type { ChatProvider, StructuredGenerationRequest } from './provider.interface.js';
import { mapProviderError, ProviderRecoverableError } from './provider.interface.js';

declare const process: { env: Record<string, string | undefined> };

const GEMINI_MODEL_ID = 'gemini-3.1-flash-lite';

export class GeminiProvider implements ChatProvider {
    readonly id = 'gemini' as const;

    async generateStructured<T>(request: StructuredGenerationRequest): Promise<T> {
        const apiKey = process.env['GOOGLE_GENERATIVE_AI_API_KEY']?.trim();
        if (!apiKey) throw new ProviderRecoverableError(this.id, 'unavailable');

        const google = createGoogleGenerativeAI({ apiKey });
        try {
            const result = await generateText({
                model: google(GEMINI_MODEL_ID),
                system: request.systemPrompt,
                prompt: request.prompt,
                output: Output.object<T>({
                    schema: jsonSchema<T>(request.schema as never),
                    name: request.schemaName,
                    description: request.schemaDescription,
                }),
                maxOutputTokens: request.maxOutputTokens,
                maxRetries: 0,
                timeout: { totalMs: request.timeoutMs },
                abortSignal: request.abortSignal,
            });
            return result.output;
        } catch (error: unknown) {
            throw mapProviderError(this.id, error);
        }
    }
}
