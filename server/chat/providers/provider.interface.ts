export type ChatProviderId = 'gemini' | 'groq';

export interface StructuredGenerationRequest {
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly schema: Record<string, unknown>;
    readonly schemaName: string;
    readonly schemaDescription: string;
    readonly maxOutputTokens: number;
    readonly temperature?: number;
    readonly timeoutMs: number;
    readonly reasoningEffort?: 'low' | 'medium';
    readonly abortSignal?: AbortSignal;
}

export type ProviderRequestFailureCategory =
    | 'invalid_credentials'
    | 'billing_precondition'
    | 'unsupported_parameter'
    | 'invalid_schema'
    | 'invalid_request';

export type ProviderResponseFailureCategory =
    | 'generated_output_mismatch'
    | 'invalid_semantics';

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
        readonly category: ProviderResponseFailureCategory = 'generated_output_mismatch',
        override readonly cause?: unknown,
    ) {
        super(`${providerId} returned an invalid response`);
        this.name = 'ProviderResponseError';
    }
}

export class ProviderRequestError extends Error {
    constructor(
        readonly providerId: ChatProviderId,
        readonly category: ProviderRequestFailureCategory,
        override readonly cause?: unknown,
    ) {
        super(`${providerId} rejected the generation request`);
        this.name = 'ProviderRequestError';
    }
}

export function mapProviderError(
    providerId: ChatProviderId,
    error: unknown,
): ProviderRecoverableError | ProviderRequestError | ProviderResponseError {
    const value = error as { statusCode?: number; status?: number; name?: string; message?: string };
    const status = value?.statusCode ?? value?.status;
    const message = providerErrorText(error);

    if (message.includes('abort')) {
        return new ProviderRecoverableError(providerId, 'timeout', error);
    }
    if (status === 408 || message.includes('timeout')) {
        return new ProviderRecoverableError(providerId, 'timeout', error);
    }
    if (status === 429) {
        return new ProviderRecoverableError(providerId, 'rate_limit', error);
    }
    if (status === 401 || message.includes('api key not valid') ||
        message.includes('invalid api key') || message.includes('api key expired')) {
        return new ProviderRequestError(providerId, 'invalid_credentials', error);
    }
    if (status === 400 && (message.includes('failed_precondition') ||
        message.includes('enable billing') || message.includes('free tier') ||
        message.includes('billing'))) {
        return new ProviderRequestError(providerId, 'billing_precondition', error);
    }
    if (status === 400 && (message.includes('not supported') ||
        message.includes('unsupported') || message.includes('reasoning_format') ||
        message.includes('reasoning format'))) {
        return new ProviderRequestError(providerId, 'unsupported_parameter', error);
    }
    if (status === 400 && (message.includes('failed_generation') ||
        message.includes('generated json') || message.includes('no object generated'))) {
        return new ProviderResponseError(providerId, 'generated_output_mismatch', error);
    }
    if (status === 400 && (message.includes('response_schema') ||
        message.includes('responseschema') || message.includes('json_schema') ||
        message.includes('json schema') || message.includes('schema'))) {
        return new ProviderRequestError(providerId, 'invalid_schema', error);
    }
    if (status === 400) {
        return new ProviderRequestError(providerId, 'invalid_request', error);
    }
    if (status === 403 || status === 404 || (typeof status === 'number' && status >= 500)) {
        return new ProviderRecoverableError(providerId, 'unavailable', error);
    }
    if (status === undefined && (message.includes('fetch') || message.includes('network'))) {
        return new ProviderRecoverableError(providerId, 'unavailable', error);
    }
    return new ProviderResponseError(providerId, 'generated_output_mismatch', error);
}


function providerErrorText(error: unknown): string {
    if (typeof error !== 'object' || error === null) return '';
    const value = error as {
        readonly name?: unknown;
        readonly message?: unknown;
        readonly responseBody?: unknown;
    };
    return [value.name, value.message, value.responseBody]
        .filter((item): item is string => typeof item === 'string')
        .join(' ')
        .slice(0, 8_000)
        .toLocaleLowerCase('en-US');
}
