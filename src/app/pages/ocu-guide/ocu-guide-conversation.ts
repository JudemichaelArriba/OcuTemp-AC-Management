import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { OcuGuideReportComponent } from '../../components/ocu-guide-report/ocu-guide-report';
import {
  ChatAnswerBlock,
  ChatDisplayDirective,
  ChatPresentation,
  ChatQuestionFocus,
  RenderableChatMessage,
} from '../../models/chat.models';
import { AuthStateService } from '../../services/auth-state.service';
import { ChatService } from '../../services/chat.service';

interface ChatSuggestion {
  readonly label: string;
  readonly prompt: string;
  readonly icon: string;
}

const RETRYABLE_CHAT_ERROR_CODES = new Set([
  'assistant_unavailable',
  'context_invalid',
  'data_unavailable',
  'rate_limited',
]);

@Component({
  selector: 'app-ocu-guide-conversation',
  standalone: true,
  imports: [OcuGuideReportComponent],
  templateUrl: './ocu-guide-conversation.html',
  styleUrl: './ocu-guide-conversation.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OcuGuideConversationComponent implements OnDestroy {
  private readonly chatService = inject(ChatService);
  private readonly authState = inject(AuthStateService);
  private readonly conversationLog = viewChild<ElementRef<HTMLElement>>('conversationLog');
  private readonly conversationContent = viewChild<ElementRef<HTMLElement>>('conversationContent');
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  private lastRenderedMessageCount = 0;
  private lastRenderedLoading = false;
  private followsLatest = true;
  private resizeObserver?: ResizeObserver;
  private observedConversationContent?: HTMLElement;
  private readonly openToolTurns = signal<ReadonlySet<string>>(new Set());
  private readonly openToolResultTurns = signal<ReadonlySet<string>>(new Set());
  private readonly serializedPresentationCache = new WeakMap<readonly ChatPresentation[], string>();
  private readonly dateTimeFormatter = new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  });

  readonly messages = this.chatService.messages;
  readonly loading = this.chatService.loading;
  readonly currentUser = toSignal(this.authState.currentUser$, { initialValue: null });
  readonly draft = signal('');
  readonly showJumpToLatest = signal(false);
  readonly maxMessageLength = 500;
  readonly charactersRemaining = computed(() => (
    this.maxMessageLength - Array.from(this.draft()).length
  ));
  readonly primarySuggestion = this.buildCurrentMonthSuggestion();
  readonly suggestions = computed<readonly ChatSuggestion[]>(() => {
    const roleSuggestion: ChatSuggestion = this.currentUser()?.role === 'admin'
      ? {
          label: 'Staff approvals',
          prompt: 'How do I review and approve a staff account in OcuTemp?',
          icon: 'admin_panel_settings',
        }
      : {
          label: 'Room workflow',
          prompt: 'How do I review a room and safely manage its AC controls in OcuTemp?',
          icon: 'map',
        };
    return [
      {
        label: 'Current room temperatures',
        prompt: 'What is the current temperature in every active room?',
        icon: 'sensors',
      },
      {
        label: 'This month\'s energy',
        prompt: this.primarySuggestion,
        icon: 'calendar_month',
      },
      {
        label: 'AI auto-apply status',
        prompt: 'Which active rooms have AI auto-apply enabled in OcuTemp?',
        icon: 'auto_awesome',
      },
      {
        label: 'Configured schedules',
        prompt: 'List the configured schedules for every active room.',
        icon: 'event_note',
      },
      roleSuggestion,
    ];
  });
  readonly followUpSuggestions = computed<readonly ChatSuggestion[]>(() => {
    const latestAssistant = [...this.messages()].reverse().find((message) => message.role === 'assistant');
    if (!latestAssistant || latestAssistant.errorCode) return [];
    const usefulPresentations = latestAssistant.presentations.filter((presentation) => (
      this.hasUsefulResult(presentation)
    ));
    const hasUsefulEnergy = usefulPresentations.some((item) => item.kind === 'energy-report');
    const hasUsefulTelemetry = latestAssistant.presentations.some((item) => (
      item.kind === 'room-telemetry'
      && this.hasUsefulTelemetryForFocus(item, latestAssistant.questionFocus)
    ));

    switch (latestAssistant.questionFocus) {
      case 'energy_report':
        if (!hasUsefulEnergy) return [];
        return [
          { label: 'Who ranked first?', prompt: 'Who ranked first?', icon: 'workspace_premium' },
          { label: 'Show the trend', prompt: 'Show the energy trend for that same report.', icon: 'show_chart' },
        ];
      case 'energy_total':
      case 'energy_rank_winner':
      case 'energy_ranking':
      case 'energy_trend':
        if (!hasUsefulEnergy) return [];
        return [
          { label: 'Show the ranking', prompt: 'Show the room ranking for that same energy period.', icon: 'leaderboard' },
          { label: 'Show the trend', prompt: 'Show the energy trend for that same period.', icon: 'show_chart' },
        ];
      case 'current_temperature':
      case 'current_humidity':
      case 'current_condition':
      case 'device_status':
      case 'ac_power_status':
        if (!hasUsefulTelemetry) {
          return latestAssistant.questionFocus === 'current_temperature'
            ? [{ label: 'Check last-known readings', prompt: 'Show the last-known temperature for every active room.', icon: 'history' }]
            : [];
        }
        return [
          { label: 'Check AI auto-apply', prompt: 'Which of those rooms have AI auto-apply enabled?', icon: 'auto_awesome' },
          { label: 'List schedules', prompt: 'List the configured schedules for those rooms.', icon: 'event_note' },
        ];
      case 'ai_auto_apply_status':
      case 'schedule_count':
      case 'schedule_list':
        if (!hasUsefulTelemetry) return [];
        return [
          { label: 'Check current status', prompt: 'Show the current device status for those rooms.', icon: 'sensors' },
        ];
      case 'climate_suggestion':
        return usefulPresentations.some((item) => item.kind === 'climate-suggestions')
          ? [{ label: 'Check current readings', prompt: 'Compare those suggestions with current online room readings.', icon: 'sensors' }]
          : [];
      case 'recent_events':
        return usefulPresentations.some((item) => item.kind === 'recent-events')
          ? [{ label: 'Check current status', prompt: 'Show the current device status for the rooms in those events.', icon: 'sensors' }]
          : [];
      default: {
        return [];
      }
    }
  });

  constructor() {
    afterRenderEffect(() => {
      const messageCount = this.messages().length;
      const isLoading = this.loading();
      const log = this.conversationLog()?.nativeElement;
      this.observeConversationContent(this.conversationContent()?.nativeElement, log);
      const renderedStateChanged = messageCount !== this.lastRenderedMessageCount
        || isLoading !== this.lastRenderedLoading;
      if (messageCount === 0) {
        this.followsLatest = true;
        this.showJumpToLatest.set(false);
        if (this.openToolTurns().size > 0) this.openToolTurns.set(new Set<string>());
        if (this.openToolResultTurns().size > 0) this.openToolResultTurns.set(new Set<string>());
      }
      if (log && renderedStateChanged && this.followsLatest) {
        this.lastRenderedMessageCount = messageCount;
        this.lastRenderedLoading = isLoading;
        queueMicrotask(() => this.scrollLogToBottom(log));
      } else if (renderedStateChanged) {
        this.lastRenderedMessageCount = messageCount;
        this.lastRenderedLoading = isLoading;
        if (messageCount > 0) this.showJumpToLatest.set(true);
      }
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  focusComposer(): void {
    this.composer()?.nativeElement.focus();
  }

  clearDraft(): void {
    this.draft.set('');
    this.openToolTurns.set(new Set<string>());
    this.openToolResultTurns.set(new Set<string>());
    this.resetComposerHeight();
  }

  updateDraft(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    const value = this.truncateToCodePoints(target.value);
    if (target.value !== value) target.value = value;
    this.draft.set(value);
    this.resizeComposer(target);
  }

  async send(override?: string): Promise<void> {
    const message = this.truncateToCodePoints(override ?? this.draft()).trim();
    if (!message || this.loading()) return;
    const previouslyFocused = typeof document === 'undefined' ? null : document.activeElement;
    this.followsLatest = true;
    this.showJumpToLatest.set(false);
    this.draft.set('');
    this.resetComposerHeight();
    try {
      await this.chatService.sendMessage(message);
    } finally {
      queueMicrotask(() => this.restoreComposerFocus(previouslyFocused));
    }
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.send();
  }

  async retry(): Promise<void> {
    if (!this.loading()) {
      const previouslyFocused = typeof document === 'undefined' ? null : document.activeElement;
      this.followsLatest = true;
      this.showJumpToLatest.set(false);
      try {
        await this.chatService.retryLastMessage();
      } finally {
        queueMicrotask(() => this.restoreComposerFocus(previouslyFocused));
      }
    }
  }

  onConversationScroll(): void {
    const log = this.conversationLog()?.nativeElement;
    if (!log) return;
    this.followsLatest = this.isNearBottom(log);
    this.showJumpToLatest.set(!this.followsLatest);
  }

  jumpToLatest(): void {
    const log = this.conversationLog()?.nativeElement;
    if (!log) return;
    this.followsLatest = true;
    this.showJumpToLatest.set(false);
    log.focus({ preventScroll: true });
    this.scrollLogToBottom(log);
  }

  loadingAnnouncement(): string {
    return this.loading() ? 'OcuGuide is preparing a response.' : 'OcuGuide is ready.';
  }

  responseAnnouncement(): string {
    const latest = this.messages().at(-1);
    if (!latest || latest.role !== 'assistant') return '';
    if (latest.errorCode) return `OcuGuide could not complete the request: ${latest.text}`;
    const responseLabel = latest.answer?.headline || latest.text;
    return responseLabel ? `OcuGuide response ready: ${responseLabel}` : 'OcuGuide response ready.';
  }

  formatDateTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : this.dateTimeFormatter.format(date);
  }

  canRetry(message: RenderableChatMessage): boolean {
    const latestMessage = this.messages().at(-1);
    return Boolean(latestMessage?.id === message.id
      && message.errorCode
      && RETRYABLE_CHAT_ERROR_CODES.has(message.errorCode));
  }

  isToolDisclosureOpen(turnId: string): boolean {
    return this.openToolTurns().has(turnId);
  }

  toggleToolDisclosure(turnId: string): void {
    const next = new Set(this.openToolTurns());
    if (next.has(turnId)) {
      next.delete(turnId);
      const openResults = new Set(this.openToolResultTurns());
      openResults.delete(turnId);
      this.openToolResultTurns.set(openResults);
    } else {
      next.add(turnId);
    }
    this.openToolTurns.set(next);
  }

  isToolResultOpen(turnId: string): boolean {
    return this.openToolResultTurns().has(turnId);
  }

  onToolResultToggle(turnId: string, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLDetailsElement)) return;
    const next = new Set(this.openToolResultTurns());
    if (target.open) next.add(turnId);
    else next.delete(turnId);
    this.openToolResultTurns.set(next);
  }

  toolDisclosureId(turnId: string): string {
    return `ocu-guide-tools-${turnId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  toolName(presentation: ChatPresentation): string {
    switch (presentation.kind) {
      case 'energy-report': return 'get_energy_report';
      case 'room-telemetry': return 'get_room_telemetry';
      case 'climate-suggestions': return 'get_climate_prediction_logs';
      case 'recent-events': return 'get_recent_room_events';
      case 'system-help': return 'get_system_help';
    }
  }

  toolResultSummary(presentation: ChatPresentation): string {
    if (presentation.availability === 'unavailable') {
      return presentation.kind === 'system-help'
        ? 'Verified OcuTemp guidance was unavailable.'
        : 'Facility data was unavailable, so no values are presented.';
    }
    switch (presentation.kind) {
      case 'energy-report':
        return `${presentation.rooms.length} room${presentation.rooms.length === 1 ? '' : 's'} for ${presentation.range.label}; ${presentation.metrics.coveragePercent}% recorded-data coverage.`;
      case 'room-telemetry': {
        const current = presentation.rooms.filter((room) => room.measurementStatus === 'current').length;
        const lastKnown = presentation.rooms.filter((room) => (
          (room.measurementStatus === 'stale' || room.measurementStatus === 'offline')
          && (room.temperature !== null
            || room.humidity !== null
            || room.occupancy !== null
            || room.acPower !== null)
        )).length;
        const configured = presentation.rooms.filter((room) => (
          room.aiAutoApply !== null || room.schedules.length > 0
        )).length;
        const noDevice = presentation.rooms.filter((room) => (
          room.deviceAssignmentStatus === 'not_assigned'
        )).length;
        const unavailableDevice = presentation.rooms.filter((room) => (
          room.deviceAssignmentStatus === 'unavailable'
        )).length;
        const parts = [`${presentation.rooms.length} room${presentation.rooms.length === 1 ? '' : 's'} returned`];
        if (current > 0) parts.push(`${current} with current readings`);
        if (lastKnown > 0) parts.push(`${lastKnown} with explicitly requested last-known readings`);
        if (configured > 0) parts.push(`${configured} with stored configuration`);
        if (noDevice > 0) parts.push(`${noDevice} without an assigned device`);
        if (unavailableDevice > 0) parts.push(`${unavailableDevice} with unavailable device data`);
        return `${parts.join('; ')}.`;
      }
      case 'climate-suggestions': {
        const available = presentation.rooms.filter((room) => room.status === 'available').length;
        return `${available} available suggestion${available === 1 ? '' : 's'} across ${presentation.rooms.length} room${presentation.rooms.length === 1 ? '' : 's'}.`;
      }
      case 'recent-events':
        return `${presentation.events.length} recent event${presentation.events.length === 1 ? '' : 's'} returned.`;
      case 'system-help':
        return presentation.restricted
          ? `Role-restricted guidance for ${presentation.topic}.`
          : `${presentation.steps.length} verified step${presentation.steps.length === 1 ? '' : 's'} for ${presentation.topic}.`;
    }
  }

  isRepeatedSummary(block: ChatAnswerBlock, summary: string): boolean {
    if (block.kind !== 'paragraph') return false;
    return this.normalizeAnswerText(block.text) === this.normalizeAnswerText(summary);
  }

  isRepeatedAnswerText(
    value: string,
    summary: string,
    blocks: readonly ChatAnswerBlock[] = [],
  ): boolean {
    const normalized = this.normalizeAnswerText(value);
    if (normalized === this.normalizeAnswerText(summary)) return true;
    return blocks.some((block) => (
      (block.text && this.normalizeAnswerText(block.text) === normalized)
      || block.items.some((item) => this.normalizeAnswerText(item) === normalized)
      || block.entries.some((entry) => (
        this.normalizeAnswerText(`${entry.label} ${entry.value}`) === normalized
        || this.normalizeAnswerText(entry.value) === normalized
      ))
    ));
  }

  hasAdditionalHighlights(
    highlights: readonly { readonly text: string }[],
    summary: string,
    blocks: readonly ChatAnswerBlock[],
  ): boolean {
    return highlights.some((highlight) => (
      !this.isRepeatedAnswerText(highlight.text, summary, blocks)
    ));
  }

  shouldRenderAnswerDetails(message: RenderableChatMessage): boolean {
    if (message.displayPlan.length === 0) return true;
    switch (message.questionFocus) {
      case 'current_temperature':
      case 'last_known_temperature':
      case 'current_humidity':
      case 'current_condition':
      case 'device_status':
      case 'ac_power_status':
      case 'ai_auto_apply_status':
      case 'schedule_list':
      case 'energy_rank_winner':
      case 'energy_ranking':
      case 'energy_trend':
      case 'climate_suggestion':
      case 'recent_events':
      case 'system_help':
        return false;
      default:
        return true;
    }
  }

  hasFacilityData(
    focus: ChatQuestionFocus | undefined,
    presentations: readonly ChatPresentation[],
  ): boolean {
    if (focus === 'room_existence' || focus === 'system_help' ||
      focus === 'greeting' || focus === 'control_request' || focus === 'unsupported') return false;
    return presentations.some((presentation) => (
      presentation.kind !== 'system-help' && this.hasUsefulResult(presentation)
    ));
  }

  visibleDirective(message: RenderableChatMessage): ChatDisplayDirective | null {
    return message.displayPlan[0] ?? null;
  }

  visiblePresentation(
    message: RenderableChatMessage,
    directive: ChatDisplayDirective,
  ): ChatPresentation | null {
    return message.presentations.find((presentation) => (
      presentation.id === directive.presentationId
    )) ?? null;
  }

  answerBlockTrackKey(block: ChatAnswerBlock, index: number): string {
    return [
      block.kind,
      block.text,
      block.items.join('\u0001'),
      block.entries.map((entry) => `${entry.label}\u0002${entry.value}`).join('\u0001'),
      block.tone,
      index,
    ].join('\u0000');
  }

  textTrackKey(value: string, index: number): string {
    return `${value}\u0000${index}`;
  }

  keyValueTrackKey(entry: ChatAnswerBlock['entries'][number], index: number): string {
    return `${entry.label}\u0000${entry.value}\u0000${index}`;
  }

  safePresentationJson(presentations: readonly ChatPresentation[]): string {
    const cached = this.serializedPresentationCache.get(presentations);
    if (cached) return cached;
    const inspectable = presentations.map((presentation) => (
      presentation.availability === 'unavailable'
        ? {
            kind: presentation.kind,
            availability: presentation.availability,
            id: presentation.id,
            title: presentation.title,
          }
        : presentation
    ));
    const serialized = JSON.stringify(inspectable, null, 2);
    this.serializedPresentationCache.set(presentations, serialized);
    return serialized;
  }

  private hasUsefulResult(presentation: ChatPresentation): boolean {
    if (presentation.availability !== 'available') return false;
    switch (presentation.kind) {
      case 'energy-report':
        return presentation.metrics.roomsWithRecords > 0;
      case 'room-telemetry':
        return presentation.rooms.some((room) => (
          room.deviceAssignmentStatus !== 'assigned'
          || room.onlineState !== 'unknown'
          || room.condition !== 'unknown'
          || room.temperature !== null
          || room.humidity !== null
          || room.occupancy !== null
          || room.acPower !== null
          || room.aiAutoApply !== null
          || room.schedules.length > 0
        ));
      case 'climate-suggestions':
        return presentation.rooms.some((room) => room.status === 'available');
      case 'recent-events':
        return presentation.events.length > 0;
      case 'system-help':
        return !presentation.restricted && presentation.steps.length > 0;
    }
  }

  private hasUsefulTelemetryForFocus(
    presentation: Extract<ChatPresentation, { readonly kind: 'room-telemetry' }>,
    focus: RenderableChatMessage['questionFocus'],
  ): boolean {
    switch (focus) {
      case 'current_temperature':
        return presentation.rooms.some((room) => (
          room.measurementStatus === 'current' && room.temperature !== null
        ));
      case 'last_known_temperature':
        return presentation.rooms.some((room) => room.temperature !== null);
      case 'current_humidity':
        return presentation.rooms.some((room) => (
          room.measurementStatus === 'current' && room.humidity !== null
        ));
      case 'current_condition':
        return presentation.rooms.some((room) => (
          room.measurementStatus === 'current' && room.condition !== 'unknown'
        ));
      case 'ac_power_status':
        return presentation.rooms.some((room) => (
          room.measurementStatus === 'current' && room.acPower !== null
        ));
      case 'ai_auto_apply_status':
        return presentation.rooms.some((room) => room.aiAutoApply !== null);
      case 'schedule_count':
      case 'schedule_list':
        return presentation.rooms.some((room) => room.schedules.length > 0);
      case 'device_status':
        return presentation.rooms.some((room) => room.onlineState !== 'unknown');
      default:
        return presentation.rooms.some((room) => (
          room.measurementStatus !== 'unavailable'
          || room.aiAutoApply !== null
          || room.schedules.length > 0
        ));
    }
  }

  private buildCurrentMonthSuggestion(): string {
    const month = new Date().toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'Asia/Manila' });
    return `Show estimated energy for the current month (${month}) for every active room.`;
  }

  private normalizeAnswerText(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
  }

  private observeConversationContent(content: HTMLElement | undefined, log: HTMLElement | undefined): void {
    if (!content || !log || typeof ResizeObserver === 'undefined') return;
    if (this.observedConversationContent === content) return;

    this.resizeObserver?.disconnect();
    this.observedConversationContent = content;
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.followsLatest || this.conversationLog()?.nativeElement !== log) return;
      queueMicrotask(() => {
        if (!this.followsLatest || this.conversationLog()?.nativeElement !== log) return;
        this.showJumpToLatest.set(false);
        this.scrollLogToBottom(log);
      });
    });
    this.resizeObserver.observe(content);
  }

  private restoreComposerFocus(previouslyFocused: Element | null): void {
    if (typeof document === 'undefined') return;
    const activeElement = document.activeElement;
    const focusWasNotMoved = activeElement === previouslyFocused
      || activeElement === document.body
      || activeElement === null
      || !activeElement.isConnected;
    if (focusWasNotMoved) this.focusComposer();
  }

  private truncateToCodePoints(value: string): string {
    const codePoints = Array.from(value);
    return codePoints.length <= this.maxMessageLength
      ? value
      : codePoints.slice(0, this.maxMessageLength).join('');
  }

  private isNearBottom(log: HTMLElement): boolean {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= 96;
  }

  private scrollLogToBottom(log: HTMLElement): void {
    log.scrollTo({
      top: log.scrollHeight,
      behavior: 'auto',
    });
  }

  private resizeComposer(target = this.composer()?.nativeElement): void {
    if (!target) return;
    const maximumHeight = 160;
    target.style.height = 'auto';
    const nextHeight = Math.min(target.scrollHeight, maximumHeight);
    target.style.height = `${nextHeight}px`;
    target.style.overflowY = target.scrollHeight > maximumHeight ? 'auto' : 'hidden';
  }

  private resetComposerHeight(): void {
    const target = this.composer()?.nativeElement;
    if (!target) return;
    target.style.height = '';
    target.style.overflowY = 'hidden';
  }
}
