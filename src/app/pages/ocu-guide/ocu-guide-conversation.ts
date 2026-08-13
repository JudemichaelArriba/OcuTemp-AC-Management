import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RenderableChatMessage } from '../../models/chat.models';
import { ChatLoadingStage, ChatService } from '../../services/chat.service';

interface LoadingStageItem {
  readonly id: Exclude<ChatLoadingStage, 'idle'>;
  readonly label: string;
  readonly detail: string;
}

@Component({
  selector: 'app-ocu-guide-conversation',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ocu-guide-conversation.html',
  styleUrl: './ocu-guide-conversation.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OcuGuideConversationComponent {
  private readonly chatService = inject(ChatService);
  private readonly conversationLog = viewChild<ElementRef<HTMLElement>>('conversationLog');
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  private lastRenderedMessageCount = 0;

  readonly reportRequested = output<void>();
  readonly messages = this.chatService.messages;
  readonly loading = this.chatService.loading;
  readonly loadingStage = this.chatService.loadingStage;
  readonly draft = signal('');
  readonly maxMessageLength = 500;
  readonly charactersRemaining = computed(() => this.maxMessageLength - this.draft().length);
  readonly primarySuggestion = this.buildCurrentMonthSuggestion();
  readonly suggestions: readonly { label: string; prompt: string; icon: string }[] = [
    { label: 'Current facility conditions', prompt: 'Compare the current temperature, humidity, occupancy, and AC status for every active room.', icon: 'sensors' },
    { label: 'Latest climate guidance', prompt: 'Show the latest climate suggestions for every active room and compare them with current temperatures.', icon: 'thermostat' },
    { label: 'Recent room events', prompt: 'Show the most recent operational events across all active rooms.', icon: 'history' },
  ];
  readonly loadingStages: readonly LoadingStageItem[] = [
    { id: 'understanding', label: 'Understanding', detail: 'Checking the request and reporting scope' },
    { id: 'retrieving', label: 'Retrieving', detail: 'Reading approved OcuTemp records' },
    { id: 'comparing', label: 'Comparing', detail: 'Organizing rooms, periods, and evidence' },
    { id: 'preparing', label: 'Preparing', detail: 'Building the grounded report' },
  ];

  constructor() {
    afterRenderEffect(() => {
      const messageCount = this.messages().length;
      const log = this.conversationLog()?.nativeElement;
      if (log && messageCount !== this.lastRenderedMessageCount) {
        this.lastRenderedMessageCount = messageCount;
        log.scrollTo({ top: log.scrollHeight, behavior: this.prefersReducedMotion() ? 'auto' : 'smooth' });
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
    this.draft.set('');
    await this.chatService.sendMessage(message);
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.send();
  }

  async retry(): Promise<void> {
    if (!this.loading()) await this.chatService.retryLastMessage();
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

  canRetry(message: RenderableChatMessage): boolean {
    return Boolean(message.errorCode && message.errorCode !== 'invalid_request'
      && message.errorCode !== 'authentication_required'
      && message.errorCode !== 'account_not_authorized');
  }

  private buildCurrentMonthSuggestion(): string {
    const month = new Date().toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'Asia/Manila' });
    return `Show estimated energy for the current month (${month}) for every active room.`;
  }

  private prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
}
