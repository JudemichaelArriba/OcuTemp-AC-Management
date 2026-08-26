import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FirebaseRestClient } from './firebase-rest.js';
import { ProviderRecoverableError } from './providers/provider.interface.js';
import type { StructuredGenerationRequest } from './providers/provider.interface.js';
import type {
    ChatPrincipal,
    ChatStatePayload,
    DialoguePlan,
    GroundedAnswerDraft,
} from './types/chat.types.js';

const providerState = vi.hoisted(() => ({
    geminiPlannerUnavailable: false,
    geminiWriterAvailable: false,
    answerPackets: [] as Array<Record<string, unknown>>,
}));

function planForPrompt(prompt: string): DialoguePlan {
    const payload = JSON.parse(prompt) as { untrustedUserMessage?: string };
    const message = payload.untrustedUserMessage?.toLocaleLowerCase('en-US') ?? '';
    if (/\b(?:what|which)\s+device\b.*\broom\s*1\b/u.test(message)) {
        return {
            act: 'ask', clarificationReason: 'none',
            parts: [{
                domain: 'devices', intent: 'list',
                concepts: ['room_name', 'device_status'], roomNames: ['Room 1'],
                helpTopic: '', reference: 'none', referencePartId: '', ordinal: 0,
                freshness: 'current', presentationIntent: 'prose',
            }],
        };
    }
    if (message.includes('which rooms')) {
        return {
            act: 'ask', clarificationReason: 'none',
            parts: [{
                domain: 'ac_control', intent: 'list',
                concepts: ['room_name', 'ac_power', 'device_status'], roomNames: [],
                helpTopic: '', reference: 'none', referencePartId: '', ordinal: 0,
                freshness: 'current', presentationIntent: 'prose',
            }],
        };
    }
    return {
        act: 'follow_up', clarificationReason: 'none',
        parts: [{
            domain: 'devices', intent: 'count', concepts: ['offline_device_count'],
            roomNames: [], helpTopic: '', reference: 'previous_request',
            referencePartId: '', ordinal: 0, freshness: 'current',
            presentationIntent: 'prose',
        }],
    };
}

function writerDraft(prompt: string): GroundedAnswerDraft {
    const payload = JSON.parse(prompt) as {
        answerPacket: { facts: Array<{ id: string }>; previousResult?: { subject?: string } };
    };
    providerState.answerPackets.push(payload.answerPacket as unknown as Record<string, unknown>);
    const causal = payload.answerPacket.facts.find((fact) =>
        fact.id.endsWith('.causal_connectivity'));
    if (!causal || payload.answerPacket.previousResult?.subject !== 'ac_control') {
        throw new Error('missing causal AC context');
    }
    return {
        clauses: [{
            role: 'direct_answer',
            text: 'Yes. Because the refreshed OcuTemp scope still has zero online devices, the previous current AC power-state result was unavailable.',
            evidenceRefs: [causal.id],
        }],
        highlights: [],
    };
}

vi.mock('./providers/gemini.provider.js', () => ({
    GeminiProvider: class {
        readonly id = 'gemini' as const;

        generateStructured<T>(request: StructuredGenerationRequest): Promise<T> {
            if (request.schemaName === 'grounded_answer') {
                if (!providerState.geminiWriterAvailable) {
                    return Promise.reject(new ProviderRecoverableError('gemini', 'unavailable'));
                }
                return Promise.resolve(writerDraft(request.prompt) as T);
            }
            if (providerState.geminiPlannerUnavailable) {
                return Promise.reject(new ProviderRecoverableError('gemini', 'unavailable'));
            }
            return Promise.resolve(planForPrompt(request.prompt) as T);
        }
    },
}));

vi.mock('./providers/groq.provider.js', () => ({
    GroqProvider: class {
        readonly id = 'groq' as const;

        generateStructured<T>(request: StructuredGenerationRequest): Promise<T> {
            if (request.schemaName === 'grounded_answer') {
                return Promise.reject(new ProviderRecoverableError('groq', 'unavailable'));
            }
            return Promise.resolve(planForPrompt(request.prompt) as T);
        }
    },
}));

import { runChatTurn } from './orchestrator.js';

const user: ChatPrincipal = {
    uid: 'integration-user', role: 'admin', approved: true, emailVerified: true,
    fullName: null, email: null,
};

const rooms = {
    room1: { roomName: 'Room 1', status: 'active', device: 'device1' },
    room2: { roomName: 'Room 2', status: 'active', device: 'device2' },
    room3: { roomName: 'Room 3', status: 'active', device: 'device3' },
};
const devices = {
    device1: { status: { lastSeen: '2020-01-01T00:00:00.000Z' }, acState: true },
    device2: { status: { lastSeen: '2020-01-01T00:00:00.000Z' }, acState: false },
    device3: { status: { lastSeen: '2020-01-01T00:00:00.000Z' }, acState: true },
};
const firebase = {
    getRooms: async () => rooms,
    getDevices: async () => devices,
    getDeviceKeys: async () => Object.fromEntries(Object.keys(devices).map((key) => [key, true])),
    getDeviceProjection: async (deviceId: string) =>
        devices[deviceId as keyof typeof devices] ?? null,
} as unknown as FirebaseRestClient;

function stateWithTurns(turns: ChatStatePayload['turns']): ChatStatePayload {
    return {
        version: 5,
        uid: user.uid,
        conversationId: 'chat-integration-conversation',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        turns,
    };
}

async function turn(message: string, state: ChatStatePayload | null) {
    return runChatTurn({
        requestId: `integration-${state?.turns.length ?? 0}`,
        message,
        user,
        state,
        firebase,
        deadlineAtMs: Date.now() + 20_000,
    });
}

afterEach(() => {
    providerState.geminiPlannerUnavailable = false;
    providerState.geminiWriterAvailable = false;
    providerState.answerPackets.length = 0;
});

describe('OcuGuide multi-turn causal context', () => {
    it('preserves the originating AC subject through repeated offline confirmations', async () => {
        const first = await turn('Which rooms currently have their AC on?', null);
        expect(first.responseContexts[0]).toMatchObject({
            domain: 'ac_control', answerability: 'no_online_reading',
        });
        expect(first.stateTurn.results[0]).toMatchObject({
            subject: 'ac_control', emptyReason: 'no_online_reading',
        });

        providerState.geminiWriterAvailable = true;
        const secondState = stateWithTurns([first.stateTurn]);
        const second = await turn('is it beacuse the device is ofline?', secondState);
        expect(second.stateTurn.act).toBe('confirm');
        expect(second.responseContexts[0]?.fields).toContain('online_device_count');
        expect(second.stateTurn.results[0]?.counts).toEqual(expect.arrayContaining([
            { field: 'online_device_count', value: 0 },
            { field: 'offline_device_count', value: 3 },
        ]));
        expect(second.answerParts[0]?.text).toMatch(/^Yes\b/iu);
        expect(second.answerParts[0]?.text).toMatch(/AC power-state result/iu);
        expect(second.displayPlan).toEqual([]);
        expect(providerState.answerPackets.at(-1)?.['previousResult']).toMatchObject({
            subject: 'ac_control', emptyReason: 'no_online_reading',
        });

        providerState.geminiWriterAvailable = false;
        const thirdState = stateWithTurns([first.stateTurn, second.stateTurn]);
        const third = await turn(
            'so it is because of the device being offline then?? yes or no?',
            thirdState,
        );
        expect(third.stateTurn.act).toBe('confirm');
        expect(third.answerParts[0]?.text).toMatch(/^Yes\b/iu);
        expect(third.answerParts[0]?.text).toMatch(/which rooms currently have their AC on/iu);
        expect(third.answerParts[0]?.text).not.toMatch(/temperature|occupancy/iu);
        expect(third.answerParts[0]?.text).not.toMatch(/^Assigned devices offline/iu);
        expect(third.answerParts[0]?.blocks).toEqual([]);
        expect(third.displayPlan).toEqual([]);
    });

    it('uses Groq planning when Gemini planning is unavailable', async () => {
        providerState.geminiPlannerUnavailable = true;
        const result = await turn('Which rooms currently have their AC on?', null);
        expect(result.responseContexts[0]).toMatchObject({
            domain: 'ac_control', answerability: 'no_online_reading',
        });
    });

    it.each([
        'what device is connected to the room 1?',
        'which device is assigned to Room 1?',
        'what device is linked to Room 1?',
    ])('treats "%s" as configured assignment', async (message) => {
        const result = await turn(message, null);
        expect(result.responseContexts[0]).toMatchObject({
            domain: 'rooms', operation: 'detail', answerability: 'answerable',
        });
        expect(result.responseContexts[0]?.fields).toEqual(expect.arrayContaining([
            'room_name', 'device_identifier', 'device_assignment',
        ]));
        expect(result.answerParts[0]?.text).toBe('Room 1 is assigned to device device1.');
        expect(result.answerParts[0]?.text).not.toMatch(/No rooms matched/iu);
        expect(result.displayPlan).toEqual([]);
        expect(JSON.stringify(result.stateTurn)).not.toContain('device1');
    });
});
