import { Injectable, signal } from '@angular/core';
import {
    ChatApiRequest,
    ChatApiResponse,
    ChatMessage,
    ChatRequestError,
    ChatUserRole,
    ChatToolResult,
} from '../models/chat.models';
import { ChatToolsService } from './chat-tools.service';
import { LoggerService } from './logger.service';
import { trimChatHistory } from '../helpers/chat-history-trimmer';
import { validateChatAnswer } from '../helpers/chat-response-validator';

const CHAT_API_ENDPOINT = '/api/chat';
const MAX_TOOL_HOPS_PER_TURN = 1;

export interface RenderableChatMessage {
    readonly id: string;
    readonly role: 'user' | 'assistant';
    readonly text: string;
    readonly isFallback: boolean;
    readonly fallbackData?: unknown;
}

/**
 * Owns chat state and orchestrates one full turn: send user message ->
 * planning request -> optionally execute a tool via ChatToolsService ->
 * answering request -> validate -> expose to the UI.
 *
 * Maintains two separate histories, deliberately:
 * - `fullHistory` (internal): every message, used to build requests and
 *   to render the conversation on screen.
 * - trimmed history (never stored, built fresh per request): only what
 *   gets sent to /api/chat, via chat-history-trimmer.ts. Trimming must
 *   never affect what's rendered see that file's own doc comment.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
    private fullHistory: ChatMessage[] = [];
    private readonly isLoading = signal(false);
    private readonly renderableMessages = signal<RenderableChatMessage[]>([]);

    readonly loading = this.isLoading.asReadonly();
    readonly messages = this.renderableMessages.asReadonly();

    constructor(
        private chatTools: ChatToolsService,
        private logger: LoggerService,
    ) { }

    async sendMessage(text: string, userRole: ChatUserRole): Promise<void> {
        const trimmedText = text.trim();
        if (!trimmedText || this.isLoading()) return;

        const userMessage = this.buildMessage('user', trimmedText);
        this.appendToHistory(userMessage);
        this.appendRenderable({ id: userMessage.id, role: 'user', text: trimmedText, isFallback: false });

        this.isLoading.set(true);
        try {
            await this.runTurn(userRole);
        } catch (err) {
            this.logger.error('Chat turn failed', err, { service: 'ChatService', action: 'sendMessage' });
            this.appendRenderable({
                id: this.generateId(),
                role: 'assistant',
                text: "Something went wrong on my end. Please try again in a moment.",
                isFallback: false,
            });
        } finally {
            this.isLoading.set(false);
        }
    }

    clearConversation(): void {
        this.fullHistory = [];
        this.renderableMessages.set([]);
    }



    private async runTurn(userRole: ChatUserRole, toolHopsUsed = 0): Promise<void> {
        const response = await this.callChatApi(userRole);

        if (response.toolCall) {
            if (toolHopsUsed >= MAX_TOOL_HOPS_PER_TURN) {

                throw new ChatRequestError('Model requested more than one tool call in a single turn');
            }

            const toolCallMessage = this.buildMessage('model', '', { toolCall: response.toolCall });
            this.appendToHistory(toolCallMessage);

            const toolResult = await this.chatTools.executeTool(response.toolCall, userRole);
            const toolResultMessage = this.buildMessage('function', '', { toolResult });
            this.appendToHistory(toolResultMessage);

            return this.runTurn(userRole, toolHopsUsed + 1);
        }

        if (!response.answer) {
            throw new ChatRequestError('Provider returned an empty response');
        }

        const lastToolResult = this.findLastToolResult();
        const validation = validateChatAnswer(response.answer, lastToolResult);

        const answerMessage = this.buildMessage('model', response.answer);
        this.appendToHistory(answerMessage);

        if (!validation.isValid) {
            this.logger.warn('Chat answer failed validation, falling back to raw data', {
                service: 'ChatService',
                reason: validation.reason,
            });
            this.appendRenderable({
                id: answerMessage.id,
                role: 'assistant',
                text: response.answer,
                isFallback: true,
                fallbackData: lastToolResult?.data,
            });
            return;
        }

        this.appendRenderable({
            id: answerMessage.id,
            role: 'assistant',
            text: response.answer,
            isFallback: false,
        });
    }

    private async callChatApi(userRole: ChatUserRole): Promise<ChatApiResponse> {
        const requestBody: ChatApiRequest = {
            messages: trimChatHistory(this.fullHistory),
            userRole,
        };

        let httpResponse: Response;
        try {
            httpResponse = await fetch(CHAT_API_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });
        } catch (err) {
            throw new ChatRequestError('Network error contacting chat service', err);
        }

        if (!httpResponse.ok) {
            const errorBody = await this.safeParseJson(httpResponse);
            throw new ChatRequestError(
                (errorBody as { error?: string })?.error ?? `Chat service returned ${httpResponse.status}`,
            );
        }

        return httpResponse.json() as Promise<ChatApiResponse>;
    }


    private findLastToolResult(): ChatToolResult | null {
        for (let i = this.fullHistory.length - 1; i >= 0; i--) {
            const msg = this.fullHistory[i];
            if (msg.role === 'function' && msg.toolResult) {
                return msg.toolResult;
            }
        }
        return null;
    }

    private buildMessage(
        role: ChatMessage['role'],
        content: string,
        extra?: Pick<ChatMessage, 'toolCall' | 'toolResult'>,
    ): ChatMessage {
        return {
            id: this.generateId(),
            role,
            content,
            createdAt: new Date().toISOString(),
            ...extra,
        };
    }

    private appendToHistory(message: ChatMessage): void {
        this.fullHistory = [...this.fullHistory, message];
    }

    private appendRenderable(message: RenderableChatMessage): void {
        this.renderableMessages.update((current) => [...current, message]);
    }

    private async safeParseJson(response: Response): Promise<unknown> {
        try {
            return await response.json();
        } catch {
            return null;
        }
    }

    private generateId(): string {
        return crypto.randomUUID();
    }
}