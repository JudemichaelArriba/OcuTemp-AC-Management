import { ChatApiError } from './types/chat.types';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;
const PROFILE_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DECISION_LOGS = 200;

const ALLOWED_QUERY_PARAMETERS = new Set([
    'orderBy',
    'startAt',
    'endAt',
    'equalTo',
    'limitToFirst',
    'limitToLast',
    'shallow',
    'print',
]);

export type FirebaseRestQuery = Readonly<Record<string, string | number | boolean>>;

export interface FirebaseReadOptions {
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
}

export interface FirebaseRestClientOptions {
    readonly databaseUrl: string;
    readonly idToken: string;
    readonly abortSignal?: AbortSignal;
}

/**
 * Per-request, read-only Firebase Realtime Database REST client.
 * The ID token is never included in an exception or logged URL.
 */
export class FirebaseRestClient {
    private readonly databaseUrl: string;
    private readonly idToken: string;
    private readonly requestAbortSignal: AbortSignal | undefined;
    private roomsSnapshotPromise: Promise<Record<string, unknown>> | undefined;
    private devicesSnapshotPromise: Promise<Record<string, unknown>> | undefined;
    private readonly energyPromises = new Map<string, Promise<Record<string, unknown> | null>>();
    private readonly decisionLogPromises = new Map<number, Promise<Record<string, unknown>>>();

    constructor(options: FirebaseRestClientOptions) {
        this.databaseUrl = validateDatabaseUrl(options.databaseUrl);
        if (!options.idToken || options.idToken.length > 16 * 1024) {
            throw new ChatApiError(
                'authentication_required',
                'A valid Firebase session is required.',
                401,
            );
        }
        this.idToken = options.idToken;
        this.requestAbortSignal = options.abortSignal;
    }

    async read<T = unknown>(
        path: string,
        query: FirebaseRestQuery = {},
        options: FirebaseReadOptions = {},
    ): Promise<T | null> {
        const safePath = encodeFirebasePath(path);
        const requestUrl = new URL(`${this.databaseUrl}/${safePath}.json`);

        for (const [name, value] of Object.entries(query)) {
            if (!ALLOWED_QUERY_PARAMETERS.has(name)) {
                throw new ChatApiError(
                    'invalid_request',
                    'An unsupported Firebase read query was requested.',
                    400,
                );
            }
            requestUrl.searchParams.set(name, String(value));
        }
        requestUrl.searchParams.set('auth', this.idToken);

        const timeoutMs = boundedInteger(options.timeoutMs, 250, 10_000, DEFAULT_TIMEOUT_MS);
        const maxResponseBytes = boundedInteger(
            options.maxResponseBytes,
            1_024,
            DEFAULT_MAX_RESPONSE_BYTES,
            DEFAULT_MAX_RESPONSE_BYTES,
        );
        const abortController = new AbortController();
        const abortFromRequest = (): void => abortController.abort();
        if (this.requestAbortSignal?.aborted) abortController.abort();
        else this.requestAbortSignal?.addEventListener('abort', abortFromRequest, { once: true });
        const timeout = setTimeout(() => abortController.abort(), timeoutMs);

        try {
            const response = await fetch(requestUrl, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal: abortController.signal,
                cache: 'no-store',
                referrerPolicy: 'no-referrer',
                redirect: 'error',
            });

            if (!response.ok) {
                throw firebaseResponseError(response.status);
            }

            const bytes = await readCappedResponse(response, maxResponseBytes);
            let responseText: string;
            try {
                responseText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
                throw unavailableError('Firebase returned an invalid response.');
            }

            try {
                return JSON.parse(responseText) as T | null;
            } catch {
                throw unavailableError('Firebase returned an invalid response.');
            }
        } catch (error: unknown) {
            if (error instanceof ChatApiError) {
                throw error;
            }
            if (abortController.signal.aborted) {
                throw unavailableError('Firebase did not respond in time.');
            }
            // Do not retain the fetch error as a cause: some runtimes include the
            // request URL, whose Firebase auth query contains the user's ID token.
            throw unavailableError('Firebase data is temporarily unavailable.');
        } finally {
            clearTimeout(timeout);
            this.requestAbortSignal?.removeEventListener('abort', abortFromRequest);
        }
    }

    getRooms(): Promise<Record<string, unknown>> {
        this.roomsSnapshotPromise ??= this.readRecordSnapshot('rooms');
        return this.roomsSnapshotPromise;
    }

    getDevices(): Promise<Record<string, unknown>> {
        this.devicesSnapshotPromise ??= this.readRecordSnapshot('devices');
        return this.devicesSnapshotPromise;
    }

    getEnergyForDevice(
        deviceId: string,
        startDate?: string,
        endDate?: string,
    ): Promise<Record<string, unknown> | null> {
        assertFirebaseKey(deviceId, 'device ID');
        assertOptionalDateKey(startDate, 'energy start date');
        assertOptionalDateKey(endDate, 'energy end date');
        if (startDate && endDate && startDate > endDate) {
            throw new ChatApiError(
                'invalid_request',
                'Energy start date must not be after the end date.',
                400,
            );
        }

        const cacheKey = JSON.stringify([deviceId, startDate ?? null, endDate ?? null]);
        const cached = this.energyPromises.get(cacheKey);
        if (cached) {
            return cached;
        }

        const promise = this.loadEnergyForDevice(deviceId, startDate, endDate);
        this.energyPromises.set(cacheKey, promise);
        return promise;
    }

    getLatestDecisionLogs(limit = 100): Promise<Record<string, unknown>> {
        const boundedLimit = boundedInteger(limit, 1, MAX_DECISION_LOGS, 100);
        const cached = this.decisionLogPromises.get(boundedLimit);
        if (cached) {
            return cached;
        }

        const promise = this.readRecordSnapshot('decisionLogs', {
            orderBy: JSON.stringify('updatedAt'),
            limitToLast: boundedLimit,
        });
        this.decisionLogPromises.set(boundedLimit, promise);
        return promise;
    }

    /** Used only for the small authenticated user profile authorization read. */
    getUserProfile(uid: string): Promise<Record<string, unknown> | null> {
        assertFirebaseKey(uid, 'user ID');
        return this.read<Record<string, unknown>>(`users/${uid}`, {}, {
            timeoutMs: 4_000,
            maxResponseBytes: PROFILE_MAX_RESPONSE_BYTES,
        });
    }

    private async loadEnergyForDevice(
        deviceId: string,
        startDate?: string,
        endDate?: string,
    ): Promise<Record<string, unknown> | null> {
        if (this.devicesSnapshotPromise) {
            const devices = await this.devicesSnapshotPromise;
            const device = devices[deviceId];
            if (!isRecord(device)) {
                return null;
            }
            const energyDaily = device['energyDaily'];
            if (!isRecord(energyDaily)) {
                return null;
            }
            return filterEnergyRange(energyDaily, startDate, endDate);
        }

        const query: Record<string, string> = {};
        if (startDate || endDate) {
            query['orderBy'] = JSON.stringify('$key');
            if (startDate) {
                query['startAt'] = JSON.stringify(startDate);
            }
            if (endDate) {
                query['endAt'] = JSON.stringify(endDate);
            }
        }

        const energyDaily = await this.read<unknown>(
            `devices/${deviceId}/energyDaily`,
            query,
        );
        if (energyDaily === null) {
            return null;
        }
        if (!isRecord(energyDaily)) {
            throw unavailableError('Firebase returned an invalid energy snapshot.');
        }
        return energyDaily;
    }

    private async readRecordSnapshot(
        path: string,
        query: FirebaseRestQuery = {},
    ): Promise<Record<string, unknown>> {
        const value = await this.read<unknown>(path, query);
        if (value === null) {
            return {};
        }
        if (!isRecord(value)) {
            throw unavailableError('Firebase returned an invalid data snapshot.');
        }
        return value;
    }
}

function filterEnergyRange(
    energyDaily: Record<string, unknown>,
    startDate?: string,
    endDate?: string,
): Record<string, unknown> {
    if (!startDate && !endDate) {
        return energyDaily;
    }

    return Object.fromEntries(
        Object.entries(energyDaily).filter(
            ([dateKey]) =>
                (!startDate || dateKey >= startDate) && (!endDate || dateKey <= endDate),
        ),
    );
}

async function readCappedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw facilityTooLargeError();
    }

    if (!response.body) {
        throw unavailableError('Firebase returned an empty response.');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            byteLength += value.byteLength;
            if (byteLength > maximumBytes) {
                await reader.cancel().catch(() => undefined);
                throw facilityTooLargeError();
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const result = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

function encodeFirebasePath(path: string): string {
    const segments = path.split('/');
    if (segments.length === 0 || segments.length > 8 || segments.some((segment) => !segment)) {
        throw new ChatApiError('invalid_request', 'Invalid Firebase read path.', 400);
    }
    for (const segment of segments) {
        assertFirebaseKey(segment, 'path segment');
    }
    return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function assertFirebaseKey(value: string, label: string): void {
    if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > 768 ||
        /[.#$\[\]/\u0000-\u001f\u007f]/.test(value)
    ) {
        throw new ChatApiError('invalid_request', `Invalid Firebase ${label}.`, 400);
    }
}

function assertOptionalDateKey(value: string | undefined, label: string): void {
    if (value === undefined) {
        return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isCalendarDate(value)) {
        throw new ChatApiError('invalid_request', `Invalid Firebase ${label}.`, 400);
    }
}

function isCalendarDate(value: string): boolean {
    const [yearText, monthText, dayText] = value.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function validateDatabaseUrl(rawUrl: string): string {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new ChatApiError('configuration_error', 'Firebase is not configured.', 500);
    }
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        (url.pathname !== '/' && url.pathname !== '') ||
        url.search ||
        url.hash
    ) {
        throw new ChatApiError('configuration_error', 'Firebase is not configured safely.', 500);
    }
    return url.toString().replace(/\/$/, '');
}

function boundedInteger(
    value: number | undefined,
    minimum: number,
    maximum: number,
    fallback: number,
): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isInteger(value)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, value));
}

function firebaseResponseError(status: number): ChatApiError {
    if (status === 401) {
        return new ChatApiError(
            'authentication_required',
            'Your Firebase session is no longer valid.',
            401,
        );
    }
    if (status === 403) {
        return new ChatApiError(
            'account_not_authorized',
            'Your account is not allowed to read assistant data.',
            403,
        );
    }
    return unavailableError('Firebase data is temporarily unavailable.');
}

function facilityTooLargeError(): ChatApiError {
    return new ChatApiError(
        'facility_too_large',
        'The facility snapshot is too large to process safely.',
        413,
    );
}

function unavailableError(message: string): ChatApiError {
    return new ChatApiError('data_unavailable', message, 503);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
