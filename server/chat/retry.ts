import type { ChatProvider, ChatProviderId, StructuredGenerationRequest } from './providers/provider.interface.js';
import { ProviderRecoverableError, ProviderResponseError } from './providers/provider.interface.js';

export interface GenerateWithFallbackResult<T> {
    readonly result: T;
    readonly providerUsed: ChatProviderId;
    readonly usedFallback: boolean;
}

export async function generateWithFallback<T>(
    primary: ChatProvider,
    fallback: ChatProvider,
    request: StructuredGenerationRequest,
    validate?: (result: T) => T,
): Promise<GenerateWithFallbackResult<T>> {
    try {
        const result = validateProviderResult(
            primary.id,
            await primary.generateStructured<T>(request),
            validate,
        );
        return {
            result,
            providerUsed: primary.id,
            usedFallback: false,
        };
    } catch (primaryError: unknown) {
        if (!(primaryError instanceof ProviderRecoverableError) &&
            !(primaryError instanceof ProviderResponseError)) throw primaryError;
        if (request.abortSignal?.aborted) throw primaryError;
        try {
            const result = validateProviderResult(
                fallback.id,
                await fallback.generateStructured<T>(request),
                validate,
            );
            return {
                result,
                providerUsed: fallback.id,
                usedFallback: true,
            };
        } catch (fallbackError: unknown) {
            throw new BothProvidersFailedError(primaryError, fallbackError);
        }
    }
}

function validateProviderResult<T>(
    providerId: ChatProviderId,
    result: T,
    validate?: (result: T) => T,
): T {
    if (!validate) return result;
    try {
        return validate(result);
    } catch (error: unknown) {
        throw new ProviderResponseError(providerId, error);
    }
}

export class BothProvidersFailedError extends Error {
    constructor(
        readonly primaryError: unknown,
        readonly fallbackError: unknown,
    ) {
        super('Both configured chat providers failed');
        this.name = 'BothProvidersFailedError';
    }
}
