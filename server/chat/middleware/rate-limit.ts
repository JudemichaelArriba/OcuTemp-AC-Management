import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { getUpstashConfig } from '../config';
import { ChatApiError } from '../types/chat.types';

const REDIS_ADMISSION_TIMEOUT_MS = 4_000;
const REDIS_RELEASE_TIMEOUT_MS = 600;
const CONCURRENCY_LEASE_MS = 30_000;

interface Limiters {
    readonly redis: Redis;
    readonly preAuthIp: RateLimiter;
    readonly uidBurst: RateLimiter;
    readonly uidMinute: RateLimiter;
    readonly uidHour: RateLimiter;
    readonly facilityMinute: RateLimiter;
}

interface RateLimiter {
    limit(identifier: string): Promise<{
        readonly success: boolean;
        readonly reset: number;
        readonly reason?: string;
    }>;
}

export interface PreAuthRateLimitResult {
    readonly clientIp: string;
}

export interface AuthenticatedRateLimitLease {
    release(): Promise<void>;
}

let cachedLimiters: Limiters | undefined;

/** Debits the inexpensive pre-auth IP limit before token verification. */
export async function enforcePreAuthRateLimit(
    request: Request,
    abortSignal?: AbortSignal,
): Promise<PreAuthRateLimitResult> {
    const clientIp = extractClientIp(request);
    const { preAuthIp } = getLimiters();
    await debitLimit(
        preAuthIp,
        clientIp,
        'Too many sign-in attempts from this connection. Please wait and try again.',
        abortSignal,
    );
    return { clientIp };
}

/**
 * Debits limits sequentially in strictest/user-first order, then acquires a
 * distributed one-request-per-UID lease. Every Redis error fails closed.
 */
export async function acquireAuthenticatedLimits(
    uid: string,
    abortSignal?: AbortSignal,
): Promise<AuthenticatedRateLimitLease> {
    if (!uid || uid.length > 128) {
        throw new ChatApiError('authentication_required', 'A valid session is required.', 401);
    }

    const limiters = getLimiters();
    await debitLimit(
        limiters.uidBurst,
        uid,
        'Please wait a few seconds before sending another message.',
        abortSignal,
    );
    await debitLimit(
        limiters.uidMinute,
        uid,
        'You have sent too many messages this minute. Please wait and try again.',
        abortSignal,
    );
    await debitLimit(
        limiters.uidHour,
        uid,
        'You have reached the hourly assistant limit. Please try again later.',
        abortSignal,
    );
    const lease = await acquireConcurrencyLease(limiters.redis, uid, abortSignal);
    try {
        await debitLimit(
            limiters.facilityMinute,
            'facility',
            'The assistant is busy for this facility. Please try again shortly.',
            abortSignal,
        );
        return lease;
    } catch (error: unknown) {
        await lease.release();
        throw error;
    }
}

/** Backward-compatible name for the old pre-auth-only middleware import. */
export const enforceRateLimit = enforcePreAuthRateLimit;

export function extractClientIp(request: Request): string {
    const forwardedHeader = [
        request.headers.get('x-vercel-forwarded-for'),
        request.headers.get('x-forwarded-for'),
        request.headers.get('x-real-ip'),
    ].find((value) => value !== null);

    const candidate = forwardedHeader?.split(',', 1)[0]?.trim();
    return candidate ? normalizeIpAddress(candidate) ?? 'unknown' : 'unknown';
}

function normalizeIpAddress(candidate: string): string | null {
    if (candidate.length > 64) {
        return null;
    }

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) {
        const octets = candidate.split('.').map(Number);
        return octets.every((octet) => Number.isInteger(octet) && octet <= 255)
            ? octets.join('.')
            : null;
    }

    if (candidate.includes(':') && /^[0-9a-fA-F:.]+$/.test(candidate)) {
        try {
            const hostname = new URL(`http://[${candidate}]/`).hostname;
            return hostname.slice(1, -1).toLowerCase();
        } catch {
            return null;
        }
    }
    return null;
}

function getLimiters(): Limiters {
    if (cachedLimiters) {
        return cachedLimiters;
    }

    const config = getUpstashConfig();
    const redis = new Redis({ url: config.url, token: config.token });
    const sharedOptions = {
        redis,
        analytics: false,
        timeout: 0,
        ephemeralCache: false as const,
    };

    cachedLimiters = {
        redis,
        preAuthIp: new Ratelimit({
            ...sharedOptions,
            limiter: Ratelimit.slidingWindow(30, '1 m'),
            prefix: 'ocutemp:chat:v2:preauth-ip',
        }),
        uidBurst: new Ratelimit({
            ...sharedOptions,
            limiter: Ratelimit.slidingWindow(3, '10 s'),
            prefix: 'ocutemp:chat:v2:uid-10s',
        }),
        uidMinute: new Ratelimit({
            ...sharedOptions,
            limiter: Ratelimit.slidingWindow(6, '1 m'),
            prefix: 'ocutemp:chat:v2:uid-minute',
        }),
        uidHour: new Ratelimit({
            ...sharedOptions,
            limiter: Ratelimit.slidingWindow(60, '1 h'),
            prefix: 'ocutemp:chat:v2:uid-hour',
        }),
        facilityMinute: new Ratelimit({
            ...sharedOptions,
            limiter: Ratelimit.slidingWindow(120, '1 m'),
            prefix: 'ocutemp:chat:v2:facility-minute',
        }),
    };
    return cachedLimiters;
}

async function debitLimit(
    limiter: RateLimiter,
    identifier: string,
    rejectionMessage: string,
    abortSignal?: AbortSignal,
): Promise<void> {
    try {
        throwIfAborted(abortSignal);
        const result = await withAdmissionTimeout(
            limiter.limit(identifier),
            abortSignal,
        );
        if (result.reason === 'timeout') {
            throw rateLimitInfrastructureError();
        }
        if (!result.success) {
            const retryAfterSeconds = Math.max(
                1,
                Math.min(3_600, Math.ceil((result.reset - Date.now()) / 1_000)),
            );
            throw new ChatApiError(
                'rate_limited',
                rejectionMessage,
                429,
                retryAfterSeconds,
            );
        }
    } catch (error: unknown) {
        if (error instanceof ChatApiError) {
            throw error;
        }
        throw rateLimitInfrastructureError(error);
    }
}

async function acquireConcurrencyLease(
    redis: Redis,
    uid: string,
    abortSignal?: AbortSignal,
): Promise<AuthenticatedRateLimitLease> {
    const key = `ocutemp:chat:v2:concurrency:${uid}`;
    const owner = globalThis.crypto.randomUUID();

    try {
        throwIfAborted(abortSignal);
        const acquired = await withAdmissionTimeout(
            redis.set(key, owner, { nx: true, px: CONCURRENCY_LEASE_MS }),
            abortSignal,
        );
        if (acquired !== 'OK') {
            throw new ChatApiError(
                'rate_limited',
                'Your previous assistant request is still running. Please wait for it to finish.',
                429,
                2,
            );
        }
    } catch (error: unknown) {
        if (error instanceof ChatApiError) {
            throw error;
        }
        throw rateLimitInfrastructureError(error);
    }

    let released = false;
    return {
        async release(): Promise<void> {
            if (released) {
                return;
            }
            released = true;
            try {
                await withAdmissionTimeout(
                    redis.eval<string[], number>(
                        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                        [key],
                        [owner],
                    ),
                    undefined,
                    REDIS_RELEASE_TIMEOUT_MS,
                );
            } catch {
                // The ownership-checked lease expires automatically; cleanup must not
                // replace an otherwise valid chat response with an infrastructure error.
            }
        },
    };
}

async function withAdmissionTimeout<T>(
    operation: Promise<T>,
    abortSignal?: AbortSignal,
    timeoutMs = REDIS_ADMISSION_TIMEOUT_MS,
): Promise<T> {
    throwIfAborted(abortSignal);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
            () => reject(rateLimitInfrastructureError()),
            timeoutMs,
        );
    });
    const aborted = new Promise<never>((_resolve, reject) => {
        if (!abortSignal) {
            return;
        }
        abortHandler = () => reject(requestDeadlineExceeded());
        abortSignal.addEventListener('abort', abortHandler, { once: true });
    });

    try {
        return await Promise.race([operation, timeout, aborted]);
    } finally {
        if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
        }
        if (abortHandler && abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
        }
    }
}

function throwIfAborted(abortSignal?: AbortSignal): void {
    if (abortSignal?.aborted) {
        throw requestDeadlineExceeded();
    }
}

function rateLimitInfrastructureError(cause?: unknown): ChatApiError {
    return new ChatApiError(
        'assistant_unavailable',
        'Assistant request protection is temporarily unavailable. Please try again.',
        503,
        undefined,
        cause,
    );
}

function requestDeadlineExceeded(): ChatApiError {
    return new ChatApiError(
        'assistant_unavailable',
        'The assistant request took too long. Please try again.',
        503,
    );
}
