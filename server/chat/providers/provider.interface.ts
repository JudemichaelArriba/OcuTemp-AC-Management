export type ChatProviderId = 'gemini' | 'groq';

export interface StructuredGenerationRequest {
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly schema: Record<string, unknown>;
    readonly schemaName: string;
    readonly schemaDescription: string;
    readonly maxOutputTokens: number;
    readonly temperature: number;
    readonly timeoutMs: number;
    readonly reasoningEffort?: 'low' | 'medium';
    readonly abortSignal?: AbortSignal;
}

export interface ChatProvider {
    readonly id: ChatProviderId;
    generateStructured<T>(request: StructuredGenerationRequest): Promise<T>;
}

export class ProviderRecoverableError extends Error {
    constructor(
        readonly providerId: ChatProviderId,
        readonly category: 'rate_limit' | 'timeout' | 'unavailable',
        override readonly cause?: unknown,
    ) {
        super(`${providerId} ${category}`);
        this.name = 'ProviderRecoverableError';
    }
}

export class ProviderResponseError extends Error {
    constructor(
        readonly providerId: ChatProviderId,
        override readonly cause?: unknown,
    ) {
        super(`${providerId} returned an invalid response`);
        this.name = 'ProviderResponseError';
    }
}

export function mapProviderError(
    providerId: ChatProviderId,
    error: unknown,
): ProviderRecoverableError | ProviderResponseError {
    const value = error as { statusCode?: number; status?: number; name?: string; message?: string };
    const status = value?.statusCode ?? value?.status;
    const message = `${value?.name ?? ''} ${value?.message ?? ''}`.toLowerCase();

    if (message.includes('abort')) {
        return new ProviderResponseError(providerId, error);
    }
    if (status === 408 || message.includes('timeout')) {
        return new ProviderRecoverableError(providerId, 'timeout', error);
    }
    if (status === 429) {
        return new ProviderRecoverableError(providerId, 'rate_limit', error);
    }
    if (status === 401 || status === 403 || status === 404 || (typeof status === 'number' && status >= 500)) {
        return new ProviderRecoverableError(providerId, 'unavailable', error);
    }
    if (status === undefined && (message.includes('fetch') || message.includes('network'))) {
        return new ProviderRecoverableError(providerId, 'unavailable', error);
    }
    return new ProviderResponseError(providerId, error);
}
