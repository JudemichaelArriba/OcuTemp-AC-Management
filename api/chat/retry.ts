import type { ChatProvider, ProviderGenerateRequest } from './providers/provider.interface';
import { ProviderRateLimitError, ProviderUnavailableError } from './providers/provider.interface';
import type { ProviderGenerateResult, ChatProviderId } from './types/chat.types';

export interface GenerateWithFallbackResult {
    readonly result: ProviderGenerateResult;
    readonly providerUsed: ChatProviderId;
    readonly usedFallback: boolean;
}

/**
 * Calls the primary provider; on a rate-limit or unavailability error,
 * transparently retries the identical request against the fallback
 * provider.
 */
export async function generateWithFallback(
    primary: ChatProvider,
    fallback: ChatProvider,
    request: ProviderGenerateRequest,
): Promise<GenerateWithFallbackResult> {
    try {
        const result = await primary.generate(request);
        return { result, providerUsed: primary.id, usedFallback: false };
    } catch (primaryError: unknown) {
        if (!isRecoverableProviderError(primaryError)) {
            throw primaryError;
        }

        try {
            const result = await fallback.generate(request);
            return { result, providerUsed: fallback.id, usedFallback: true };
        } catch (fallbackError: unknown) {
            throw new BothProvidersFailedError(primaryError, fallbackError);
        }
    }
}

function isRecoverableProviderError(error: unknown): boolean {
    return error instanceof ProviderRateLimitError || error instanceof ProviderUnavailableError;
}

/**
 * Thrown when both the primary and fallback provider fail in the same
 * request cycle. orchestrator.ts should let this surface as a 503 to
 * the client rather than attempting a third provider at that point
 * the honest answer is "the assistant is temporarily unavailable."
 */
export class BothProvidersFailedError extends Error {
    constructor(
        readonly primaryError: unknown,
        readonly fallbackError: unknown,
    ) {
        super('Both primary and fallback providers failed');
        this.name = 'BothProvidersFailedError';
    }
}