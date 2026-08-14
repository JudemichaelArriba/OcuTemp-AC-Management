import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import { getChatConfig } from '../config.js';
import { FirebaseRestClient } from '../firebase-rest.js';
import type { AuthenticatedChatUser, ChatUserRole } from '../types/chat.types.js';
import { ChatApiError } from '../types/chat.types.js';

const GOOGLE_FIREBASE_JWKS_URL = new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
);
const MAX_AUTHORIZATION_HEADER_BYTES = 16 * 1024;
const CLOCK_TOLERANCE_SECONDS = 5;

const firebaseSigningKeys = createRemoteJWKSet(GOOGLE_FIREBASE_JWKS_URL, {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 6 * 60 * 60 * 1_000,
});

/**
 * Verifies the Firebase ID token and authorizes the account using the user's
 * own Realtime Database token. Firebase Admin SDK and Cloud Functions are not used.
 */
export async function authenticateChatRequest(
    request: Request,
    abortSignal?: AbortSignal,
): Promise<AuthenticatedChatUser> {
    const idToken = extractBearerToken(request);
    const config = getChatConfig();
    const claims = await verifyFirebaseIdToken(
        idToken,
        config.firebaseProjectId,
        abortSignal,
    );
    const uid = claims.sub as string;

    const firebase = new FirebaseRestClient({
        databaseUrl: config.firebaseDatabaseUrl,
        idToken,
        abortSignal,
    });

    let profile: Record<string, unknown> | null;
    try {
        profile = await firebase.getUserProfile(uid);
    } catch (error: unknown) {
        if (error instanceof ChatApiError && error.code === 'configuration_error') {
            throw error;
        }
        if (
            error instanceof ChatApiError &&
            (error.code === 'authentication_required' ||
                error.code === 'account_not_authorized')
        ) {
            throw error;
        }
        throw new ChatApiError(
            'data_unavailable',
            'Account authorization is temporarily unavailable.',
            503,
            undefined,
            error,
        );
    }

    if (!profile) {
        throw accountNotAuthorized();
    }

    const role = profile['role'];
    const approved = profile['approved'];
    if (!isChatUserRole(role) || approved !== true) {
        throw accountNotAuthorized();
    }

    const emailVerified = claims['email_verified'] as boolean;
    if (role !== 'admin' && !emailVerified) {
        throw new ChatApiError(
            'account_not_authorized',
            'Please verify your email before using the assistant.',
            403,
        );
    }

    return {
        uid,
        role,
        approved: true,
        emailVerified,
        idToken,
    };
}

export function extractBearerToken(request: Request): string {
    const authorization = request.headers.get('authorization');
    if (
        !authorization ||
        authorization.length > MAX_AUTHORIZATION_HEADER_BYTES ||
        !authorization.startsWith('Bearer ')
    ) {
        throw authenticationRequired();
    }

    const token = authorization.slice('Bearer '.length);
    if (!token || token.trim() !== token || /\s/.test(token)) {
        throw authenticationRequired();
    }
    return token;
}

async function verifyFirebaseIdToken(
    idToken: string,
    projectId: string,
    abortSignal?: AbortSignal,
): Promise<JWTPayload> {
    const expectedIssuer = `https://securetoken.google.com/${projectId}`;

    try {
        if (abortSignal?.aborted) {
            throw requestDeadlineExceeded();
        }
        const { payload } = await raceAgainstAbort(
            jwtVerify(idToken, firebaseSigningKeys, {
                algorithms: ['RS256'],
                issuer: expectedIssuer,
                audience: projectId,
                clockTolerance: CLOCK_TOLERANCE_SECONDS,
            }),
            abortSignal,
        );
        assertRequiredFirebaseClaims(payload, projectId, expectedIssuer);
        return payload;
    } catch (error: unknown) {
        if (error instanceof ChatApiError) {
            throw error;
        }
        if (isSigningKeyInfrastructureFailure(error)) {
            throw new ChatApiError(
                'assistant_unavailable',
                'Firebase session verification is temporarily unavailable.',
                503,
            );
        }
        throw new ChatApiError(
            'authentication_required',
            'Your Firebase session is invalid or has expired.',
            401,
        );
    }
}

async function raceAgainstAbort<T>(
    operation: Promise<T>,
    abortSignal?: AbortSignal,
): Promise<T> {
    if (!abortSignal) {
        return operation;
    }
    if (abortSignal.aborted) {
        throw requestDeadlineExceeded();
    }

    let abortHandler: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        abortHandler = () => reject(requestDeadlineExceeded());
        abortSignal.addEventListener('abort', abortHandler, { once: true });
    });

    try {
        return await Promise.race([operation, aborted]);
    } finally {
        if (abortHandler) {
            abortSignal.removeEventListener('abort', abortHandler);
        }
    }
}

function isSigningKeyInfrastructureFailure(error: unknown): boolean {
    return (
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        error instanceof errors.JWKInvalid ||
        (error instanceof errors.JOSEError && error.code === 'ERR_JOSE_GENERIC') ||
        !(error instanceof errors.JOSEError)
    );
}

function assertRequiredFirebaseClaims(
    payload: JWTPayload,
    projectId: string,
    expectedIssuer: string,
): void {
    const now = Math.floor(Date.now() / 1_000);
    const authTime = payload['auth_time'];
    const userId = payload['user_id'];
    const emailVerified = payload['email_verified'];

    if (
        typeof payload.sub !== 'string' ||
        payload.sub.length < 1 ||
        payload.sub.length > 128 ||
        payload.iss !== expectedIssuer ||
        payload.aud !== projectId ||
        typeof payload.iat !== 'number' ||
        !Number.isSafeInteger(payload.iat) ||
        payload.iat > now + CLOCK_TOLERANCE_SECONDS ||
        typeof payload.exp !== 'number' ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp <= now - CLOCK_TOLERANCE_SECONDS ||
        typeof authTime !== 'number' ||
        !Number.isSafeInteger(authTime) ||
        authTime <= 0 ||
        authTime > now + CLOCK_TOLERANCE_SECONDS ||
        authTime > payload.iat + CLOCK_TOLERANCE_SECONDS ||
        typeof emailVerified !== 'boolean' ||
        (userId !== undefined && userId !== payload.sub)
    ) {
        throw authenticationRequired();
    }
}

function isChatUserRole(value: unknown): value is ChatUserRole {
    return value === 'staff' || value === 'admin';
}

function authenticationRequired(): ChatApiError {
    return new ChatApiError(
        'authentication_required',
        'A verified Firebase session is required.',
        401,
    );
}

function accountNotAuthorized(): ChatApiError {
    return new ChatApiError(
        'account_not_authorized',
        'Your account is not approved to use the assistant.',
        403,
    );
}

function requestDeadlineExceeded(): ChatApiError {
    return new ChatApiError(
        'assistant_unavailable',
        'The assistant request took too long. Please try again.',
        503,
    );
}
