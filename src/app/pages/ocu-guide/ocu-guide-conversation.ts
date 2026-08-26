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
import { OcuGuideReportComponent } from '../../components/ocu-guide-report/ocu-guide-report';
import {
  ChatAnswerBlock,
  ChatAnswerPart,
  ChatDisplayDirective,
  ChatPartId,
  ChatPresentation,
  ChatResponseContext,
  RenderableChatMessage,
} from '../../models/chat.models';
import { ChatService } from '../../services/chat.service';

interface ChatSuggestion {
  readonly label: string;
  readonly prompt: string;
  readonly icon: string;
  readonly description?: string;
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
  host: { class: 'block h-full min-h-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OcuGuideConversationComponent implements OnDestroy {
  private readonly chatService = inject(ChatService);
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
  readonly draft = signal('');
  readonly showJumpToLatest = signal(false);
  readonly maxMessageLength = 500;
  readonly charactersRemaining = computed(() => (
    this.maxMessageLength - Array.from(this.draft()).length
  ));
  readonly suggestions: readonly ChatSuggestion[] = [
    {
      label: 'Room and device overview',
      prompt: 'How many rooms are in OcuTemp, and how many have an online device?',
      icon: 'domain',
      description: 'Configured rooms and device connectivity',
    },
    {
      label: 'Rooms with AC on',
      prompt: 'Which rooms currently have their AC on?',
      icon: 'mode_fan',
      description: 'Current verified AC power states',
    },
    {
      label: 'Available rooms',
      prompt: 'Which rooms are currently available or unoccupied?',
      icon: 'meeting_room',
      description: 'Latest room occupancy information',
    },
    {
      label: 'Energy comparison',
      prompt: 'Compare room energy usage for the current month.',
      icon: 'query_stats',
      description: 'Compare recorded monthly estimates',
    },
  ];
  readonly latestFollowUps = computed<readonly ChatSuggestion[]>(() => {
    const latest = [...this.messages()].reverse().find((message) => message.role === 'assistant');
    if (!latest || latest.errorCode) return [];
    return latest.followUps.map((followUp) => ({
      label: followUp.label,
      prompt: followUp.prompt,
      icon: 'north_east',
    }));
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
        this.openToolTurns.set(new Set());
        this.openToolResultTurns.set(new Set());
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
    this.openToolTurns.set(new Set());
    this.openToolResultTurns.set(new Set());
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
    if (this.loading()) return;
    const previouslyFocused = typeof document === 'undefined' ? null : document.activeElement;
    this.followsLatest = true;
    this.showJumpToLatest.set(false);
    try {
      await this.chatService.retryLastMessage();
    } finally {
      queueMicrotask(() => this.restoreComposerFocus(previouslyFocused));
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
    return this.loading() ? 'OcuGuide is checking verified OcuTemp information.' : 'OcuGuide is ready.';
  }

  responseAnnouncement(): string {
    const latest = this.messages().at(-1);
    if (!latest || latest.role !== 'assistant') return '';
    return latest.errorCode
      ? `OcuGuide could not complete the request: ${latest.text}`
      : `OcuGuide response ready: ${latest.answerParts.map((part) => part.text).join(' ')}`;
  }

  canRetry(message: RenderableChatMessage): boolean {
    const latest = this.messages().at(-1);
    return Boolean(latest?.id === message.id
      && message.errorCode
      && RETRYABLE_CHAT_ERROR_CODES.has(message.errorCode));
  }

  contextFor(message: RenderableChatMessage, partId: ChatPartId): ChatResponseContext | undefined {
    return message.responseContexts.find((context) => context.partId === partId);
  }

  directiveFor(message: RenderableChatMessage, partId: ChatPartId): ChatDisplayDirective | undefined {
    return message.displayPlan.find((directive) => directive.partId === partId);
  }

  presentationFor(
    message: RenderableChatMessage,
    directive: ChatDisplayDirective,
  ): ChatPresentation | undefined {
    return message.presentations.find((presentation) => (
      presentation.id === directive.presentationId && presentation.partId === directive.partId
    ));
  }

  shouldRenderBlock(part: ChatAnswerPart, block: ChatAnswerBlock): boolean {
    if (block.kind !== 'paragraph') return true;
    return this.normalizeText(block.text) !== this.normalizeText(part.text);
  }

  answerPartTrackKey(part: ChatAnswerPart): string {
    return part.partId;
  }

  answerBlockTrackKey(block: ChatAnswerBlock, index: number): string {
    return [block.kind, block.text, block.items.join('\u0001'), index].join('\u0000');
  }

  textTrackKey(value: string, index: number): string {
    return `${value}\u0000${index}`;
  }

  evidenceLabel(message: RenderableChatMessage): string {
    const evidence = message.evidence;
    if (!evidence) return '';
    const source = evidence.source === 'facility'
      ? 'Verified facility data'
      : evidence.source === 'application'
        ? 'Verified OcuTemp guidance'
        : '';
    if (!source) return '';
    return `${source} · ${this.formatDateTime(evidence.asOf)}`;
  }

  isToolDisclosureOpen(turnId: string): boolean {
    return this.openToolTurns().has(turnId);
  }

  toggleToolDisclosure(turnId: string): void {
    const next = new Set(this.openToolTurns());
    if (next.has(turnId)) {
      next.delete(turnId);
      const resultTurns = new Set(this.openToolResultTurns());
      resultTurns.delete(turnId);
      this.openToolResultTurns.set(resultTurns);
    } else {
      next.add(turnId);
    }
    this.openToolTurns.set(next);
  }

  isToolResultOpen(turnId: string): boolean {
    return this.openToolResultTurns().has(turnId);
  }

  toggleToolResults(turnId: string): void {
    const next = new Set(this.openToolResultTurns());
    if (next.has(turnId)) next.delete(turnId);
    else next.add(turnId);
    this.openToolResultTurns.set(next);
  }

  toolDisclosureId(turnId: string): string {
    return `ocu-guide-tools-${turnId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  }

  toolResultId(turnId: string): string {
    return `ocu-guide-results-${turnId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  }

  toolLabel(presentation: ChatPresentation): string {
    const labels: Record<ChatPresentation['toolName'], string> = {
      get_facility_summary: 'Facility summary',
      get_room_telemetry: 'Room telemetry',
      get_energy_report: 'Energy report',
      get_climate_prediction_logs: 'Climate suggestions',
      get_recent_room_events: 'Recent room events',
      get_system_help: 'Verified app guidance',
      get_admin_user_aggregates: 'User aggregates',
    };
    return labels[presentation.toolName];
  }

  toolResultSummary(presentation: ChatPresentation): string {
    if (presentation.availability === 'unavailable') return 'Verified data was unavailable.';
    switch (presentation.kind) {
      case 'metric-summary':
        return `${presentation.metrics.length} projected metric${presentation.metrics.length === 1 ? '' : 's'}.`;
      case 'room-data':
        return `${presentation.rooms.length} projected room record${presentation.rooms.length === 1 ? '' : 's'}.`;
      case 'schedule-data':
        return `${presentation.schedules.length} configured schedule entr${presentation.schedules.length === 1 ? 'y' : 'ies'}.`;
      case 'energy-report':
        return `${presentation.metrics.roomsWithRecords} of ${presentation.metrics.activeRooms} rooms have recorded energy data.`;
      case 'room-telemetry':
        return `${presentation.rooms.length} projected room record${presentation.rooms.length === 1 ? '' : 's'}.`;
      case 'climate-suggestions':
        return `${presentation.rooms.length} projected climate-suggestion record${presentation.rooms.length === 1 ? '' : 's'}.`;
      case 'recent-events':
        return `${presentation.events.length} projected event${presentation.events.length === 1 ? '' : 's'}.`;
      case 'system-help':
        return presentation.restricted
          ? 'Role-restricted guidance.'
          : `${presentation.steps.length} verified step${presentation.steps.length === 1 ? '' : 's'}.`;
    }
  }

  safePresentationJson(presentations: readonly ChatPresentation[]): string {
    const cached = this.serializedPresentationCache.get(presentations);
    if (cached) return cached;
    const projectedResults = presentations.map((presentation) => {
      const { id: _id, partId: _partId, toolName: _toolName, ...safeResult } = presentation;
      return safeResult;
    });
    const serialized = JSON.stringify(projectedResults, null, 2);
    this.serializedPresentationCache.set(presentations, serialized);
    return serialized;
  }

  private formatDateTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Time unavailable' : this.dateTimeFormatter.format(date);
  }

  private truncateToCodePoints(value: string): string {
    return Array.from(value).slice(0, this.maxMessageLength).join('');
  }

  private resizeComposer(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`;
  }

  private resetComposerHeight(): void {
    const textarea = this.composer()?.nativeElement;
    if (textarea) textarea.style.height = 'auto';
  }

  private restoreComposerFocus(previouslyFocused: Element | null): void {
    if (previouslyFocused === this.composer()?.nativeElement || previouslyFocused === null) {
      this.focusComposer();
    }
  }

  private normalizeText(value: string): string {
    return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
  }

  private isNearBottom(log: HTMLElement): boolean {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= 96;
  }

  private scrollLogToBottom(log: HTMLElement): void {
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  }

  private observeConversationContent(content: HTMLElement | undefined, log: HTMLElement | undefined): void {
    if (!content || !log || this.observedConversationContent === content) return;
    this.resizeObserver?.disconnect();
    this.observedConversationContent = content;
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.followsLatest) this.scrollLogToBottom(log);
    });
    this.resizeObserver.observe(content);
  }
}
