import { Component, Input, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RenderableChatMessage } from '../../services/chat.service';
import { ChatFallbackTableComponent } from '../chat-fallback-table/chat-fallback-table';

@Component({
  selector: 'app-chat-message',
  standalone: true,
  imports: [CommonModule, ChatFallbackTableComponent],
  styleUrl: './chat-message.css',
  template: `
    @if (msg().role === 'user' || msg().text) {
      <div class="flex gap-2.5" [class.justify-end]="msg().role === 'user'">
        @if (msg().role === 'assistant') {
          <div class="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mt-0.5 shadow-sm shadow-blue-200">
            <span class="material-symbols-outlined text-white text-xs">robot_2</span>
          </div>
        }

        <div class="max-w-[80%] flex flex-col gap-2">
          <div
            class="px-4 py-3 text-[12px] leading-relaxed font-medium"
            [class.user-bubble]="msg().role === 'user'"
            [class.assistant-bubble]="msg().role === 'assistant'"
          >
            {{ msg().text }}
          </div>

          @if (msg().isFallback && msg().fallbackData) {
            <app-chat-fallback-table [data]="msg().fallbackData" />
          }
        </div>
      </div>
    }
  `,
})
export class ChatMessageComponent {
  private readonly messageSignal = signal<RenderableChatMessage | null>(null);

  @Input({ required: true })
  set message(value: RenderableChatMessage) {
    this.messageSignal.set(value);
  }

  readonly msg = computed(() => this.messageSignal()!);
}