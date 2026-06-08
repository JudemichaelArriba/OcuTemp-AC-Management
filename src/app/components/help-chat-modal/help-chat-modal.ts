import { Component, Input, Output, EventEmitter, signal, ElementRef, ViewChild, AfterViewChecked, OnChanges, SimpleChanges, ChangeDetectorRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

@Component({
  selector: 'app-help-chat-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './help-chat-modal.html',
  styleUrl: './help-chat-modal.css',
})
export class HelpChatModal implements AfterViewChecked, OnChanges {
  @ViewChild('messagesEnd') messagesEnd!: ElementRef;
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  private cdr = inject(ChangeDetectorRef);

  animating = false;
  private animTimeout: any;

  messages = signal<Message[]>([]);
  input = signal('');
  loading = signal(false);
  error = signal('');

  readonly suggestions = [
    'How does the floor plan work?',
    'How do I add a new room?',
    'What does the legends on the map mean?',
  ];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['visible']) {
      if (this.visible) {
        clearTimeout(this.animTimeout);
        setTimeout(() => {
          this.animating = true;
          this.cdr.detectChanges();
        }, 10);
      } else {
        this.animating = false;
      }
    }
  }

  ngAfterViewChecked(): void {
    this.scrollToBottom();
  }

  close(): void {
    this.animating = false;
    this.animTimeout = setTimeout(() => {
      this.visibleChange.emit(false);
    }, 300);
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }

  onInputChange(event: Event): void {
    this.input.set((event.target as HTMLInputElement).value);
  }

  async sendMessage(overrideText?: string): Promise<void> {
    const text = (overrideText ?? this.input()).trim();
    if (!text || this.loading()) return;
    if (text.length > 500) {
      this.error.set('Message too long. Keep it under 500 characters.');
      return;
    }

    this.error.set('');
    this.messages.update(m => [...m, { role: 'user', content: text }]);
    this.input.set('');
    this.loading.set(true);
    this.messages.update(m => [...m, { role: 'assistant', content: '' }]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: this.messages().slice(0, -1).map(m => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(err || 'Request failed');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No response stream');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        this.messages.update(msgs => {
          const updated = [...msgs];
          updated[updated.length - 1] = {
            role: 'assistant',
            content: updated[updated.length - 1].content + chunk,
          };
          return updated;
        });
      }
    } catch (err: any) {
      this.messages.update(msgs => msgs.slice(0, -1));
      this.error.set(err.message ?? 'Something went wrong. Please try again.');
    } finally {
      this.loading.set(false);
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  private scrollToBottom(): void {
    try {
      this.messagesEnd?.nativeElement?.scrollIntoView({ behavior: 'smooth' });
    } catch {}
  }
}