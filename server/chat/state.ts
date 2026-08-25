import { CompactEncrypt, compactDecrypt } from 'jose';
import { getChatConfig } from './config.js';
import {
    ANSWERABILITY_OUTCOMES, CHAT_PART_IDS, CHAT_TOOL_NAMES, ENERGY_BUCKETS,
    ENERGY_PRESETS, SYSTEM_DOMAINS, SYSTEM_FIELDS, SYSTEM_OPERATIONS,
    SYSTEM_SCOPE_KINDS,
} from './tools/schema.js';
import type {
    ChatAnswerabilityOutcome, ChatPartId, ChatStateContext, ChatStatePayload,
    ChatStateReferent, ChatStateTurn, ChatToolName, EnergyBucket, EnergyRangePreset,
    SystemDomain, SystemField, SystemOperation, SystemScopeKind,
} from './types/chat.types.js';
import { ChatApiError } from './types/chat.types.js';

export const CHAT_STATE_MAX_TURNS = 5;
export const CHAT_STATE_LIFETIME_SECONDS = 2 * 60 * 60;
export const CHAT_STATE_MAX_TOKEN_BYTES = 12 * 1024;

const STATE_VERSION = 3;
const STATE_TOKEN_TYPE = 'ocutemp-chat-state+jwe';
const CLOCK_TOLERANCE_SECONDS = 30;
const MAX_CONTEXTS_PER_TURN = 3;
const MAX_REFERENTS_PER_TURN = 3;
const MAX_REFERENT_ROOMS = 50;
const MAX_CONTEXT_FIELDS = 8;
const MAX_STATE_TOOLS = 4;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export interface DecodedChatState {
    readonly state: ChatStatePayload | null;
    readonly contextReset: boolean;
}

export async function encodeChatState(
    payload: ChatStatePayload,
    abortSignal?: AbortSignal,
): Promise<string> {
    assertNotAborted(abortSignal);
    const normalized = validateAndNormalizeState(payload, false);
    const key = await deriveUidStateKey(normalized.uid);
    let turns = normalized.turns;

    while (true) {
        assertNotAborted(abortSignal);
        const candidate: ChatStatePayload = { ...normalized, turns };
        const token = await new CompactEncrypt(textEncoder.encode(JSON.stringify(candidate)))
            .setProtectedHeader({
                alg: 'dir', enc: 'A256GCM', typ: STATE_TOKEN_TYPE, v: STATE_VERSION,
            })
            .encrypt(key);
        if (textEncoder.encode(token).byteLength <= CHAT_STATE_MAX_TOKEN_BYTES) return token;
        if (turns.length === 0) throw contextInvalid();
        turns = turns.slice(1);
    }
}

/**
 * Valid v1/v2 tokens are intentionally treated as context resets. Modified,
 * malformed, or UID-bound tokens fail closed instead of being migrated.
 */
export async function decodeChatState(
    token: string | undefined,
    uid: string,
    abortSignal?: AbortSignal,
): Promise<DecodedChatState> {
    assertNotAborted(abortSignal);
    if (token === undefined) return { state: null, contextReset: false };
    if (!token || textEncoder.encode(token).byteLength > CHAT_STATE_MAX_TOKEN_BYTES ||
        token.split('.').length !== 5) throw contextInvalid();

    try {
        const key = await deriveUidStateKey(uid);
        assertNotAborted(abortSignal);
        const { plaintext, protectedHeader } = await compactDecrypt(token, key, {
            keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'],
        });
        assertNotAborted(abortSignal);
        const version = protectedHeader['v'];
        if (protectedHeader.alg !== 'dir' || protectedHeader.enc !== 'A256GCM' ||
            protectedHeader.typ !== STATE_TOKEN_TYPE || ![1, 2, STATE_VERSION].includes(Number(version))) {
            throw contextInvalid();
        }
        const parsed = JSON.parse(textDecoder.decode(plaintext)) as unknown;
        if (version === 1 || version === 2 || isLegacyPayload(parsed)) {
            if (!isRecord(parsed) || parsed['uid'] !== uid) throw contextInvalid();
            return { state: null, contextReset: true };
        }
        const state = validateAndNormalizeState(parsed, true);
        if (state.uid !== uid) throw contextInvalid();
        if (state.expiresAt <= nowSeconds()) return { state: null, contextReset: true };
        return { state, contextReset: false };
    } catch (error: unknown) {
        if (abortSignal?.aborted) throw stateUnavailable(error);
        if (error instanceof ChatApiError) throw error;
        throw contextInvalid(error);
    }
}

function validateAndNormalizeState(value: unknown, allowExpired: boolean): ChatStatePayload {
    if (!isRecord(value) || !hasExactKeys(
        value, ['version', 'uid', 'conversationId', 'issuedAt', 'expiresAt', 'turns'],
    )) throw contextInvalid();
    const uid = value['uid'];
    const conversationId = value['conversationId'];
    const issuedAt = value['issuedAt'];
    const expiresAt = value['expiresAt'];
    const turns = value['turns'];
    const now = nowSeconds();
    if (value['version'] !== STATE_VERSION || typeof uid !== 'string' || !uid || uid.length > 128 ||
        typeof conversationId !== 'string' || !conversationId || conversationId.length > 128 ||
        typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt <= 0 ||
        issuedAt > now + CLOCK_TOLERANCE_SECONDS || typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt ||
        expiresAt - issuedAt > CHAT_STATE_LIFETIME_SECONDS ||
        (!allowExpired && expiresAt <= now) || !Array.isArray(turns) ||
        turns.length > CHAT_STATE_MAX_TURNS) throw contextInvalid();
    return {
        version: 3, uid, conversationId, issuedAt, expiresAt,
        turns: turns.map(normalizeTurn),
    };
}

function normalizeTurn(value: unknown): ChatStateTurn {
    if (!isRecord(value) || !hasExactKeys(value, ['contexts', 'referents']) ||
        !Array.isArray(value['contexts']) || value['contexts'].length < 1 ||
        value['contexts'].length > MAX_CONTEXTS_PER_TURN ||
        !Array.isArray(value['referents']) || value['referents'].length > MAX_REFERENTS_PER_TURN) {
        throw contextInvalid();
    }
    const contexts = value['contexts'].map(normalizeContext);
    const expectedIds = contexts.map((context, index) => CHAT_PART_IDS[index] === context.partId);
    if (expectedIds.some((matches) => !matches)) throw contextInvalid();
    const referents = value['referents'].map(normalizeReferent);
    if (new Set(referents.map((item) => item.sourcePartId)).size !== referents.length ||
        referents.some((item) => !contexts.some((context) => context.partId === item.sourcePartId))) {
        throw contextInvalid();
    }
    return { contexts, referents };
}

function normalizeContext(value: unknown): ChatStateContext {
    const keys = ['partId', 'domain', 'operation', 'fields', 'requestedScope', 'timeRange',
        'toolNames', 'answerability', 'hadVisual'];
    if (!isRecord(value) || !hasExactKeys(value, keys) ||
        typeof value['partId'] !== 'string' || !CHAT_PART_IDS.includes(value['partId'] as ChatPartId) ||
        typeof value['domain'] !== 'string' || !SYSTEM_DOMAINS.includes(value['domain'] as SystemDomain) ||
        typeof value['operation'] !== 'string' ||
        !SYSTEM_OPERATIONS.includes(value['operation'] as SystemOperation) ||
        !Array.isArray(value['fields']) || value['fields'].length < 1 ||
        value['fields'].length > MAX_CONTEXT_FIELDS || !isRecord(value['requestedScope']) ||
        !isRecord(value['timeRange']) || !Array.isArray(value['toolNames']) ||
        value['toolNames'].length > MAX_STATE_TOOLS || typeof value['answerability'] !== 'string' ||
        !ANSWERABILITY_OUTCOMES.includes(value['answerability'] as ChatAnswerabilityOutcome) ||
        typeof value['hadVisual'] !== 'boolean') throw contextInvalid();
    return {
        partId: value['partId'] as ChatPartId,
        domain: value['domain'] as SystemDomain,
        operation: value['operation'] as SystemOperation,
        fields: normalizeEnums(value['fields'], SYSTEM_FIELDS),
        requestedScope: normalizeScope(value['requestedScope']),
        timeRange: normalizeTimeRange(value['timeRange']),
        toolNames: normalizeEnums(value['toolNames'], CHAT_TOOL_NAMES),
        answerability: value['answerability'] as ChatAnswerabilityOutcome,
        hadVisual: value['hadVisual'],
    };
}

function normalizeReferent(value: unknown): ChatStateReferent {
    if (!isRecord(value) || !hasExactKeys(
        value, ['sourcePartId', 'kind', 'roomNames', 'complete', 'ordering'],
    ) || typeof value['sourcePartId'] !== 'string' ||
        !CHAT_PART_IDS.includes(value['sourcePartId'] as ChatPartId) ||
        value['kind'] !== 'room_result' || !Array.isArray(value['roomNames']) ||
        value['roomNames'].length > MAX_REFERENT_ROOMS || typeof value['complete'] !== 'boolean' ||
        !['query', 'ranking'].includes(String(value['ordering']))) throw contextInvalid();
    return {
        sourcePartId: value['sourcePartId'] as ChatPartId,
        kind: 'room_result', roomNames: normalizeRoomNames(value['roomNames']),
        complete: value['complete'], ordering: value['ordering'] as 'query' | 'ranking',
    };
}

function normalizeScope(value: Record<string, unknown>): ChatStateContext['requestedScope'] {
    if (!hasExactKeys(value, ['kind', 'roomNames', 'inventory', 'referencePartId']) ||
        typeof value['kind'] !== 'string' ||
        !SYSTEM_SCOPE_KINDS.includes(value['kind'] as SystemScopeKind) ||
        !Array.isArray(value['roomNames']) || value['roomNames'].length > MAX_REFERENT_ROOMS ||
        !['active', 'inactive', 'all'].includes(String(value['inventory'])) ||
        typeof value['referencePartId'] !== 'string' ||
        !['', ...CHAT_PART_IDS].includes(value['referencePartId'] as ChatPartId)) {
        throw contextInvalid();
    }
    const kind = value['kind'] as ChatStateContext['requestedScope']['kind'];
    const roomNames = normalizeRoomNames(value['roomNames']);
    if (kind === 'named_rooms' && roomNames.length === 0 ||
        kind !== 'named_rooms' && roomNames.length > 0 ||
        kind === 'prior_part' && value['referencePartId'] === '' ||
        kind !== 'prior_part' && value['referencePartId'] !== '') throw contextInvalid();
    return { kind, roomNames,
        inventory: value['inventory'] as ChatStateContext['requestedScope']['inventory'],
        referencePartId: value['referencePartId'] as ChatStateContext['requestedScope']['referencePartId'] };
}

function normalizeTimeRange(value: Record<string, unknown>): ChatStateContext['timeRange'] {
    if (!hasExactKeys(value, ['preset', 'startDate', 'endDate', 'bucket']) ||
        typeof value['preset'] !== 'string' ||
        !ENERGY_PRESETS.includes(value['preset'] as EnergyRangePreset) ||
        typeof value['startDate'] !== 'string' || typeof value['endDate'] !== 'string' ||
        typeof value['bucket'] !== 'string' ||
        !ENERGY_BUCKETS.includes(value['bucket'] as EnergyBucket)) throw contextInvalid();
    const custom = value['preset'] === 'custom';
    if (custom && (!isDate(value['startDate']) || !isDate(value['endDate']) ||
        value['startDate'] > value['endDate']) || !custom &&
        (value['startDate'] !== '' || value['endDate'] !== '')) throw contextInvalid();
    return { preset: value['preset'] as EnergyRangePreset, startDate: value['startDate'],
        endDate: value['endDate'], bucket: value['bucket'] as EnergyBucket };
}

function normalizeRoomNames(values: unknown[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (typeof value !== 'string') throw contextInvalid();
        const name = cleanName(value);
        const key = name.toLocaleLowerCase('en-US');
        if (!name || seen.has(key)) throw contextInvalid();
        seen.add(key);
        result.push(name);
    }
    return result;
}

function normalizeEnums<T extends string>(values: unknown[], allowed: readonly T[]): T[] {
    const result: T[] = [];
    for (const value of values) {
        if (typeof value !== 'string' || !allowed.includes(value as T) ||
            result.includes(value as T)) throw contextInvalid();
        result.push(value as T);
    }
    return result;
}

async function deriveUidStateKey(uid: string): Promise<Uint8Array> {
    if (!uid || uid.length > 128) throw contextInvalid();
    try {
        const secret = await globalThis.crypto.subtle.importKey(
            'raw', new Uint8Array(getChatConfig().stateSecret).buffer, 'HKDF', false,
            ['deriveBits'],
        );
        const bits = await globalThis.crypto.subtle.deriveBits({
            name: 'HKDF', hash: 'SHA-256',
            salt: textEncoder.encode('ocutemp-chat-state:v1'),
            info: textEncoder.encode(uid),
        }, secret, 256);
        return new Uint8Array(bits);
    } catch (error: unknown) {
        throw new ChatApiError('configuration_error', 'Chat state encryption is unavailable.',
            500, undefined, error);
    }
}

function cleanName(value: string): string {
    return Array.from(value.normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, ' ')
        .replace(/\s+/gu, ' ').trim()).slice(0, 100).join('');
}

function isLegacyPayload(value: unknown): boolean {
    return isRecord(value) && (value['version'] === 1 || value['version'] === 2);
}

function isDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nowSeconds(): number { return Math.floor(Date.now() / 1_000); }

function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw stateUnavailable(signal.reason);
}

function stateUnavailable(cause?: unknown): ChatApiError {
    return new ChatApiError('assistant_unavailable', 'Chat state processing timed out.',
        503, undefined, cause);
}

function contextInvalid(cause?: unknown): ChatApiError {
    return new ChatApiError('context_invalid', 'Chat context is invalid.', 400, undefined, cause);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
