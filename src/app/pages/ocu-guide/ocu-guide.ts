import {
  ChangeDetectionStrategy,
  Component,
  inject,
  viewChild,
} from '@angular/core';
import { ChatService } from '../../services/chat.service';
import { OcuGuideConversationComponent } from './ocu-guide-conversation';

@Component({
  selector: 'app-ocu-guide',
  standalone: true,
  imports: [OcuGuideConversationComponent],
  templateUrl: './ocu-guide.html',
  host: { class: 'block min-h-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OcuGuidePage {
  private readonly chatService = inject(ChatService);
  private readonly conversation = viewChild(OcuGuideConversationComponent);

  startNewConversation(): void {
    this.chatService.clearConversation();
    this.conversation()?.clearDraft();
    queueMicrotask(() => this.conversation()?.focusComposer());
  }
}
