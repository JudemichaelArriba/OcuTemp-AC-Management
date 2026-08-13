import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Auth, onAuthStateChanged } from '@angular/fire/auth';
import {
  ChatErrorBody,
  ChatRequestError,
  ChatTurnRequest,
  ChatTurnResponse,
  RenderableChatMessage,
} from '../models/chat.models';
import { LoggerService } from './logger.service';

const CHAT_API_ENDPOINT = '/api/chat';
const MAX_MESSAGE_LENGTH = 500;

export type ChatLoadingStage =
  | 'idle'
  | 'understanding'
  | 'retrieving'
  | 'comparing'
  | 'preparing';

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly auth = inject(Auth);
  private readonly destroyRef = inject(DestroyRef);
  private readonly logger = inject(LoggerService);
  private readonly isLoading = signal(false);
  private readonly currentStage = signal<ChatLoadingStage>('idle');
  private readonly renderableMessages = signal<RenderableChatMessage[]>([]);
  private readonly latestTurn = signal<ChatTurnResponse | null>(null);
  private stateToken: string | undefined;
  private lastUserMessage = '';
  private activeUid: string | null = null;
  private stageTimer: ReturnType<typeof setInterval> | undefined;
  private requestController: AbortController | undefined;

  readonly loading = this.isLoading.asReadonly();
  readonly loadingStage = this.currentStage.asReadonly();
  readonly messages = this.renderableMessages.asReadonly();
  readonly latestResponse = this.latestTurn.asReadonly();

  constructor() {
    const unsubscribe = onAuthStateChanged(this.auth, (user) => {
      const nextUid = user?.uid ?? null;
      if (nextUid !== this.activeUid) {
        this.activeUid = nextUid;
        this.clearConversation();
      }
    });
    this.destroyRef.onDestroy(unsubscribe);
  }

  async sendMessage(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.isLoading()) return;
    if (message.length > MAX_MESSAGE_LENGTH) {
      this.appendError(
        `Messages can contain at most ${MAX_MESSAGE_LENGTH} characters. Shorten the question and try again.`,
        'invalid_request',
      );
      return;
    }

    const userId = crypto.randomUUID();
    this.lastUserMessage = message;
    this.renderableMessages.update((items) => [
      ...items,
      { id: userId, role: 'user', text: message, presentations: [] },
    ]);

    await this.performTurn(message);
  }

  async retryLastMessage(): Promise<void> {
    if (!this.lastUserMessage || this.isLoading()) return;
    await this.performTurn(this.lastUserMessage);
  }

  clearConversation(): void {
    this.requestController?.abort();
    this.requestController = undefined;
    this.stateToken = undefined;
    this.lastUserMessage = '';
    this.renderableMessages.set([]);
    this.latestTurn.set(null);
    this.isLoading.set(false);
    this.currentStage.set('idle');
    this.stopStageProgression();
  }

  private async performTurn(message: string): Promise<void> {
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    this.isLoading.set(true);
    this.startStageProgression();

    try {
      const response = await this.callChatApi(message, controller.signal);
      if (controller.signal.aborted) return;

      this.currentStage.set('preparing');
      this.stateToken = response.stateToken;
      this.latestTurn.set(response);
      this.renderableMessages.update((items) => [
        ...items,
        {
          id: response.turnId,
          role: 'assistant',
          text: response.answer.summary,
          answer: response.answer,
          presentations: response.presentations,
          evidence: response.evidence,
        },
      ]);

      if (response.contextReset) {
        this.logger.warn('OcuGuide conversation context expired and was reset', {
          service: 'ChatService',
        });
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      const requestError = this.toRequestError(error);
      if (requestError.code === 'context_invalid') {
        this.stateToken = undefined;
      }
      if (requestError.statusCode >= 500 || requestError.statusCode === 0) {
        this.logger.error('OcuGuide turn failed', requestError, {
          service: 'ChatService',
          code: requestError.code,
          statusCode: requestError.statusCode,
        });
      } else {
        this.logger.warn('OcuGuide request was rejected safely', {
          service: 'ChatService',
          code: requestError.code,
          statusCode: requestError.statusCode,
        });
      }
      this.appendError(
        this.friendlyErrorMessage(requestError),
        requestError.code,
        requestError.retryAfterSeconds,
      );
    } finally {
      if (this.requestController === controller) {
        this.requestController = undefined;
        this.isLoading.set(false);
        this.currentStage.set('idle');
        this.stopStageProgression();
      }
    }
  }

  private async callChatApi(message: string, signal: AbortSignal): Promise<ChatTurnResponse> {
    const firebaseUser = this.auth.currentUser;
    if (!firebaseUser) {
      throw new ChatRequestError('Sign in to use OcuGuide.', 'authentication_required', 401);
    }

    const idToken = await firebaseUser.getIdToken();
    const body: ChatTurnRequest = {
      message,
      ...(this.stateToken ? { stateToken: this.stateToken } : {}),
    };

    let response: Response;
    try {
      response = await fetch(CHAT_API_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ChatRequestError(
        'Network error contacting OcuGuide.',
        'assistant_unavailable',
        0,
        undefined,
        error,
      );
    }

    if (!response.ok) {
      const errorBody = await this.safeParseJson(response);
      throw new ChatRequestError(
        errorBody?.error?.message ?? `OcuGuide returned ${response.status}.`,
        errorBody?.error?.code ?? 'assistant_unavailable',
        response.status,
        errorBody?.error?.retryAfterSeconds,
      );
    }

    const value = (await response.json()) as ChatTurnResponse;
    if (!value?.turnId || !value.answer || !Array.isArray(value.presentations)) {
      throw new ChatRequestError(
        'OcuGuide returned an invalid response.',
        'assistant_unavailable',
        502,
      );
    }
    return value;
  }

  private appendError(message: string, code: string, retryAfterSeconds?: number): void {
    this.renderableMessages.update((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: message,
        presentations: [],
        errorCode: code,
        retryAfterSeconds,
      },
    ]);
  }

  private startStageProgression(): void {
    this.stopStageProgression();
    const stages: ChatLoadingStage[] = ['understanding', 'retrieving', 'comparing', 'preparing'];
    let index = 0;
    this.currentStage.set(stages[index]);
    this.stageTimer = setInterval(() => {
      index = Math.min(index + 1, stages.length - 1);
      this.currentStage.set(stages[index]);
    }, 2_200);
  }

  private stopStageProgression(): void {
    if (this.stageTimer) clearInterval(this.stageTimer);
    this.stageTimer = undefined;
  }

  private async safeParseJson(response: Response): Promise<ChatErrorBody | null> {
    try {
      return (await response.json()) as ChatErrorBody;
    } catch {
      return null;
    }
  }

  private toRequestError(error: unknown): ChatRequestError {
    if (error instanceof ChatRequestError) return error;
    return new ChatRequestError(
      'OcuGuide is temporarily unavailable.',
      'assistant_unavailable',
      0,
      undefined,
      error,
    );
  }

  private friendlyErrorMessage(error: ChatRequestError): string {
    switch (error.code) {
      case 'authentication_required':
        return 'Your sign-in session is no longer available. Sign in again to use OcuGuide.';
      case 'account_not_authorized':
        return 'This account is not approved to use OcuGuide.';
      case 'rate_limited':
        return error.retryAfterSeconds
          ? `OcuGuide is receiving requests too quickly. Try again in ${error.retryAfterSeconds} seconds.`
          : 'OcuGuide is receiving requests too quickly. Wait a moment and try again.';
      case 'context_invalid':
        return 'The saved conversation context expired or became invalid. It was cleared; send your question again.';
      case 'facility_too_large':
        return 'The requested facility report is larger than the safe response limit. Narrow the room scope.';
      case 'invalid_request':
        return error.message;
      case 'data_unavailable':
        return 'The requested facility data is temporarily unavailable. Try again shortly.';
      default:
        return 'OcuGuide is temporarily unavailable. Your request was not applied; try again shortly.';
    }
  }
}
