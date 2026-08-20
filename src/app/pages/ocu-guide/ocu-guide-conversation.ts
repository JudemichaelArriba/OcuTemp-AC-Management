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
import { ChatAnswerBlock, ChatPresentation, RenderableChatMessage } from '../../models/chat.models';
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
  readonly generalSuggestions: readonly ChatSuggestion[] = [
    {
      label: 'Understand humidity',
      prompt: 'What is relative humidity, and why does it matter for indoor comfort?',
      icon: 'humidity_percentage',
    },
    {
      label: 'Reduce AC energy waste',
      prompt: 'What practical steps can reduce AC energy waste?',
      icon: 'energy_savings_leaf',
    },
  ];
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
        label: 'Current facility conditions',
        prompt: 'Compare the current temperature, humidity, occupancy, and AC status for every active room.',
        icon: 'sensors',
      },
      {
        label: 'This month\'s energy',
        prompt: this.primarySuggestion,
        icon: 'calendar_month',
      },
      roleSuggestion,
    ];
  });
  readonly followUpSuggestions = computed<readonly ChatSuggestion[]>(() => {
    const latestAssistant = [...this.messages()].reverse().find((message) => message.role === 'assistant');
    const latestPresentation = [...(latestAssistant?.presentations ?? [])]
      .reverse()
      .find((presentation) => this.hasUsefulResult(presentation));
    const latestKind = latestPresentation?.kind;
    switch (latestKind) {
      case 'energy-report':
        return [
          { label: 'Compare conditions', prompt: 'Compare the highest-energy rooms with their current temperature and occupancy.', icon: 'compare_arrows' },
          { label: 'Check another period', prompt: 'Show estimated energy for every active room over the last 7 days.', icon: 'date_range' },
        ];
      case 'room-telemetry':
        return [
          { label: 'Find rooms needing attention', prompt: 'Which active rooms need attention based on the current facility conditions?', icon: 'warning' },
          { label: 'Review climate guidance', prompt: 'Show the latest climate suggestions for the rooms that need attention.', icon: 'thermostat' },
        ];
      case 'climate-suggestions':
        return [
          { label: 'Compare live conditions', prompt: 'Compare these climate suggestions with the current room conditions.', icon: 'sensors' },
          { label: 'Review recent events', prompt: 'Show recent operational events for the rooms in this result.', icon: 'history' },
        ];
      case 'recent-events':
        return [
          { label: 'Check current state', prompt: 'Show the current conditions for the rooms in these recent events.', icon: 'sensors' },
          { label: 'Review energy', prompt: 'Show estimated energy for every active room over the last 7 days.', icon: 'bolt' },
        ];
      default: {
        const [facilitySuggestion, , roleSuggestion] = this.suggestions();
        return [facilitySuggestion, roleSuggestion].filter(
          (suggestion): suggestion is ChatSuggestion => suggestion !== undefined,
        );
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
      case 'room-telemetry':
        return `Current telemetry for ${presentation.rooms.length} room${presentation.rooms.length === 1 ? '' : 's'}.`;
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

  hasFacilityData(presentations: readonly ChatPresentation[]): boolean {
    return presentations.some((presentation) => (
      presentation.availability === 'available' && presentation.kind !== 'system-help'
    ));
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
          room.onlineState !== 'unknown'
          || room.condition !== 'unknown'
          || room.temperature !== null
          || room.humidity !== null
          || room.occupancy !== null
          || room.acPower !== null
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
