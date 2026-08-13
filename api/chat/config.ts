import { ChatApiError } from './types/chat.types';

declare const process: { env: Record<string, string | undefined> };

const STATE_KEY_BYTES = 32;

export interface ChatRuntimeConfig {
    readonly firebaseProjectId: string;
    readonly firebaseDatabaseUrl: string;
    readonly allowedOrigins: ReadonlySet<string>;
    readonly stateSecret: Uint8Array;
}

export interface UpstashRuntimeConfig {
    readonly url: string;
    readonly token: string;
}

let cachedChatConfig: ChatRuntimeConfig | undefined;
let cachedUpstashConfig: UpstashRuntimeConfig | undefined;

/**
 * Reads and validates the server-only configuration once per warm function instance.
 * Nothing returned by this module is intended to be serialized to the browser.
 */
export function getChatConfig(): ChatRuntimeConfig {
    if (cachedChatConfig) {
        return cachedChatConfig;
    }

    const firebaseProjectId = requiredEnvironmentValue('FIREBASE_PROJECT_ID');
    if (!/^[a-z0-9][a-z0-9-]{4,62}$/.test(firebaseProjectId)) {
        throw configurationError('FIREBASE_PROJECT_ID is invalid.');
    }

    const firebaseDatabaseUrl = normalizeDatabaseUrl(
        requiredEnvironmentValue('FIREBASE_DATABASE_URL'),
    );
    const allowedOrigins = parseAllowedOrigins(
        requiredEnvironmentValue('CHAT_ALLOWED_ORIGINS'),
    );
    const stateSecret = decodeStateSecret(requiredEnvironmentValue('CHAT_STATE_SECRET'));

    cachedChatConfig = Object.freeze({
        firebaseProjectId,
        firebaseDatabaseUrl,
        allowedOrigins,
        stateSecret,
    });
    return cachedChatConfig;
}

/** Upstash credentials are kept separate so authentication does not expose them. */
export function getUpstashConfig(): UpstashRuntimeConfig {
    if (cachedUpstashConfig) {
        return cachedUpstashConfig;
    }

    const rawUrl = requiredEnvironmentValue('UPSTASH_REDIS_REST_URL');
    const token = requiredEnvironmentValue('UPSTASH_REDIS_REST_TOKEN');

    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw configurationError('UPSTASH_REDIS_REST_URL is invalid.');
    }

    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        (url.pathname !== '/' && url.pathname !== '') ||
        url.search ||
        url.hash
    ) {
        throw configurationError('UPSTASH_REDIS_REST_URL must be a plain HTTPS URL.');
    }
    if (token.length > 4_096 || /\s/.test(token)) {
        throw configurationError('UPSTASH_REDIS_REST_TOKEN is invalid.');
    }

    cachedUpstashConfig = Object.freeze({
        url: url.toString().replace(/\/$/, ''),
        token,
    });
    return cachedUpstashConfig;
}

function requiredEnvironmentValue(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw configurationError(`Missing required server environment variable: ${name}.`);
    }
    return value;
}

function normalizeDatabaseUrl(rawValue: string): string {
    let url: URL;
    try {
        url = new URL(rawValue);
    } catch {
        throw configurationError('FIREBASE_DATABASE_URL is invalid.');
    }

    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        (url.pathname !== '/' && url.pathname !== '') ||
        url.search ||
        url.hash
    ) {
        throw configurationError('FIREBASE_DATABASE_URL must be a plain HTTPS URL.');
    }

    return url.toString().replace(/\/$/, '');
}

function parseAllowedOrigins(rawValue: string): ReadonlySet<string> {
    const origins = new Set<string>();

    for (const entry of rawValue.split(',')) {
        const candidate = entry.trim();
        if (!candidate) {
            continue;
        }

        let url: URL;
        try {
            url = new URL(candidate);
        } catch {
            throw configurationError('CHAT_ALLOWED_ORIGINS contains an invalid origin.');
        }

        if (
            !['https:', 'http:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            (url.pathname !== '/' && url.pathname !== '') ||
            url.search ||
            url.hash ||
            candidate.includes('*')
        ) {
            throw configurationError(
                'CHAT_ALLOWED_ORIGINS must contain only exact HTTP(S) origins.',
            );
        }

        if (
            url.protocol === 'http:' &&
            !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ) {
            throw configurationError(
                'CHAT_ALLOWED_ORIGINS permits HTTP only for a local development origin.',
            );
        }

        origins.add(url.origin);
    }

    if (origins.size === 0) {
        throw configurationError('CHAT_ALLOWED_ORIGINS must contain at least one origin.');
    }

    return origins;
}

function decodeStateSecret(encoded: string): Uint8Array {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) {
        throw configurationError('CHAT_STATE_SECRET must be a base64-encoded 32-byte value.');
    }

    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const paddingLength = (4 - (normalized.length % 4)) % 4;
    const padded = `${normalized}${'='.repeat(paddingLength)}`;

    let binary: string;
    try {
        binary = globalThis.atob(padded);
    } catch {
        throw configurationError('CHAT_STATE_SECRET must be valid base64.');
    }

    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== STATE_KEY_BYTES) {
        throw configurationError('CHAT_STATE_SECRET must decode to exactly 32 bytes.');
    }

    return bytes;
}

function configurationError(message: string): ChatApiError {
    return new ChatApiError('configuration_error', message, 500);
}
