import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { ChatApiError } from '../types/chat.types';

/**
 * Two separate limits, not one:
 * - PER_IP: protects the shared Gemini/Groq free-tier quota from a
 *   single client hammering the endpoint (accidental refresh loop,
 *   or intentional abuse).
 * - PER_ROLE: a much looser facility-wide ceiling as a last-resort
 *   backstop against total quota exhaustion during a demo with many
 *   concurrent Staff/Admin users — deliberately generous, not meant
 *   to trigger in normal use.
 *
 * Sliding window, not fixed window: avoids the classic edge-case where
 * a fixed window resets exactly as a burst arrives and lets double the
 * intended rate through across the boundary.
 */
const perIpLimiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(10, '30 s'),
    prefix: 'ocutemp:chat:ip',
    analytics: false,
});

const facilityLimiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(200, '60 s'),
    prefix: 'ocutemp:chat:facility',
    analytics: false,
});

export interface RateLimitCheckResult {
    readonly clientIp: string;
}

/**
 * Throws ChatApiError with a 429 status if either limit is exceeded.
 * Call this before any provider request is made its entire purpose
 * is to reject a request before it costs a Gemini or Groq call.
 */
export async function enforceRateLimit(req: Request): Promise<RateLimitCheckResult> {
    const clientIp = extractClientIp(req);

    const [ipResult, facilityResult] = await Promise.all([
        perIpLimiter.limit(clientIp),
        facilityLimiter.limit('facility'),
    ]);

    if (!ipResult.success) {
        throw new ChatApiError(
            'Too many requests from this device. Please wait a moment and try again.',
            429,
        );
    }

    if (!facilityResult.success) {
        throw new ChatApiError(
            'The assistant is receiving a high volume of requests right now. Please try again shortly.',
            429,
        );
    }
    
    return { clientIp };
}

function extractClientIp(req: Request): string {
    const forwardedFor = req.headers.get('x-forwarded-for');
    if (forwardedFor) {
        return forwardedFor.split(',')[0].trim();
    }
    return 'unknown';
}