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
import { checkContextRelevance } from '../helpers/chat-context-checker';
import { sanitizeResponse, containsUnsafeContent } from '../helpers/chat-response-sanitizer';
import { environment } from '../../environments/environment';

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

        // Check context relevance before processing
        const contextCheck = checkContextRelevance(trimmedText);
        if (!contextCheck.isRelevant) {
            const userMessage = this.buildMessage('user', trimmedText);
            this.appendToHistory(userMessage);
            this.appendRenderable({ id: userMessage.id, role: 'user', text: trimmedText, isFallback: false });

            const rejectionMessage = this.buildMessage(
                'model',
                "I can only help with OcuTemp facility management — room monitoring, energy usage, AC status, and system navigation. For other topics, please use a general-purpose assistant."
            );
            this.appendToHistory(rejectionMessage);
            this.appendRenderable({
                id: rejectionMessage.id,
                role: 'assistant',
                text: rejectionMessage.content,
                isFallback: false,
            });
            
            this.logger.warn('Chat message rejected due to context relevance', {
                service: 'ChatService',
                reason: contextCheck.reason,
            });
            return;
        }

        const userMessage = this.buildMessage('user', trimmedText);
        this.appendToHistory(userMessage);
        this.appendRenderable({ id: userMessage.id, role: 'user', text: trimmedText, isFallback: false });

        this.isLoading.set(true);
        try {
            await this.runTurn(userRole);
        } catch (err) {
            this.logger.error('Chat turn failed', err, { service: 'ChatService', action: 'sendMessage' });
            
            // Provide more specific error messages based on error type
            let errorMessage = "Something went wrong. Please try again in a moment.";
            
            if (err instanceof ChatRequestError) {
                if (err.message.includes('rate limit') || err.message.includes('Too many')) {
                    errorMessage = "You're sending messages too quickly. Please wait a moment and try again.";
                } else if (err.message.includes('network') || err.message.includes('Network')) {
                    errorMessage = "Connection issue. Please check your internet and try again.";
                } else if (err.message.includes('timeout')) {
                    errorMessage = "The request took too long. Please try a simpler question.";
                } else {
                    errorMessage = "Unable to process your message. Please try rephrasing your question.";
                }
            }
            
            this.appendRenderable({
                id: this.generateId(),
                role: 'assistant',
                text: errorMessage,
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

            // Log tool call for monitoring
            this.logger.warn('Executing tool call', {
                service: 'ChatService',
                toolName: response.toolCall.name,
                hasArgs: Object.keys(response.toolCall.args).length > 0,
            });

            const toolCallMessage = this.buildMessage('model', '', { toolCall: response.toolCall });
            this.appendToHistory(toolCallMessage);

            const toolResult = await this.chatTools.executeTool(response.toolCall, userRole);
            
            // Log tool result for monitoring
            this.logger.warn('Tool execution completed', {
                service: 'ChatService',
                toolName: toolResult.name,
                dataSize: JSON.stringify(toolResult.data).length,
            });
            
            const toolResultMessage = this.buildMessage('function', '', { toolResult });
            this.appendToHistory(toolResultMessage);

            return this.runTurn(userRole, toolHopsUsed + 1);
        }

        if (!response.answer) {
            throw new ChatRequestError('Provider returned an empty response');
        }

        const lastToolResult = this.findLastToolResult();
        const validation = validateChatAnswer(response.answer, lastToolResult);

        // Sanitize the answer as final safety layer
        const sanitizationResult = sanitizeResponse(response.answer);
        
        if (sanitizationResult.hadChanges) {
            this.logger.warn('Answer was sanitized to remove unsafe content', {
                service: 'ChatService',
                changes: sanitizationResult.changesLog,
            });
        }
        
        // Additional check for unsafe content that might have been missed
        if (containsUnsafeContent(sanitizationResult.sanitized)) {
            this.logger.error('Answer still contains unsafe content after sanitization', {
                service: 'ChatService',
            });
        }

        const finalAnswer = sanitizationResult.sanitized;
        const answerMessage = this.buildMessage('model', finalAnswer);
        this.appendToHistory(answerMessage);

        if (!validation.isValid) {
            // Log validation failure with details for monitoring
            this.logger.warn('Chat answer failed validation, falling back to raw data', {
                service: 'ChatService',
                reason: validation.reason,
                toolName: lastToolResult?.name,
                answerLength: finalAnswer.length,
                hadSanitization: sanitizationResult.hadChanges,
            });
            
            // Track specific types of hallucinations for analysis
            if (validation.reason?.includes('number')) {
                this.logger.warn('Hallucination detected: invented number', {
                    service: 'ChatService',
                    hallucinationType: 'invented_number',
                });
            } else if (validation.reason?.includes('room')) {
                this.logger.warn('Hallucination detected: invented room name', {
                    service: 'ChatService',
                    hallucinationType: 'invented_room',
                });
            } else if (validation.reason?.includes('control')) {
                this.logger.warn('Hallucination detected: claimed control action', {
                    service: 'ChatService',
                    hallucinationType: 'control_claim',
                });
            } else if (validation.reason?.includes('speculation')) {
                this.logger.warn('Hallucination detected: excessive speculation', {
                    service: 'ChatService',
                    hallucinationType: 'speculation',
                });
            } else if (validation.reason?.includes('Firebase')) {
                this.logger.warn('Security issue: Firebase path in answer', {
                    service: 'ChatService',
                    hallucinationType: 'path_leak',
                });
            }
            
            this.appendRenderable({
                id: answerMessage.id,
                role: 'assistant',
                text: finalAnswer,
                isFallback: true,
                fallbackData: lastToolResult?.data,
            });
            return;
        }

        this.appendRenderable({
            id: answerMessage.id,
            role: 'assistant',
            text: finalAnswer,
            isFallback: false,
        });
        
        // Log successful response for quality metrics (console only, not Sentry)
        if (!environment.production) {
            console.log('Chat answer validated successfully:', {
                service: 'ChatService',
                toolUsed: lastToolResult?.name ?? 'none',
                answerLength: finalAnswer.length,
                hadSanitization: sanitizationResult.hadChanges,
            });
        }
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