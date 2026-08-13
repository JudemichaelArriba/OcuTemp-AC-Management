import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { OcuGuideReportComponent } from '../../components/ocu-guide-report/ocu-guide-report';
import { ChatService } from '../../services/chat.service';
import { OcuGuideConversationComponent } from './ocu-guide-conversation';

type MobileWorkspaceTab = 'chat' | 'report';

@Component({
  selector: 'app-ocu-guide',
  standalone: true,
  imports: [CommonModule, OcuGuideConversationComponent, OcuGuideReportComponent],
  templateUrl: './ocu-guide.html',
  styleUrl: './ocu-guide.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OcuGuidePage {
  private readonly chatService = inject(ChatService);
  private readonly conversation = viewChild(OcuGuideConversationComponent);
  private readonly reportPanel = viewChild<ElementRef<HTMLElement>>('reportPanel');
  private lastFocusedTurnId: string | null = null;

  readonly loading = this.chatService.loading;
  readonly loadingStage = this.chatService.loadingStage;
  readonly latestResponse = this.chatService.latestResponse;
  readonly mobileTab = signal<MobileWorkspaceTab>('chat');

  constructor() {
    afterRenderEffect(() => {
      const response = this.latestResponse();
      if (!response || response.turnId === this.lastFocusedTurnId) return;
      this.lastFocusedTurnId = response.turnId;
      if (this.mobileTab() === 'report') {
        queueMicrotask(() => this.reportPanel()?.nativeElement.focus({ preventScroll: true }));
      }
    });
  }

  startNewReport(): void {
    this.chatService.clearConversation();
    this.lastFocusedTurnId = null;
    this.mobileTab.set('chat');
    this.conversation()?.clearDraft();
    queueMicrotask(() => this.conversation()?.focusComposer());
  }

  showReport(): void {
    this.mobileTab.set('report');
    queueMicrotask(() => this.reportPanel()?.nativeElement.focus({ preventScroll: true }));
  }

  setMobileTab(tab: MobileWorkspaceTab): void {
    this.mobileTab.set(tab);
    if (tab === 'report') queueMicrotask(() => this.reportPanel()?.nativeElement.focus({ preventScroll: true }));
    if (tab === 'chat') queueMicrotask(() => this.conversation()?.focusComposer());
  }

  loadingAnnouncement(): string {
    switch (this.loadingStage()) {
      case 'understanding': return 'Understanding your request';
      case 'retrieving': return 'Retrieving approved facility data';
      case 'comparing': return 'Comparing rooms and reporting periods';
      case 'preparing': return 'Preparing the grounded report';
      case 'idle': return 'OcuGuide is ready';
    }
  }
}
