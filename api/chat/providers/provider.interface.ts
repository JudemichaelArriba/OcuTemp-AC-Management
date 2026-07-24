import type { ChatMessage, ChatToolName, ProviderGenerateResult } from '../types/chat.types';

/**
 * Contract every LLM provider (Gemini, Groq) must implement.
 * orchestrator.ts and retry.ts depend only on this interface, never on
 * a concrete provider directly. This allows us to add new providers without changing the orchestrator
 * or retry logic, and to fail over between providers on rate limit or outage.
 */
export interface ChatProvider {
    readonly id: 'gemini' | 'groq';

    /**
     * Runs one generation step (planning or answering).
     * Throws ProviderRateLimitError or ProviderUnavailableError on failure 
     * retry.ts inspects the error type to decide whether to fail over.
     */
    generate(request: ProviderGenerateRequest): Promise<ProviderGenerateResult>;

    /** Whether this provider's current model supports function calling. */
    supportsTools(): boolean;
}

export interface ProviderGenerateRequest {
    readonly messages: ChatMessage[];
    readonly systemPrompt: string;
    /** Only attached on the planning step see orchestrator.ts. */
    readonly toolSchema?: readonly ProviderToolSchema[];
}

/**
 * Provider-agnostic tool schema shape. gemini.provider.ts and
 * groq.provider.ts are each responsible for translating this into
 * their own SDK's expected format (they differ slightly).
 */
export interface ProviderToolSchema {
    readonly name: ChatToolName;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
}

/**
 * Thrown by a provider when it hits a rate limit (HTTP 429 equivalent).
 * retry.ts specifically catches this type to trigger provider fail-over.
 */
export class ProviderRateLimitError extends Error {
    constructor(readonly providerId: 'gemini' | 'groq', override readonly cause?: unknown) {
        super(`${providerId} rate limit exceeded`);
        this.name = 'ProviderRateLimitError';
    }
}

/**
 * Thrown by a provider on 5xx / network failure — distinct from rate
 * limiting so retry.ts and logging can distinguish quota exhaustion
 * from genuine outages.
 */
export class ProviderUnavailableError extends Error {
    constructor(readonly providerId: 'gemini' | 'groq', override readonly cause?: unknown) {
        super(`${providerId} is unavailable`);
        this.name = 'ProviderUnavailableError';
    }
}