import { CompactEncrypt, compactDecrypt } from 'jose';
import { getChatConfig } from './config.js';
import {
    CHAT_METRICS,
    CHAT_QUESTION_FOCUSES,
    CHAT_TOOL_NAMES,
} from './tools/schema.js';
import type {
    ChatAnswerabilityOutcome,
    ChatMetric,
    ChatQuestionFocus,
    ChatStateContext,
    ChatStatePayload,
    ChatStateTurn,
    ChatToolName,
    EnergyBucket,
    EnergyRangePreset,
} from './types/chat.types.js';
import { ChatApiError } from './types/chat.types.js';

export const CHAT_STATE_MAX_TURNS = 5;
export const CHAT_STATE_LIFETIME_SECONDS = 2 * 60 * 60;
export const CHAT_STATE_MAX_TOKEN_BYTES = 12 * 1024;

const MAX_USER_TURN_CHARACTERS = 500;
const MAX_ASSISTANT_TURN_CHARACTERS = 1_200;
const MAX_STATE_ROOMS = 50;
const MAX_STATE_TOOLS = 4;
const CLOCK_TOLERANCE_SECONDS = 30;
const STATE_TOKEN_TYPE = 'ocutemp-chat-state+jwe';
const STATE_VERSION = 2;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const ENERGY_PRESETS: readonly EnergyRangePreset[] = [
    'today',
    'this_week',
    'last_week',
    'last_7_days',
    'this_month',
    'last_month',
    'this_year',
    'last_12_months',
    'custom',
];
const ENERGY_BUCKETS: readonly EnergyBucket[] = ['auto', 'day', 'week', 'month', 'year'];
const ANSWERABILITY_OUTCOMES: readonly ChatAnswerabilityOutcome[] = [
    'answerable',
    'partial',
    'room_not_found',
    'room_inactive',
    'room_ambiguous',
    'no_online_reading',
    'no_energy_records',
    'source_unavailable',
    'insufficient_evidence',
    'clarification_required',
    'not_applicable',
];

export interface DecodedChatState {
    readonly state: ChatStatePayload | null;
    readonly contextReset: boolean;
}

/** Encrypts bounded structured context with a key derived specifically for its UID. */
export async function encodeChatState(
    payload: ChatStatePayload,
    abortSignal?: AbortSignal,
): Promise<string> {
    assertNotAborted(abortSignal);
    const normalized = validateAndNormalizeState(payload, false);
    const key = await deriveUidStateKey(normalized.uid);
    assertNotAborted(abortSignal);
    let turns = normalized.turns;

    while (true) {
        const candidate: ChatStatePayload = { ...normalized, turns };
        const token = await new CompactEncrypt(textEncoder.encode(JSON.stringify(candidate)))
            .setProtectedHeader({
                alg: 'dir',
                enc: 'A256GCM',
                typ: STATE_TOKEN_TYPE,
                v: STATE_VERSION,
            })
            .encrypt(key);
        assertNotAborted(abortSignal);

        if (textEncoder.encode(token).byteLength <= CHAT_STATE_MAX_TOKEN_BYTES) return token;
        if (turns.length === 0) {
            throw contextInvalid('Chat state could not be encoded within the safe size limit.');
        }
        turns = turns.slice(1);
    }
}

/**
 * Decrypts state for the authenticated UID. Valid legacy/expired state resets
 * context; malformed, modified, or cross-user state fails closed.
 */
export async function decodeChatState(
    token: string | undefined,
    uid: string,
    abortSignal?: AbortSignal,
): Promise<DecodedChatState> {
    assertNotAborted(abortSignal);
    if (token === undefined) return { state: null, contextReset: false };
    if (!token || textEncoder.encode(token).byteLength > CHAT_STATE_MAX_TOKEN_BYTES ||
        token.split('.').length !== 5) {
        throw contextInvalid();
    }

    try {
        const key = await deriveUidStateKey(uid);
        assertNotAborted(abortSignal);
        const { plaintext, protectedHeader } = await compactDecrypt(token, key, {
            keyManagementAlgorithms: ['dir'],
            contentEncryptionAlgorithms: ['A256GCM'],
        });
        assertNotAborted(abortSignal);
        if (protectedHeader.alg !== 'dir' || protectedHeader.enc !== 'A256GCM' ||
            protectedHeader.typ !== STATE_TOKEN_TYPE ||
            (protectedHeader['v'] !== 1 && protectedHeader['v'] !== STATE_VERSION)) {
            throw contextInvalid();
        }

        const parsed = JSON.parse(textDecoder.decode(plaintext)) as unknown;
        if (protectedHeader['v'] === 1 || (isRecord(parsed) && parsed['version'] === 1)) {
            if (!isRecord(parsed) || parsed['uid'] !== uid) throw contextInvalid();
            return { state: null, contextReset: true };
        }

        const state = validateAndNormalizeState(parsed, true);
        if (state.uid !== uid) throw contextInvalid();
        if (state.expiresAt <= Math.floor(Date.now() / 1_000)) {
            return { state: null, contextReset: true };
        }
        return { state, contextReset: false };
    } catch (error: unknown) {
        if (abortSignal?.aborted) throw stateUnavailable(error);
        if (error instanceof ChatApiError) throw error;
        throw contextInvalid(undefined, error);
    }
}

function validateAndNormalizeState(value: unknown, allowExpired: boolean): ChatStatePayload {
    if (!isRecord(value) || !hasExactKeys(
        value,
        ['version', 'uid', 'conversationId', 'issuedAt', 'expiresAt', 'turns'],
    )) throw contextInvalid();

    const uid = value['uid'];
    const conversationId = value['conversationId'];
    const issuedAt = value['issuedAt'];
    const expiresAt = value['expiresAt'];
    const rawTurns = value['turns'];
    const now = Math.floor(Date.now() / 1_000);
    if (
        value['version'] !== STATE_VERSION ||
        typeof uid !== 'string' || uid.length < 1 || uid.length > 128 ||
        typeof conversationId !== 'string' || conversationId.length < 1 ||
        conversationId.length > 128 ||
        typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) ||
        typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) ||
        issuedAt <= 0 || issuedAt > now + CLOCK_TOLERANCE_SECONDS ||
        expiresAt <= issuedAt || expiresAt - issuedAt > CHAT_STATE_LIFETIME_SECONDS ||
        (!allowExpired && expiresAt <= now) ||
        !Array.isArray(rawTurns) || rawTurns.length > CHAT_STATE_MAX_TURNS
    ) throw contextInvalid();

    return {
        version: STATE_VERSION,
        uid,
        conversationId,
        issuedAt,
        expiresAt,
        turns: rawTurns.map(normalizeTurn),
    };
}

function normalizeTurn(value: unknown): ChatStateTurn {
    if (!isRecord(value) || !hasExactKeys(value, ['user', 'assistant', 'context'])) {
        throw contextInvalid();
    }
    if (typeof value['user'] !== 'string' || typeof value['assistant'] !== 'string') {
        throw contextInvalid();
    }
    return {
        user: sanitizeStateText(value['user'], MAX_USER_TURN_CHARACTERS),
        assistant: sanitizeStateText(value['assistant'], MAX_ASSISTANT_TURN_CHARACTERS),
        context: normalizeContext(value['context']),
    };
}

function normalizeContext(value: unknown): ChatStateContext {
    const keys = [
        'questionFocus',
        'metric',
        'roomNames',
        'allRooms',
        'rangePreset',
        'startDate',
        'endDate',
        'bucket',
        'toolNames',
        'answerability',
        'hadVisual',
    ];
    if (!isRecord(value) || !hasExactKeys(value, keys)) throw contextInvalid();

    const questionFocus = value['questionFocus'];
    const metric = value['metric'];
    const rawRoomNames = value['roomNames'];
    const allRooms = value['allRooms'];
    const rangePreset = value['rangePreset'];
    const startDate = value['startDate'];
    const endDate = value['endDate'];
    const bucket = value['bucket'];
    const rawToolNames = value['toolNames'];
    const answerability = value['answerability'];
    const hadVisual = value['hadVisual'];
    if (
        typeof questionFocus !== 'string' ||
        !CHAT_QUESTION_FOCUSES.includes(questionFocus as ChatQuestionFocus) ||
        typeof metric !== 'string' || !CHAT_METRICS.includes(metric as ChatMetric) ||
        !Array.isArray(rawRoomNames) || rawRoomNames.length > MAX_STATE_ROOMS ||
        typeof allRooms !== 'boolean' ||
        typeof rangePreset !== 'string' ||
        !ENERGY_PRESETS.includes(rangePreset as EnergyRangePreset) ||
        typeof startDate !== 'string' || typeof endDate !== 'string' ||
        typeof bucket !== 'string' || !ENERGY_BUCKETS.includes(bucket as EnergyBucket) ||
        !Array.isArray(rawToolNames) || rawToolNames.length > MAX_STATE_TOOLS ||
        typeof answerability !== 'string' ||
        !ANSWERABILITY_OUTCOMES.includes(answerability as ChatAnswerabilityOutcome) ||
        typeof hadVisual !== 'boolean'
    ) throw contextInvalid();

    const roomNames = uniqueNormalizedText(rawRoomNames, 100);
    if (allRooms && roomNames.length > 0) throw contextInvalid();
    const toolNames = normalizeToolNames(rawToolNames);
    const customRange = rangePreset === 'custom';
    if (customRange) {
        if (!isIsoCalendarDate(startDate) || !isIsoCalendarDate(endDate) || startDate > endDate) {
            throw contextInvalid();
        }
    } else if (startDate !== '' || endDate !== '') {
        throw contextInvalid();
    }

    return {
        questionFocus: questionFocus as ChatQuestionFocus,
        metric: metric as ChatMetric,
        roomNames,
        allRooms,
        rangePreset: rangePreset as EnergyRangePreset,
        startDate,
        endDate,
        bucket: bucket as EnergyBucket,
        toolNames,
        answerability: answerability as ChatAnswerabilityOutcome,
        hadVisual,
    };
}

function normalizeToolNames(values: unknown[]): ChatToolName[] {
    const result: ChatToolName[] = [];
    for (const value of values) {
        if (typeof value !== 'string' || !CHAT_TOOL_NAMES.includes(value as ChatToolName)) {
            throw contextInvalid();
        }
        const tool = value as ChatToolName;
        if (result.includes(tool)) throw contextInvalid();
        result.push(tool);
    }
    return result;
}

function uniqueNormalizedText(values: unknown[], maximum: number): string[] {
    const result: string[] = [];
    const keys = new Set<string>();
    for (const value of values) {
        if (typeof value !== 'string') throw contextInvalid();
        const normalized = sanitizeStateText(value, maximum);
        if (!normalized) throw contextInvalid();
        const key = normalized.toLocaleLowerCase('en-US');
        if (keys.has(key)) throw contextInvalid();
        keys.add(key);
        result.push(normalized);
    }
    return result;
}

async function deriveUidStateKey(uid: string): Promise<Uint8Array> {
    if (!uid || uid.length > 128) throw contextInvalid();
    try {
        const importedSecret = await globalThis.crypto.subtle.importKey(
            'raw',
            new Uint8Array(getChatConfig().stateSecret).buffer,
            'HKDF',
            false,
            ['deriveBits'],
        );
        const bits = await globalThis.crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: textEncoder.encode('ocutemp-chat-state:v1'),
                info: textEncoder.encode(uid),
            },
            importedSecret,
            256,
        );
        return new Uint8Array(bits);
    } catch (error: unknown) {
        throw new ChatApiError(
            'configuration_error',
            'Chat state encryption is unavailable.',
            500,
            undefined,
            error,
        );
    }
}

function sanitizeStateText(value: string, maximum: number): string {
    const redacted = value
        .normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ')
        .replace(/https:\/\/[^\s/]+\.(?:firebaseio\.com|firebasedatabase\.app)(?:\/[^\s]*)?/giu, '[redacted Firebase reference]')
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[redacted token]')
        .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/giu, 'Bearer [redacted]')
        .replace(/\b(?:api[_ -]?key|access[_ -]?token|id[_ -]?token|state[_ -]?token|secret|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
        .replace(/\b(?:users|devices|rooms|decisionLogs|energy|logs)\/[A-Za-z0-9_.~%/-]+/giu, '[redacted internal reference]')
        .replace(/\b(?=[A-Za-z0-9_+/-]{32,}={0,2}(?=$|[\s,;:.!?"'<>]))(?=[A-Za-z0-9_+/-]*[A-Za-z])(?=[A-Za-z0-9_+/-]*\d)[A-Za-z0-9_+/-]{32,}={0,2}/gu, '[redacted opaque value]')
        .replace(/\s+/gu, ' ')
        .trim();
    return Array.from(redacted).slice(0, maximum).join('');
}

function assertNotAborted(abortSignal?: AbortSignal): void {
    if (abortSignal?.aborted) throw stateUnavailable(abortSignal.reason);
}

function stateUnavailable(cause?: unknown): ChatApiError {
    return new ChatApiError(
        'assistant_unavailable',
        'Chat state processing timed out.',
        503,
        undefined,
        cause,
    );
}

function contextInvalid(message = 'Chat context is invalid.', cause?: unknown): ChatApiError {
    return new ChatApiError('context_invalid', message, 400, undefined, cause);
}

function isIsoCalendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
