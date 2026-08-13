import { CompactEncrypt, compactDecrypt } from 'jose';
import { getChatConfig } from './config';
import type { ChatStatePayload, ChatStateTurn } from './types/chat.types';
import { ChatApiError } from './types/chat.types';

export const CHAT_STATE_MAX_TURNS = 5;
export const CHAT_STATE_LIFETIME_SECONDS = 2 * 60 * 60;
export const CHAT_STATE_MAX_TOKEN_BYTES = 12 * 1024;

const MAX_USER_TURN_CHARACTERS = 500;
const MAX_ASSISTANT_TURN_CHARACTERS = 1_200;
const CLOCK_TOLERANCE_SECONDS = 30;
const STATE_TOKEN_TYPE = 'ocutemp-chat-state+jwe';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export interface DecodedChatState {
    readonly state: ChatStatePayload | null;
    readonly contextReset: boolean;
}

/** Encrypts compact, bounded state with a key derived specifically for its UID. */
export async function encodeChatState(payload: ChatStatePayload): Promise<string> {
    const normalized = validateAndNormalizeState(payload, false);
    const key = await deriveUidStateKey(normalized.uid);
    let turns = normalized.turns;

    while (true) {
        const candidate: ChatStatePayload = { ...normalized, turns };
        const plaintext = textEncoder.encode(JSON.stringify(candidate));
        const token = await new CompactEncrypt(plaintext)
            .setProtectedHeader({
                alg: 'dir',
                enc: 'A256GCM',
                typ: STATE_TOKEN_TYPE,
                v: 1,
            })
            .encrypt(key);

        if (textEncoder.encode(token).byteLength <= CHAT_STATE_MAX_TOKEN_BYTES) {
            return token;
        }
        if (turns.length === 0) {
            throw contextInvalid('Chat state could not be encoded within the safe size limit.');
        }
        turns = turns.slice(1);
    }
}

/**
 * Decrypts state for the authenticated UID. A valid expired token resets context;
 * malformed, modified, or cross-user tokens are rejected.
 */
export async function decodeChatState(
    token: string | undefined,
    uid: string,
): Promise<DecodedChatState> {
    if (token === undefined) {
        return { state: null, contextReset: false };
    }
    if (
        !token ||
        textEncoder.encode(token).byteLength > CHAT_STATE_MAX_TOKEN_BYTES ||
        token.split('.').length !== 5
    ) {
        throw contextInvalid();
    }

    try {
        const key = await deriveUidStateKey(uid);
        const { plaintext, protectedHeader } = await compactDecrypt(token, key, {
            keyManagementAlgorithms: ['dir'],
            contentEncryptionAlgorithms: ['A256GCM'],
        });

        if (
            protectedHeader.alg !== 'dir' ||
            protectedHeader.enc !== 'A256GCM' ||
            protectedHeader.typ !== STATE_TOKEN_TYPE ||
            protectedHeader['v'] !== 1
        ) {
            throw contextInvalid();
        }

        const parsed = JSON.parse(textDecoder.decode(plaintext)) as unknown;
        const state = validateAndNormalizeState(parsed, true);
        if (state.uid !== uid) {
            throw contextInvalid();
        }

        const now = Math.floor(Date.now() / 1_000);
        if (state.expiresAt <= now) {
            return { state: null, contextReset: true };
        }
        return { state, contextReset: false };
    } catch (error: unknown) {
        if (error instanceof ChatApiError) {
            throw error;
        }
        throw contextInvalid(undefined, error);
    }
}

function validateAndNormalizeState(value: unknown, allowExpired: boolean): ChatStatePayload {
    if (!isRecord(value)) {
        throw contextInvalid();
    }

    const exactKeys = ['version', 'uid', 'conversationId', 'issuedAt', 'expiresAt', 'turns'];
    const keys = Object.keys(value);
    if (keys.length !== exactKeys.length || keys.some((key) => !exactKeys.includes(key))) {
        throw contextInvalid();
    }

    const version = value['version'];
    const uid = value['uid'];
    const conversationId = value['conversationId'];
    const issuedAt = value['issuedAt'];
    const expiresAt = value['expiresAt'];
    const rawTurns = value['turns'];
    const now = Math.floor(Date.now() / 1_000);

    if (
        version !== 1 ||
        typeof uid !== 'string' ||
        uid.length < 1 ||
        uid.length > 128 ||
        typeof conversationId !== 'string' ||
        conversationId.length < 1 ||
        conversationId.length > 128 ||
        typeof issuedAt !== 'number' ||
        !Number.isSafeInteger(issuedAt) ||
        typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt) ||
        issuedAt <= 0 ||
        issuedAt > now + CLOCK_TOLERANCE_SECONDS ||
        expiresAt <= issuedAt ||
        expiresAt - issuedAt > CHAT_STATE_LIFETIME_SECONDS ||
        (!allowExpired && expiresAt <= now) ||
        !Array.isArray(rawTurns) ||
        rawTurns.length > CHAT_STATE_MAX_TURNS
    ) {
        throw contextInvalid();
    }

    const turns = rawTurns.map((turn) => normalizeTurn(turn));
    return {
        version: 1,
        uid,
        conversationId,
        issuedAt,
        expiresAt,
        turns,
    };
}

function normalizeTurn(value: unknown): ChatStateTurn {
    if (!isRecord(value)) {
        throw contextInvalid();
    }
    const keys = Object.keys(value);
    if (keys.length !== 2 || !Object.hasOwn(value, 'user') || !Object.hasOwn(value, 'assistant')) {
        throw contextInvalid();
    }

    const user = value['user'];
    const assistant = value['assistant'];
    if (typeof user !== 'string' || typeof assistant !== 'string') {
        throw contextInvalid();
    }

    return {
        user: truncateCharacters(user, MAX_USER_TURN_CHARACTERS),
        assistant: truncateCharacters(assistant, MAX_ASSISTANT_TURN_CHARACTERS),
    };
}

async function deriveUidStateKey(uid: string): Promise<Uint8Array> {
    if (!uid || uid.length > 128) {
        throw contextInvalid();
    }

    const rootSecret = getChatConfig().stateSecret;
    try {
        const secretBytes = new Uint8Array(rootSecret).buffer;
        const importedSecret = await globalThis.crypto.subtle.importKey(
            'raw',
            secretBytes,
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

function truncateCharacters(value: string, maximum: number): string {
    const characters = Array.from(value);
    return characters.length <= maximum ? value : characters.slice(0, maximum).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contextInvalid(message = 'Chat context is invalid.', cause?: unknown): ChatApiError {
    return new ChatApiError('context_invalid', message, 400, undefined, cause);
}
