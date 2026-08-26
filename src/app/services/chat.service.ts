import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Auth, onAuthStateChanged } from '@angular/fire/auth';
import {
  ChatAnswerBlock,
  ChatAnswerPart,
  ChatDisplayDirective,
  ChatErrorBody,
  ChatEvidenceMetadata,
  ChatPresentation,
  ChatRequestError,
  ChatResponseContext,
  ChatTurnRequest,
  ChatTurnResponse,
  ProjectedValue,
  RenderableChatMessage,
  SystemField,
} from '../models/chat.models';
import { AuthStateService } from './auth-state.service';
import { LoggerService } from './logger.service';

const CHAT_API_ENDPOINT = '/api/chat';
const MAX_MESSAGE_LENGTH = 500;
const MAX_PUBLIC_RESPONSE_BYTES = 256 * 1024;
const MAX_STATE_TOKEN_LENGTH = 20_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PART_IDS = new Set(['part-1', 'part-2', 'part-3']);
const PRESENTATION_KINDS = new Set([
  'metric-summary',
  'room-data',
  'schedule-data',
  'energy-report',
  'room-telemetry',
  'climate-suggestions',
  'recent-events',
  'system-help',
]);
const DISPLAY_MODES = new Set([
  'compact_metrics',
  'key_value',
  'bullet_list',
  'table',
  'ranking_chart',
  'trend_chart',
  'full_report',
]);
const TOOL_NAMES = new Set([
  'get_facility_summary',
  'get_room_telemetry',
  'get_energy_report',
  'get_climate_prediction_logs',
  'get_recent_room_events',
  'get_system_help',
  'get_admin_user_aggregates',
]);
const DOMAINS = new Set([
  'rooms', 'devices', 'measurements', 'occupancy', 'ac_control', 'overrides',
  'ai_auto_apply', 'schedules', 'energy', 'climate_suggestions', 'decision_events',
  'floor_plan', 'own_account', 'admin_user_aggregates', 'app_help',
  'assistant_capabilities', 'system_concepts', 'conversation', 'unsupported',
]);
const OPERATIONS = new Set([
  'greet', 'count', 'list', 'status', 'detail', 'compare', 'report', 'summarize', 'explain',
  'how_to', 'clarify', 'deny',
]);
const SCOPES = new Set([
  'facility', 'named_rooms', 'own_account', 'previous_request', 'previous_result',
  'prior_part',
]);
const ANSWERABILITY = new Set([
  'answerable', 'partial', 'room_not_found', 'room_inactive', 'room_ambiguous',
  'no_online_reading', 'no_energy_records', 'source_unavailable',
  'insufficient_evidence', 'permission_denied', 'clarification_required', 'not_applicable',
]);
const SYSTEM_FIELDS = new Set<SystemField>([
  'room_name', 'room_status', 'room_count', 'device_assignment', 'device_status',
  'device_count', 'assigned_device_count', 'online_device_count',
  'stale_device_count', 'offline_device_count', 'unknown_device_status_count',
  'last_seen', 'temperature', 'last_known_temperature', 'humidity',
  'last_known_humidity', 'condition', 'occupancy', 'last_known_occupancy', 'ac_power',
  'last_known_ac_power', 'override_active', 'override_target_temperature',
  'override_until', 'ai_auto_apply', 'schedule_count', 'schedules', 'estimated_kwh',
  'runtime_seconds', 'session_count', 'energy_rank', 'energy_trend',
  'climate_suggestion', 'decision_event', 'floor_plan_assignment',
  'floor_plan_layout', 'account_name', 'account_email', 'account_role',
  'account_approval', 'user_total', 'approved_staff_count', 'pending_staff_count',
  'admin_count', 'help_topic', 'capabilities',
]);
const VALUE_STATES = new Set([
  'current', 'historical', 'configured', 'expired', 'unknown', 'unavailable',
  'not_applicable',
]);
const VALUE_UNITS = new Set([
  'none', 'celsius', 'percent', 'kwh', 'seconds', 'count', 'datetime',
]);
const BLOCK_KINDS = new Set(['paragraph', 'bullet-list', 'numbered-list', 'callout', 'key-value']);
const BLOCK_TONES = new Set(['neutral', 'info', 'warning']);

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly auth = inject(Auth);
  private readonly authState = inject(AuthStateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly logger = inject(LoggerService);
  private readonly isLoading = signal(false);
  private readonly renderableMessages = signal<RenderableChatMessage[]>([]);
  private readonly latestTurn = signal<ChatTurnResponse | null>(null);
  private stateToken: string | undefined;
  private lastUserMessage = '';
  private authUid: string | null = this.auth.currentUser?.uid ?? null;
  private profileFingerprint: string | null | undefined;
  private requestController: AbortController | undefined;

  readonly loading = this.isLoading.asReadonly();
  readonly messages = this.renderableMessages.asReadonly();
  readonly latestResponse = this.latestTurn.asReadonly();

  constructor() {
    const unsubscribeAuth = onAuthStateChanged(this.auth, (user) => {
      const nextUid = user?.uid ?? null;
      if (nextUid !== this.authUid) {
        this.authUid = nextUid;
        this.clearConversation();
      }
    });
    const profileSubscription = this.authState.currentUser$.subscribe((user) => {
      const nextFingerprint = user
        ? `${user.uid}\u0000${user.role ?? 'unknown'}\u0000${String(user.approved)}`
        : null;
      if (this.profileFingerprint !== undefined && nextFingerprint !== this.profileFingerprint) {
        this.clearConversation();
      }
      this.profileFingerprint = nextFingerprint;
    });
    this.destroyRef.onDestroy(() => {
      unsubscribeAuth();
      profileSubscription.unsubscribe();
      this.requestController?.abort();
    });
  }

  async sendMessage(text: string): Promise<void> {
    const message = text.normalize('NFKC').trim();
    if (!message || this.isLoading()) return;
    if (Array.from(message).length > MAX_MESSAGE_LENGTH) {
      this.appendError(
        `Messages can contain at most ${MAX_MESSAGE_LENGTH} characters. Shorten the question and try again.`,
        'invalid_request',
      );
      return;
    }

    this.lastUserMessage = message;
    this.renderableMessages.update((items) => [
      ...items,
      this.emptyMessage(crypto.randomUUID(), 'user', message),
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
          text: response.answerParts.map((part) => part.text).filter(Boolean).join('\n\n'),
          responseContexts: response.responseContexts,
          answerParts: response.answerParts,
          presentations: response.presentations,
          displayPlan: response.displayPlan,
          followUps: response.followUps,
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
      if (requestError.code === 'context_invalid') this.stateToken = undefined;
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
        const errorBody = await this.safeParseError(response);
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

      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_PUBLIC_RESPONSE_BYTES) {
        throw new ChatRequestError('OcuGuide returned an oversized response.', 'assistant_unavailable', 502);
      }
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch (error: unknown) {
        throw new ChatRequestError(
          'OcuGuide returned an invalid response.',
          'assistant_unavailable',
          502,
          undefined,
          error,
        );
      }
      if (!isChatTurnResponse(value)) {
        throw new ChatRequestError('OcuGuide returned an invalid response.', 'assistant_unavailable', 502);
      }
      return value;
    }

    throw new ChatRequestError('OcuGuide authentication could not be refreshed.', 'authentication_required', 401);
  }

  private emptyMessage(
    id: string,
    role: RenderableChatMessage['role'],
    text: string,
  ): RenderableChatMessage {
    return {
      id,
      role,
      text,
      responseContexts: [],
      answerParts: [],
      presentations: [],
      displayPlan: [],
      followUps: [],
    };
  }

  private appendError(message: string, code: string, retryAfterSeconds?: number): void {
    this.renderableMessages.update((items) => [
      ...items,
      {
        ...this.emptyMessage(crypto.randomUUID(), 'assistant', message),
        errorCode: code,
        retryAfterSeconds,
      },
    ]);
  }

  private async safeParseError(response: Response): Promise<ChatErrorBody | null> {
    try {
      const raw = await response.text();
      if (raw.length > 16_384) return null;
      const value: unknown = JSON.parse(raw);
      return isRecord(value) ? value as ChatErrorBody : null;
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
      case 'origin_not_allowed':
        return 'This OcuTemp site is not allowed to use OcuGuide.';
      case 'rate_limited':
        return error.retryAfterSeconds
          ? `OcuGuide is receiving requests too quickly. Try again in ${error.retryAfterSeconds} seconds.`
          : 'OcuGuide is receiving requests too quickly. Wait a moment and try again.';
      case 'context_invalid':
        return 'The saved conversation context expired or became invalid. It was cleared; send your question again.';
      case 'facility_too_large':
        return 'That request covers too much facility data. Narrow it to fewer rooms or a smaller period.';
      case 'invalid_request':
        return 'That request could not be processed safely. Rephrase it as a shorter OcuTemp question.';
      case 'data_unavailable':
        return 'OcuTemp data is temporarily unavailable. Try again in a moment.';
      case 'configuration_error':
        return 'OcuGuide is not configured for this deployment.';
      case 'assistant_unavailable':
        return error.message ===
          'OcuGuide is temporarily unable to interpret requests because its AI providers are unavailable. Please try again shortly.'
          ? error.message
          : 'OcuGuide is temporarily unavailable. Please try again shortly.';
      default:
        return 'OcuGuide could not complete that request. Try again in a moment.';
    }
  }
}

function isChatTurnResponse(value: unknown): value is ChatTurnResponse {
  if (!isRecord(value) || !hasExactKeys(value, [
    'turnId', 'responseContexts', 'answerParts', 'presentations', 'displayPlan',
    'evidence', 'followUps', 'stateToken', 'contextReset',
  ])) return false;
  if (!isBoundedString(value['turnId'], 1, 128)
    || !ID_PATTERN.test(value['turnId'])
    || !isBoundedString(value['stateToken'], 1, MAX_STATE_TOKEN_LENGTH)
    || typeof value['contextReset'] !== 'boolean'
    || !Array.isArray(value['responseContexts'])
    || value['responseContexts'].length < 1
    || value['responseContexts'].length > 3
    || !value['responseContexts'].every(isResponseContext)
    || !hasUnique(value['responseContexts'].map((context) => context.partId))
    || !Array.isArray(value['answerParts'])
    || value['answerParts'].length !== value['responseContexts'].length
    || !value['answerParts'].every(isAnswerPart)
    || !hasUnique(value['answerParts'].map((part) => part.partId))
    || !sameMembers(
      value['responseContexts'].map((context) => context.partId),
      value['answerParts'].map((part) => part.partId),
    )
    || !Array.isArray(value['presentations'])
    || value['presentations'].length > 12
    || !value['presentations'].every(isPresentation)
    || !hasUnique(value['presentations'].map((presentation) => presentation.id))
    || !Array.isArray(value['displayPlan'])
    || value['displayPlan'].length > 1
    || !value['displayPlan'].every(isDisplayDirective)
    || !isEvidence(value['evidence'])
    || !Array.isArray(value['followUps'])
    || value['followUps'].length > 3
    || !value['followUps'].every(isFollowUp)) return false;

  const partIds = new Set(value['responseContexts'].map((context) => context.partId));
  const presentations = value['presentations'] as ChatPresentation[];
  const displayPlan = value['displayPlan'] as ChatDisplayDirective[];
  if (!presentations.every((presentation) => partIds.has(presentation.partId))) return false;
  return displayPlan.every((directive) => presentations.some((presentation) => (
    presentation.id === directive.presentationId && presentation.partId === directive.partId
  )));
}

function isResponseContext(value: unknown): value is ChatResponseContext {
  return isRecord(value)
    && hasExactKeys(value, ['partId', 'domain', 'operation', 'fields', 'scope', 'answerability'])
    && typeof value['partId'] === 'string'
    && PART_IDS.has(value['partId'])
    && typeof value['domain'] === 'string'
    && DOMAINS.has(value['domain'])
    && typeof value['operation'] === 'string'
    && OPERATIONS.has(value['operation'])
    && Array.isArray(value['fields'])
    && value['fields'].length <= 8
    && value['fields'].every(isSystemField)
    && hasUnique(value['fields'])
    && typeof value['scope'] === 'string'
    && SCOPES.has(value['scope'])
    && typeof value['answerability'] === 'string'
    && ANSWERABILITY.has(value['answerability']);
}

function isAnswerPart(value: unknown): value is ChatAnswerPart {
  return isRecord(value)
    && hasExactKeys(value, ['partId', 'text', 'blocks', 'highlights', 'caveats'])
    && typeof value['partId'] === 'string'
    && PART_IDS.has(value['partId'])
    && isBoundedString(value['text'], 1, 4_000)
    && Array.isArray(value['blocks'])
    && value['blocks'].length <= 12
    && value['blocks'].every(isAnswerBlock)
    && Array.isArray(value['highlights'])
    && value['highlights'].length <= 8
    && value['highlights'].every((item) => isRecord(item)
      && hasExactKeys(item, ['text'])
      && isBoundedString(item['text'], 1, 300))
    && isStringArray(value['caveats'], 8, 1, 500);
}

function isAnswerBlock(value: unknown): value is ChatAnswerBlock {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'text', 'items', 'entries', 'tone'])
    && typeof value['kind'] === 'string'
    && BLOCK_KINDS.has(value['kind'])
    && isBoundedString(value['text'], 0, 2_000)
    && isStringArray(value['items'], 50, 1, 500)
    && Array.isArray(value['entries'])
    && value['entries'].length <= 50
    && value['entries'].every((entry) => isRecord(entry)
      && hasExactKeys(entry, ['label', 'value'])
      && isBoundedString(entry['label'], 1, 100)
      && isBoundedString(entry['value'], 1, 500))
    && typeof value['tone'] === 'string'
    && BLOCK_TONES.has(value['tone']);
}

function isDisplayDirective(value: unknown): value is ChatDisplayDirective {
  return isRecord(value)
    && hasExactKeys(value, ['partId', 'presentationId', 'mode'])
    && typeof value['partId'] === 'string'
    && PART_IDS.has(value['partId'])
    && isBoundedString(value['presentationId'], 1, 128)
    && ID_PATTERN.test(value['presentationId'])
    && typeof value['mode'] === 'string'
    && DISPLAY_MODES.has(value['mode']);
}

function isPresentation(value: unknown): value is ChatPresentation {
  if (!isRecord(value)
    || typeof value['kind'] !== 'string'
    || !PRESENTATION_KINDS.has(value['kind'])
    || typeof value['availability'] !== 'string'
    || !new Set(['available', 'unavailable']).has(value['availability'])
    || !isBoundedString(value['id'], 1, 128)
    || !ID_PATTERN.test(value['id'])
    || !isBoundedString(value['title'], 1, 200)
    || typeof value['partId'] !== 'string'
    || !PART_IDS.has(value['partId'])
    || typeof value['toolName'] !== 'string'
    || !TOOL_NAMES.has(value['toolName'])) return false;

  switch (value['kind']) {
    case 'metric-summary':
      return hasExactKeys(value, ['kind', 'availability', 'id', 'title', 'partId', 'toolName', 'metrics'])
        && Array.isArray(value['metrics'])
        && value['metrics'].length <= 50
        && value['metrics'].every(isProjectedValue);
    case 'room-data':
      return hasExactKeys(value, ['kind', 'availability', 'id', 'title', 'partId', 'toolName', 'rooms'])
        && Array.isArray(value['rooms'])
        && value['rooms'].length <= 200
        && value['rooms'].every((room) => isRecord(room)
          && hasExactKeys(room, ['roomName', 'values'])
          && isBoundedString(room['roomName'], 1, 100)
          && Array.isArray(room['values'])
          && room['values'].length <= 16
          && room['values'].every(isProjectedValue));
    case 'schedule-data':
      return hasExactKeys(value, ['kind', 'availability', 'id', 'title', 'partId', 'toolName', 'schedules'])
        && Array.isArray(value['schedules'])
        && value['schedules'].length <= 200
        && value['schedules'].every(isScheduleRow);
    case 'energy-report':
      return isEnergyPresentation(value);
    case 'room-telemetry':
      return isLegacyTelemetryPresentation(value);
    case 'climate-suggestions':
      return isClimatePresentation(value);
    case 'recent-events':
      return isEventsPresentation(value);
    case 'system-help':
      return isHelpPresentation(value);
    default:
      return false;
  }
}

function isProjectedValue(value: unknown): value is ProjectedValue {
  return isRecord(value)
    && hasExactKeys(value, ['field', 'label', 'value', 'state', 'unit', 'asOf'])
    && isSystemField(value['field'])
    && isBoundedString(value['label'], 1, 100)
    && (value['value'] === null
      || typeof value['value'] === 'boolean'
      || (typeof value['value'] === 'number' && Number.isFinite(value['value']))
      || isBoundedString(value['value'], 0, 500))
    && typeof value['state'] === 'string'
    && VALUE_STATES.has(value['state'])
    && typeof value['unit'] === 'string'
    && VALUE_UNITS.has(value['unit'])
    && isNullableTimestamp(value['asOf']);
}

function isScheduleRow(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['roomName', 'day', 'startTime', 'endTime', 'subject', 'state'])
    && isBoundedString(value['roomName'], 1, 100)
    && isBoundedString(value['day'], 0, 20)
    && isBoundedString(value['startTime'], 0, 10)
    && isBoundedString(value['endTime'], 0, 10)
    && isBoundedString(value['subject'], 0, 100)
    && typeof value['state'] === 'string'
    && new Set(['configured', 'unknown', 'unavailable']).has(value['state']);
}

function isEnergyPresentation(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, [
    'kind', 'availability', 'id', 'title', 'partId', 'toolName', 'estimated', 'range',
    'metrics', 'trend', 'rooms',
  ]) || value['estimated'] !== true || !isRecord(value['range']) || !isRecord(value['metrics'])) return false;
  const range = value['range'];
  const metrics = value['metrics'];
  return hasExactKeys(range, ['label', 'start', 'end', 'bucket'])
    && isBoundedString(range['label'], 1, 160)
    && isDateKey(range['start'])
    && isDateKey(range['end'])
    && range['start'] <= range['end']
    && typeof range['bucket'] === 'string'
    && new Set(['day', 'week', 'month', 'year']).has(range['bucket'])
    && hasExactKeys(metrics, [
      'totalKwh', 'runtimeSeconds', 'sessionCount', 'activeRooms', 'roomsWithRecords',
      'coveragePercent', 'recordedDays', 'expectedDays', 'dataCoveragePercent',
    ])
    && isNullableNonNegativeNumber(metrics['totalKwh'])
    && isNullableNonNegativeInteger(metrics['runtimeSeconds'])
    && isNullableNonNegativeInteger(metrics['sessionCount'])
    && isIntegerInRange(metrics['activeRooms'], 0, 200)
    && isIntegerInRange(metrics['roomsWithRecords'], 0, 200)
    && isNumberInRange(metrics['coveragePercent'], 0, 100)
    && isIntegerInRange(metrics['recordedDays'], 0, 3_660)
    && isIntegerInRange(metrics['expectedDays'], 1, 3_660)
    && isNumberInRange(metrics['dataCoveragePercent'], 0, 100)
    && Array.isArray(value['trend'])
    && value['trend'].length <= 3_660
    && value['trend'].every((point) => isRecord(point)
      && hasExactKeys(point, ['label', 'start', 'end', 'estimatedKwh', 'recordedDays', 'expectedDays'])
      && isBoundedString(point['label'], 1, 100)
      && isDateKey(point['start'])
      && isDateKey(point['end'])
      && isNullableNonNegativeNumber(point['estimatedKwh'])
      && isIntegerInRange(point['recordedDays'], 0, 3_660)
      && isIntegerInRange(point['expectedDays'], 1, 3_660))
    && Array.isArray(value['rooms'])
    && value['rooms'].length <= 200
    && value['rooms'].every(isEnergyRoom);
}

function isEnergyRoom(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, [
      'roomName', 'estimatedKwh', 'sharePercent', 'rank', 'runtimeSeconds',
      'sessionCount', 'status', 'lastUpdatedAt',
    ])
    && isBoundedString(value['roomName'], 1, 100)
    && isNullableNonNegativeNumber(value['estimatedKwh'])
    && (value['sharePercent'] === null || isNumberInRange(value['sharePercent'], 0, 100))
    && (value['rank'] === null || isIntegerInRange(value['rank'], 1, 200))
    && isNullableNonNegativeInteger(value['runtimeSeconds'])
    && isNullableNonNegativeInteger(value['sessionCount'])
    && typeof value['status'] === 'string'
    && new Set(['recorded', 'no_records', 'no_device', 'device_unavailable']).has(value['status'])
    && isNullableTimestamp(value['lastUpdatedAt']);
}

function isLegacyTelemetryPresentation(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['kind', 'availability', 'id', 'title', 'partId', 'toolName', 'rooms'])
    && Array.isArray(value['rooms'])
    && value['rooms'].length <= 200
    && value['rooms'].every((room) => isRecord(room)
      && hasExactKeys(room, [
        'roomName', 'deviceAssignmentStatus', 'onlineState', 'measurementStatus', 'condition',
        'temperature', 'humidity', 'occupancy', 'acPower', 'aiAutoApply', 'schedules', 'lastSeen',
      ])
      && isBoundedString(room['roomName'], 1, 100)
      && typeof room['deviceAssignmentStatus'] === 'string'
      && new Set(['assigned', 'not_assigned', 'unavailable']).has(room['deviceAssignmentStatus'])
      && typeof room['onlineState'] === 'string'
      && new Set(['online', 'stale', 'offline', 'unknown']).has(room['onlineState'])
      && typeof room['measurementStatus'] === 'string'
      && new Set(['current', 'stale', 'offline', 'unavailable']).has(room['measurementStatus'])
      && typeof room['condition'] === 'string'
      && new Set(['comfortable', 'warm', 'hot', 'critical', 'unknown']).has(room['condition'])
      && isNullableFiniteNumber(room['temperature'])
      && isNullableFiniteNumber(room['humidity'])
      && isNullableBoolean(room['occupancy'])
      && isNullableBoolean(room['acPower'])
      && isNullableBoolean(room['aiAutoApply'])
      && Array.isArray(room['schedules'])
      && room['schedules'].length <= 200
      && room['schedules'].every((schedule) => isRecord(schedule)
        && hasExactKeys(schedule, ['day', 'startTime', 'endTime', 'subject'])
        && isBoundedString(schedule['day'], 1, 20)
        && isBoundedString(schedule['startTime'], 1, 10)
        && isBoundedString(schedule['endTime'], 1, 10)
        && isBoundedString(schedule['subject'], 1, 100))
      && isNullableTimestamp(room['lastSeen']));
}

function isClimatePresentation(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['kind', 'availability', 'id', 'title', 'partId', 'toolName', 'rooms'])
    && Array.isArray(value['rooms'])
    && value['rooms'].length <= 200
    && value['rooms'].every((room) => isRecord(room)
      && hasExactKeys(room, [
        'roomName', 'status', 'currentRoomTemp', 'humidity', 'suggestedTemp', 'reason',
        'applied', 'autoApplyEnabled', 'updatedAt',
      ])
      && isBoundedString(room['roomName'], 1, 100)
      && typeof room['status'] === 'string'
      && new Set(['available', 'no_suggestion', 'no_device', 'device_unavailable']).has(room['status'])
      && isNullableFiniteNumber(room['currentRoomTemp'])
      && isNullableFiniteNumber(room['humidity'])
      && isNullableFiniteNumber(room['suggestedTemp'])
      && (room['reason'] === null || isBoundedString(room['reason'], 1, 300))
      && isNullableBoolean(room['applied'])
      && isNullableBoolean(room['autoApplyEnabled'])
      && isNullableTimestamp(room['updatedAt']));
}

function isEventsPresentation(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['kind', 'availability', 'id', 'title', 'partId', 'toolName', 'events'])
    && Array.isArray(value['events'])
    && value['events'].length <= 50
    && value['events'].every((event) => isRecord(event)
      && hasExactKeys(event, ['roomName', 'eventType', 'mode', 'detail', 'applied', 'updatedAt'])
      && isBoundedString(event['roomName'], 1, 100)
      && isBoundedString(event['eventType'], 1, 60)
      && (event['mode'] === null || isBoundedString(event['mode'], 1, 40))
      && isBoundedString(event['detail'], 1, 240)
      && isNullableBoolean(event['applied'])
      && isTimestamp(event['updatedAt']));
}

function isHelpPresentation(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, [
    'kind', 'availability', 'id', 'title', 'partId', 'toolName', 'topic', 'steps',
    'route', 'restricted',
  ])
    && isBoundedString(value['topic'], 0, 64)
    && isStringArray(value['steps'], 12, 1, 500)
    && (value['route'] === null || (typeof value['route'] === 'string'
      && value['route'].startsWith('/app/')
      && value['route'].length <= 100))
    && typeof value['restricted'] === 'boolean';
}

function isEvidence(value: unknown): value is ChatEvidenceMetadata {
  return isRecord(value)
    && hasExactKeys(value, ['asOf', 'timeZone', 'source', 'partial', 'notices'])
    && isTimestamp(value['asOf'])
    && value['timeZone'] === 'Asia/Manila'
    && typeof value['source'] === 'string'
    && new Set(['facility', 'application', 'none']).has(value['source'])
    && typeof value['partial'] === 'boolean'
    && isStringArray(value['notices'], 12, 1, 300);
}

function isFollowUp(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['label', 'prompt'])
    && isBoundedString(value['label'], 1, 80)
    && isBoundedString(value['prompt'], 1, MAX_MESSAGE_LENGTH);
}

function isSystemField(value: unknown): value is SystemField {
  return typeof value === 'string' && SYSTEM_FIELDS.has(value as SystemField);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string'
    && Array.from(value).length >= minimum
    && Array.from(value).length <= maximum;
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

function isTimestamp(value: unknown): value is string {
  if (!isBoundedString(value, 1, 50)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime());
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function isNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function hasUnique<T>(items: readonly T[]): boolean {
  return new Set(items).size === items.length;
}

function sameMembers<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}
