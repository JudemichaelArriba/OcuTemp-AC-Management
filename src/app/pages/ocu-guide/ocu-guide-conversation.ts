import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { OcuGuideReportComponent } from '../../components/ocu-guide-report/ocu-guide-report';
import { RenderableChatMessage } from '../../models/chat.models';
import { AuthStateService } from '../../services/auth-state.service';
import { ChatLoadingStage, ChatService } from '../../services/chat.service';

interface LoadingStageItem {
  readonly id: Exclude<ChatLoadingStage, 'idle'>;
  readonly label: string;
  readonly detail: string;
}

interface ChatSuggestion {
  readonly label: string;
  readonly prompt: string;
  readonly icon: string;
}

@Component({
  selector: 'app-ocu-guide-conversation',
  standalone: true,
  imports: [OcuGuideReportComponent],
  templateUrl: './ocu-guide-conversation.html',
  styleUrl: './ocu-guide-conversation.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OcuGuideConversationComponent {
  private readonly chatService = inject(ChatService);
  private readonly authState = inject(AuthStateService);
  private readonly conversationLog = viewChild<ElementRef<HTMLElement>>('conversationLog');
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  private lastRenderedMessageCount = 0;
  private lastRenderedLoading = false;
  private followsLatest = true;
  private readonly dateTimeFormatter = new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  });

  readonly messages = this.chatService.messages;
  readonly loading = this.chatService.loading;
  readonly loadingStage = this.chatService.loadingStage;
  readonly currentUser = toSignal(this.authState.currentUser$, { initialValue: null });
  readonly draft = signal('');
  readonly showJumpToLatest = signal(false);
  readonly maxMessageLength = 500;
  readonly charactersRemaining = computed(() => this.maxMessageLength - this.draft().length);
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
        label: 'Current facility conditions',
        prompt: 'Compare the current temperature, humidity, occupancy, and AC status for every active room.',
        icon: 'sensors',
      },
      {
        label: 'Latest climate guidance',
        prompt: 'Show the latest climate suggestions for every active room and compare them with current temperatures.',
        icon: 'thermostat',
      },
      roleSuggestion,
    ];
  });
  readonly followUpSuggestions = computed<readonly ChatSuggestion[]>(() => {
    const latestAssistant = [...this.messages()].reverse().find((message) => message.role === 'assistant');
    const latestKind = latestAssistant?.presentations.at(-1)?.kind;
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
      default:
        return this.suggestions().slice(0, 2);
    }
  });
  readonly loadingStages: readonly LoadingStageItem[] = [
    { id: 'understanding', label: 'Understanding', detail: 'Interpreting your question and its scope' },
    { id: 'retrieving', label: 'Retrieving', detail: 'Checking whether approved facility data is needed' },
    { id: 'comparing', label: 'Reviewing', detail: 'Reviewing context and any returned records' },
    { id: 'preparing', label: 'Preparing', detail: 'Writing the answer and arranging any visuals' },
  ];

  constructor() {
    afterRenderEffect(() => {
      const messageCount = this.messages().length;
      const isLoading = this.loading();
      const log = this.conversationLog()?.nativeElement;
      const renderedStateChanged = messageCount !== this.lastRenderedMessageCount
        || isLoading !== this.lastRenderedLoading;
      if (messageCount === 0) {
        this.followsLatest = true;
        this.showJumpToLatest.set(false);
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

  focusComposer(): void {
    this.composer()?.nativeElement.focus();
  }

  clearDraft(): void {
    this.draft.set('');
  }

  updateDraft(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement) this.draft.set(target.value.slice(0, this.maxMessageLength));
  }

  async send(override?: string): Promise<void> {
    const message = (override ?? this.draft()).trim();
    if (!message || this.loading()) return;
    this.followsLatest = true;
    this.showJumpToLatest.set(false);
    this.draft.set('');
    this.conversationLog()?.nativeElement.focus({ preventScroll: true });
    try {
      await this.chatService.sendMessage(message);
    } finally {
      queueMicrotask(() => this.focusComposer());
    }
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.send();
  }

  async retry(): Promise<void> {
    if (!this.loading()) {
      this.followsLatest = true;
      this.showJumpToLatest.set(false);
      this.conversationLog()?.nativeElement.focus({ preventScroll: true });
      try {
        await this.chatService.retryLastMessage();
      } finally {
        queueMicrotask(() => this.focusComposer());
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

  stageState(stage: LoadingStageItem['id']): 'complete' | 'active' | 'pending' {
    const activeIndex = this.loadingStages.findIndex((item) => item.id === this.loadingStage());
    const stageIndex = this.loadingStages.findIndex((item) => item.id === stage);
    if (stageIndex < activeIndex) return 'complete';
    return stageIndex === activeIndex ? 'active' : 'pending';
  }

  loadingAnnouncement(): string {
    const active = this.loadingStages.find((item) => item.id === this.loadingStage());
    return active ? `${active.label}: ${active.detail}` : 'OcuGuide is ready.';
  }

  responseAnnouncement(): string {
    const latest = this.messages().at(-1);
    if (!latest || latest.role !== 'assistant') return '';
    if (latest.errorCode) return `OcuGuide could not complete the request: ${latest.text}`;
    const responseLabel = latest.answer?.headline || latest.text;
    return responseLabel ? `OcuGuide response ready: ${responseLabel}` : 'OcuGuide response ready.';
  }

  activeStageDetail(): string {
    return this.loadingStages.find((item) => item.id === this.loadingStage())?.detail
      ?? 'Preparing to answer';
  }

  formatDateTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : this.dateTimeFormatter.format(date);
  }

  canRetry(message: RenderableChatMessage): boolean {
    const latestMessage = this.messages().at(-1);
    return Boolean(latestMessage?.id === message.id
      && message.errorCode && message.errorCode !== 'invalid_request'
      && message.errorCode !== 'authentication_required'
      && message.errorCode !== 'account_not_authorized');
  }

  private buildCurrentMonthSuggestion(): string {
    const month = new Date().toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'Asia/Manila' });
    return `Show estimated energy for the current month (${month}) for every active room.`;
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
}
