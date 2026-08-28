import type { ChatProvider, ChatProviderId, StructuredGenerationRequest } from './providers/provider.interface.js';
import {
    ProviderRecoverableError,
    ProviderRequestError,
    ProviderResponseError,
} from './providers/provider.interface.js';

export interface GenerateWithFallbackResult<T> {
    readonly result: T;
    readonly providerUsed: ChatProviderId;
    readonly usedFallback: boolean;
}

export interface GenerateWithFallbackOptions {
    readonly fallbackTimeoutMs?: number;
    readonly deadlineAtMs?: number;
    readonly reserveMs?: number;
    readonly allowFallback?: boolean;
}

export async function generateWithFallback<T>(
    primary: ChatProvider,
    fallback: ChatProvider,
    request: StructuredGenerationRequest,
    validate?: (result: T) => T,
    options: GenerateWithFallbackOptions = {},
): Promise<GenerateWithFallbackResult<T>> {
    try {
        const primaryRequest = requestForAttempt(primary.id, request, request.timeoutMs, options);
        const result = validateProviderResult(
            primary.id,
            await primary.generateStructured<T>(primaryRequest),
            validate,
        );
        return {
            result,
            providerUsed: primary.id,
            usedFallback: false,
        };
    } catch (primaryError: unknown) {
        if (!(primaryError instanceof ProviderRecoverableError) &&
            !(primaryError instanceof ProviderRequestError) &&
            !(primaryError instanceof ProviderResponseError)) throw primaryError;
        if (request.abortSignal?.aborted) throw primaryError;
        if (options.allowFallback === false) {
            throw new BothProvidersFailedError(primaryError,
                new ProviderRecoverableError(fallback.id, 'timeout'));
        }
        try {
            const fallbackRequest = requestForAttempt(
                fallback.id,
                request,
                options.fallbackTimeoutMs ?? request.timeoutMs,
                options,
            );
            const result = validateProviderResult(
                fallback.id,
                await fallback.generateStructured<T>(fallbackRequest),
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

function requestForAttempt(
    providerId: ChatProviderId,
    request: StructuredGenerationRequest,
    desiredTimeoutMs: number,
    options: GenerateWithFallbackOptions,
): StructuredGenerationRequest {
    const reserveMs = Math.max(0, options.reserveMs ?? 0);
    const remainingMs = options.deadlineAtMs === undefined
        ? desiredTimeoutMs
        : options.deadlineAtMs - Date.now() - reserveMs;
    const timeoutMs = Math.floor(Math.min(desiredTimeoutMs, remainingMs));
    if (timeoutMs < 250) {
        throw new ProviderRecoverableError(providerId, 'timeout');
    }
    return { ...request, timeoutMs };
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
        throw new ProviderResponseError(providerId, 'invalid_semantics', error);
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
