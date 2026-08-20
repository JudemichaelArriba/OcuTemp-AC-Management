import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Auth, onAuthStateChanged } from '@angular/fire/auth';
import {
  ChatAnswer,
  ChatAnswerBlock,
  ChatErrorBody,
  ChatEvidenceMetadata,
  ChatPresentation,
  ChatRequestError,
  ChatTurnRequest,
  ChatTurnResponse,
  RenderableChatMessage,
} from '../models/chat.models';
import { LoggerService } from './logger.service';

const CHAT_API_ENDPOINT = '/api/chat';
const MAX_MESSAGE_LENGTH = 500;

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly auth = inject(Auth);
  private readonly destroyRef = inject(DestroyRef);
  private readonly logger = inject(LoggerService);
  private readonly isLoading = signal(false);
  private readonly renderableMessages = signal<RenderableChatMessage[]>([]);
  private readonly latestTurn = signal<ChatTurnResponse | null>(null);
  private stateToken: string | undefined;
  private lastUserMessage = '';
  private activeUid: string | null = null;
  private requestController: AbortController | undefined;

  readonly loading = this.isLoading.asReadonly();
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
    if (Array.from(message).length > MAX_MESSAGE_LENGTH) {
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
  }

  private async performTurn(message: string): Promise<void> {
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    this.isLoading.set(true);

    try {
      const response = await this.callChatApi(message, controller.signal);
      if (controller.signal.aborted) return;

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
      }
    }
  }

  private async callChatApi(message: string, signal: AbortSignal): Promise<ChatTurnResponse> {
    const firebaseUser = this.auth.currentUser;
    if (!firebaseUser) {
      throw new ChatRequestError('Sign in to use OcuGuide.', 'authentication_required', 401);
    }

    const body: ChatTurnRequest = {
      message,
      ...(this.stateToken ? { stateToken: this.stateToken } : {}),
    };
    let idToken = await firebaseUser.getIdToken();

    for (let attempt = 0; attempt < 2; attempt += 1) {
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
        const errorCode = errorBody?.error?.code ?? 'assistant_unavailable';
        if (attempt === 0 && response.status === 401 && errorCode === 'authentication_required') {
          idToken = await firebaseUser.getIdToken(true);
          continue;
        }
        throw new ChatRequestError(
          errorBody?.error?.message ?? `OcuGuide returned ${response.status}.`,
          errorCode,
          response.status,
          errorBody?.error?.retryAfterSeconds,
        );
      }

      const value: unknown = await response.json();
      if (!isChatTurnResponse(value)) {
        throw new ChatRequestError(
          'OcuGuide returned an invalid response.',
          'assistant_unavailable',
          502,
        );
      }
      return value;
    }

    throw new ChatRequestError('OcuGuide authentication could not be refreshed.', 'authentication_required', 401);
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

const ANSWER_BLOCK_KINDS = new Set<ChatAnswerBlock['kind']>([
  'paragraph',
  'bullet-list',
  'numbered-list',
  'callout',
  'key-value',
]);
const ANSWER_BLOCK_TONES = new Set<ChatAnswerBlock['tone']>(['neutral', 'info', 'warning']);
const PRESENTATION_KINDS = new Set<ChatPresentation['kind']>([
  'energy-report',
  'room-telemetry',
  'climate-suggestions',
  'recent-events',
  'system-help',
]);
const PRESENTATION_AVAILABILITY = new Set(['available', 'unavailable']);
const ENERGY_BUCKETS = new Set(['day', 'week', 'month', 'year']);
const ENERGY_ROOM_STATUSES = new Set([
  'recorded',
  'no_records',
  'no_device',
  'device_unavailable',
]);
const DEVICE_ONLINE_STATES = new Set(['online', 'stale', 'offline', 'unknown']);
const ROOM_CONDITIONS = new Set(['comfortable', 'warm', 'hot', 'critical', 'unknown']);
const CLIMATE_STATUSES = new Set([
  'available',
  'no_suggestion',
  'no_device',
  'device_unavailable',
]);
const WEEK_DAYS = new Set([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]);
const HELP_ROUTES = new Set([
  '/app/settings',
  '/app/room-management',
  '/app/user-management',
  '/app/energy-reports',
  '/app/ocu-guide',
]);
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRESENTATION_ID_PATTERN = /^tool-[1-4]$/;
const MAX_PRESENTATIONS = 4;
const MAX_FACILITY_ROOMS = 200;
const MAX_TREND_POINTS = 60;
const MAX_RECENT_EVENTS = 25;
const MAX_ROOM_SCHEDULES = 30;
const MAX_HELP_STEPS = 30;

function isChatTurnResponse(value: unknown): value is ChatTurnResponse {
  if (!isRecord(value) || !hasExactKeys(value, [
    'turnId',
    'answer',
    'presentations',
    'evidence',
    'stateToken',
    'contextReset',
  ])) return false;

  const presentations = value['presentations'];
  return typeof value['turnId'] === 'string'
    && UUID_PATTERN.test(value['turnId'])
    && isChatAnswer(value['answer'])
    && Array.isArray(presentations)
    && presentations.length <= MAX_PRESENTATIONS
    && presentations.every(isChatPresentation)
    && hasUniqueStrings(presentations.map((presentation) => presentation.id))
    && isChatEvidence(value['evidence'])
    && isBoundedString(value['stateToken'], 1, 12 * 1024)
    && value['stateToken'].split('.').length === 5
    && typeof value['contextReset'] === 'boolean';
}

function isChatAnswer(value: unknown): value is ChatAnswer {
  if (!isRecord(value) || !hasExactKeys(value, [
    'headline',
    'summary',
    'blocks',
    'highlights',
    'caveats',
  ])) return false;
  return isBoundedString(value['headline'], 1, 160)
    && isBoundedString(value['summary'], 1, 800)
    && Array.isArray(value['blocks'])
    && value['blocks'].length >= 1
    && value['blocks'].length <= 5
    && value['blocks'].every(isChatAnswerBlock)
    && Array.isArray(value['highlights'])
    && value['highlights'].length <= 6
    && value['highlights'].every((highlight) => isRecord(highlight)
      && hasExactKeys(highlight, ['text'])
      && isBoundedString(highlight['text'], 1, 300))
    && isStringArray(value['caveats'], 3, 1, 240);
}

function isChatAnswerBlock(value: unknown): value is ChatAnswerBlock {
  if (!isRecord(value) || !hasExactKeys(value, [
    'kind',
    'text',
    'items',
    'entries',
    'tone',
  ])) return false;
  const hasValidShape = typeof value['kind'] === 'string'
    && ANSWER_BLOCK_KINDS.has(value['kind'] as ChatAnswerBlock['kind'])
    && isBoundedString(value['text'], 0, 600)
    && isStringArray(value['items'], 8, 1, 240)
    && Array.isArray(value['entries'])
    && value['entries'].length <= 8
    && value['entries'].every((entry) => isRecord(entry)
      && hasExactKeys(entry, ['label', 'value'])
      && isBoundedString(entry['label'], 1, 80)
      && isBoundedString(entry['value'], 1, 240))
    && typeof value['tone'] === 'string'
    && ANSWER_BLOCK_TONES.has(value['tone'] as ChatAnswerBlock['tone']);
  if (!hasValidShape) return false;

  const kind = value['kind'] as ChatAnswerBlock['kind'];
  const text = value['text'] as string;
  const items = value['items'] as string[];
  const entries = value['entries'] as ChatAnswerBlock['entries'];
  if (kind === 'paragraph' || kind === 'callout') {
    return Boolean(text.trim()) && items.length === 0 && entries.length === 0;
  }
  if (kind === 'bullet-list' || kind === 'numbered-list') {
    return items.length >= 2 && entries.length === 0;
  }
  return items.length === 0 && entries.length >= 1;
}

function isChatPresentation(value: unknown): value is ChatPresentation {
  if (!isRecord(value)
    || typeof value['kind'] !== 'string'
    || !PRESENTATION_KINDS.has(value['kind'] as ChatPresentation['kind'])
    || typeof value['id'] !== 'string'
    || !PRESENTATION_ID_PATTERN.test(value['id'])
    || !isBoundedString(value['title'], 1, 200)
    || typeof value['availability'] !== 'string'
    || !PRESENTATION_AVAILABILITY.has(value['availability'])) return false;

  switch (value['kind']) {
    case 'energy-report':
      return isEnergyReportPresentation(value);
    case 'room-telemetry':
      return isRoomTelemetryPresentation(value);
    case 'climate-suggestions':
      return isClimateSuggestionsPresentation(value);
    case 'recent-events':
      return isRecentEventsPresentation(value);
    case 'system-help':
      return isSystemHelpPresentation(value);
    default:
      return false;
  }
}

function isEnergyReportPresentation(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, [
    'kind',
    'availability',
    'id',
    'title',
    'estimated',
    'range',
    'metrics',
    'trend',
    'rooms',
  ]) || value['estimated'] !== true) return false;

  const range = value['range'];
  const metrics = value['metrics'];
  const trend = value['trend'];
  const rooms = value['rooms'];
  if (!isEnergyRange(range)
    || !isEnergyMetrics(metrics)
    || !Array.isArray(trend)
    || trend.length > MAX_TREND_POINTS
    || !trend.every(isEnergyTrendPoint)
    || !hasUniqueStrings(trend.map((point) => `${point.start}\u0000${point.end}`))
    || !trend.every((point, index) => point.start >= range.start
      && point.end <= range.end
      && (index === 0 || trend[index - 1].end < point.start))
    || !Array.isArray(rooms)
    || rooms.length > MAX_FACILITY_ROOMS
    || !rooms.every(isEnergyRoomRow)
    || !hasUniqueNormalizedStrings(rooms.map((room) => room.roomName))) return false;

  const recordedRooms = rooms.filter((room) => room.status === 'recorded').length;
  const expectedCoverage = metrics.activeRooms === 0
    ? 0
    : roundTo((recordedRooms / metrics.activeRooms) * 100, 1);
  const recordedRanks = rooms
    .filter((room) => room.status === 'recorded')
    .map((room) => room.rank)
    .sort((left, right) => (left ?? 0) - (right ?? 0));
  if (metrics.activeRooms !== rooms.length
    || metrics.roomsWithRecords !== recordedRooms
    || metrics.roomsWithRecords > metrics.activeRooms
    || metrics.coveragePercent !== expectedCoverage
    || recordedRanks.some((rank, index) => rank !== index + 1)) return false;

  if (value['availability'] === 'unavailable') {
    return trend.length === 0
      && rooms.length === 0
      && metrics.totalKwh === null
      && metrics.runtimeSeconds === null
      && metrics.sessionCount === null
      && metrics.activeRooms === 0
      && metrics.roomsWithRecords === 0
      && metrics.coveragePercent === 0;
  }
  if (metrics.roomsWithRecords === 0) {
    return metrics.totalKwh === null
      && metrics.runtimeSeconds === null
      && metrics.sessionCount === null
      && trend.length === 0;
  }
  return metrics.totalKwh !== null
    && metrics.runtimeSeconds !== null
    && metrics.sessionCount !== null;
}

function isEnergyRange(value: unknown): value is {
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly bucket: string;
} {
  return isRecord(value)
    && hasExactKeys(value, ['label', 'start', 'end', 'bucket'])
    && isBoundedString(value['label'], 1, 160)
    && isDateKey(value['start'])
    && isDateKey(value['end'])
    && value['start'] <= value['end']
    && typeof value['bucket'] === 'string'
    && ENERGY_BUCKETS.has(value['bucket']);
}

function isEnergyMetrics(value: unknown): value is {
  readonly totalKwh: number | null;
  readonly runtimeSeconds: number | null;
  readonly sessionCount: number | null;
  readonly activeRooms: number;
  readonly roomsWithRecords: number;
  readonly coveragePercent: number;
} {
  return isRecord(value)
    && hasExactKeys(value, [
      'totalKwh',
      'runtimeSeconds',
      'sessionCount',
      'activeRooms',
      'roomsWithRecords',
      'coveragePercent',
    ])
    && isNullableFiniteNumberInRange(value['totalKwh'], 0, Number.MAX_SAFE_INTEGER)
    && isNullableSafeIntegerInRange(value['runtimeSeconds'], 0, Number.MAX_SAFE_INTEGER)
    && isNullableSafeIntegerInRange(value['sessionCount'], 0, Number.MAX_SAFE_INTEGER)
    && isSafeIntegerInRange(value['activeRooms'], 0, MAX_FACILITY_ROOMS)
    && isSafeIntegerInRange(value['roomsWithRecords'], 0, MAX_FACILITY_ROOMS)
    && isFiniteNumberInRange(value['coveragePercent'], 0, 100);
}

function isEnergyTrendPoint(value: unknown): value is {
  readonly label: string;
  readonly start: string;
  readonly end: string;
  readonly estimatedKwh: number;
} {
  return isRecord(value)
    && hasExactKeys(value, ['label', 'start', 'end', 'estimatedKwh'])
    && isBoundedString(value['label'], 1, 100)
    && isDateKey(value['start'])
    && isDateKey(value['end'])
    && value['start'] <= value['end']
    && isFiniteNumberInRange(value['estimatedKwh'], 0, Number.MAX_SAFE_INTEGER);
}

function isEnergyRoomRow(value: unknown): value is {
  readonly roomName: string;
  readonly estimatedKwh: number | null;
  readonly sharePercent: number | null;
  readonly rank: number | null;
  readonly runtimeSeconds: number | null;
  readonly sessionCount: number | null;
  readonly status: string;
  readonly lastUpdatedAt: string | null;
} {
  if (!isRecord(value) || !hasExactKeys(value, [
    'roomName',
    'estimatedKwh',
    'sharePercent',
    'rank',
    'runtimeSeconds',
    'sessionCount',
    'status',
    'lastUpdatedAt',
  ])) return false;

  const hasValidFields = isBoundedString(value['roomName'], 1, 100)
    && isNullableFiniteNumberInRange(value['estimatedKwh'], 0, Number.MAX_SAFE_INTEGER)
    && isNullableFiniteNumberInRange(value['sharePercent'], 0, 100)
    && isNullableSafeIntegerInRange(value['rank'], 1, MAX_FACILITY_ROOMS)
    && isNullableSafeIntegerInRange(value['runtimeSeconds'], 0, Number.MAX_SAFE_INTEGER)
    && isNullableSafeIntegerInRange(value['sessionCount'], 0, Number.MAX_SAFE_INTEGER)
    && typeof value['status'] === 'string'
    && ENERGY_ROOM_STATUSES.has(value['status'])
    && isNullableIsoTimestamp(value['lastUpdatedAt']);
  if (!hasValidFields) return false;

  if (value['status'] === 'recorded') {
    return value['estimatedKwh'] !== null
      && value['sharePercent'] !== null
      && value['rank'] !== null
      && value['runtimeSeconds'] !== null
      && value['sessionCount'] !== null;
  }
  return value['estimatedKwh'] === null
    && value['sharePercent'] === null
    && value['rank'] === null
    && value['runtimeSeconds'] === null
    && value['sessionCount'] === null;
}

function isRoomTelemetryPresentation(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['kind', 'availability', 'id', 'title', 'rooms'])) return false;
  const rooms = value['rooms'];
  return Array.isArray(rooms)
    && rooms.length <= MAX_FACILITY_ROOMS
    && rooms.every(isRoomTelemetryRow)
    && hasUniqueNormalizedStrings(rooms.map((room) => room.roomName))
    && (value['availability'] === 'available' || rooms.length === 0);
}

function isRoomTelemetryRow(value: unknown): value is { readonly roomName: string } {
  if (!isRecord(value) || !hasExactKeys(value, [
    'roomName',
    'onlineState',
    'condition',
    'temperature',
    'humidity',
    'occupancy',
    'acPower',
    'aiAutoApply',
    'schedules',
    'lastSeen',
  ])) return false;

  return isBoundedString(value['roomName'], 1, 100)
    && typeof value['onlineState'] === 'string'
    && DEVICE_ONLINE_STATES.has(value['onlineState'])
    && typeof value['condition'] === 'string'
    && ROOM_CONDITIONS.has(value['condition'])
    && isNullableFiniteNumberInRange(value['temperature'], -50, 100)
    && isNullableFiniteNumberInRange(value['humidity'], 0, 100)
    && isNullableBoolean(value['occupancy'])
    && isNullableBoolean(value['acPower'])
    && isNullableBoolean(value['aiAutoApply'])
    && Array.isArray(value['schedules'])
    && value['schedules'].length <= MAX_ROOM_SCHEDULES
    && value['schedules'].every(isRoomSchedule)
    && isNullableIsoTimestamp(value['lastSeen']);
}

function isRoomSchedule(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['day', 'startTime', 'endTime', 'subject'])
    && typeof value['day'] === 'string'
    && WEEK_DAYS.has(value['day'])
    && typeof value['startTime'] === 'string'
    && CLOCK_TIME_PATTERN.test(value['startTime'])
    && typeof value['endTime'] === 'string'
    && CLOCK_TIME_PATTERN.test(value['endTime'])
    && value['startTime'] < value['endTime']
    && isBoundedString(value['subject'], 1, 100);
}

function isClimateSuggestionsPresentation(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['kind', 'availability', 'id', 'title', 'rooms'])) return false;
  const rooms = value['rooms'];
  return Array.isArray(rooms)
    && rooms.length <= MAX_FACILITY_ROOMS
    && rooms.every(isClimateSuggestionRow)
    && hasUniqueNormalizedStrings(rooms.map((room) => room.roomName))
    && (value['availability'] === 'available' || rooms.length === 0);
}

function isClimateSuggestionRow(value: unknown): value is { readonly roomName: string } {
  if (!isRecord(value) || !hasExactKeys(value, [
    'roomName',
    'status',
    'currentRoomTemp',
    'humidity',
    'suggestedTemp',
    'reason',
    'applied',
    'autoApplyEnabled',
    'updatedAt',
  ])) return false;

  const hasValidFields = isBoundedString(value['roomName'], 1, 100)
    && typeof value['status'] === 'string'
    && CLIMATE_STATUSES.has(value['status'])
    && isNullableFiniteNumberInRange(value['currentRoomTemp'], -50, 100)
    && isNullableFiniteNumberInRange(value['humidity'], 0, 100)
    && isNullableFiniteNumberInRange(value['suggestedTemp'], 10, 40)
    && (value['reason'] === null || isBoundedString(value['reason'], 1, 300))
    && isNullableBoolean(value['applied'])
    && isNullableBoolean(value['autoApplyEnabled'])
    && isNullableIsoTimestamp(value['updatedAt']);
  if (!hasValidFields) return false;

  if (value['status'] === 'available') {
    return value['suggestedTemp'] !== null;
  }
  return value['currentRoomTemp'] === null
    && value['humidity'] === null
    && value['suggestedTemp'] === null
    && value['reason'] === null
    && value['applied'] === null
    && value['autoApplyEnabled'] === null
    && value['updatedAt'] === null;
}

function isRecentEventsPresentation(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['kind', 'availability', 'id', 'title', 'events'])) return false;
  const events = value['events'];
  return Array.isArray(events)
    && events.length <= MAX_RECENT_EVENTS
    && events.every(isRecentEventRow)
    && (value['availability'] === 'available' || events.length === 0);
}

function isRecentEventRow(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, [
      'roomName',
      'eventType',
      'mode',
      'detail',
      'applied',
      'updatedAt',
    ])
    && isBoundedString(value['roomName'], 1, 100)
    && isBoundedString(value['eventType'], 1, 60)
    && (value['mode'] === null || isBoundedString(value['mode'], 1, 40))
    && isBoundedString(value['detail'], 1, 240)
    && isNullableBoolean(value['applied'])
    && isIsoTimestamp(value['updatedAt']);
}

function isSystemHelpPresentation(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, [
    'kind',
    'availability',
    'id',
    'title',
    'topic',
    'steps',
    'route',
    'restricted',
  ])) return false;

  const steps = value['steps'];
  const route = value['route'];
  return isBoundedString(value['topic'], 0, 64)
    && isStringArray(steps, MAX_HELP_STEPS, 1, 500)
    && (route === null || (typeof route === 'string' && HELP_ROUTES.has(route)))
    && typeof value['restricted'] === 'boolean'
    && (value['restricted'] === false || (steps.length === 0 && route === null))
    && (value['availability'] === 'available'
      || (steps.length === 0 && route === null && value['restricted'] === false));
}

function isChatEvidence(value: unknown): value is ChatEvidenceMetadata {
  if (!isRecord(value) || !hasExactKeys(value, [
    'asOf',
    'timeZone',
    'partial',
    'notices',
  ])) return false;
  return isIsoTimestamp(value['asOf'])
    && value['timeZone'] === 'Asia/Manila'
    && typeof value['partial'] === 'boolean'
    && isStringArray(value['notices'], 8, 1, 300);
}

function isStringArray(
  value: unknown,
  maximumItems: number,
  minimumLength: number,
  maximumLength: number,
): value is string[] {
  return Array.isArray(value)
    && value.length <= maximumItems
    && value.every((item) => isBoundedString(item, minimumLength, maximumLength));
}

function isBoundedString(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  return length >= minimumLength && length <= maximumLength;
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isBoundedString(value, 1, 50)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isNullableIsoTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value);
}

function isFiniteNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function isNullableFiniteNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | null {
  return value === null || isFiniteNumberInRange(value, minimum, maximum);
}

function isSafeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function isNullableSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | null {
  return value === null || isSafeIntegerInRange(value, minimum, maximum);
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function roundTo(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function hasUniqueNormalizedStrings(values: readonly string[]): boolean {
  const normalized = values.map((value) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US'));
  return hasUniqueStrings(normalized);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
