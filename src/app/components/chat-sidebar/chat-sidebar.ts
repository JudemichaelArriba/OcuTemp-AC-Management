import {
    Component, Input, Output, EventEmitter,
    ElementRef, ViewChild, AfterViewChecked, OnChanges, SimpleChanges,
    ChangeDetectorRef, inject, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../services/chat.service';
import { ChatMessageComponent } from '../chat-message/chat-message';
import { ChatUserRole } from '../../models/chat.models';

@Component({
    selector: 'app-chat-sidebar',
    standalone: true,
    imports: [CommonModule, FormsModule, ChatMessageComponent],
    templateUrl: './chat-sidebar.html',
    styleUrl: './chat-sidebar.css',
})
export class ChatSidebarComponent implements AfterViewChecked, OnChanges {
    @ViewChild('messagesEnd') messagesEnd!: ElementRef;

    @Input() visible = false;
    @Input({ required: true }) userRole!: ChatUserRole;
    @Output() visibleChange = new EventEmitter<boolean>();

    private readonly cdr = inject(ChangeDetectorRef);
    private readonly chatService = inject(ChatService);

    animating = false;
    private animTimeout: ReturnType<typeof setTimeout> | undefined;

    inputText = '';

    readonly messages = this.chatService.messages;
    readonly loading = this.chatService.loading;

    readonly suggestions = computed<string[]>(() => {
        const base = [
            'What Room is active right now?',
            'Which room is using the most energy?',
            'How do I add a new room?',
        ];
        if (this.userRole === 'admin') {
            base.push('How do I approve a pending staff account?');
        }
        return base;
    });

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

    async send(overrideText?: string): Promise<void> {
        const text = (overrideText ?? this.inputText).trim();
        if (!text || this.loading()) return;

        this.inputText = '';
        await this.chatService.sendMessage(text, this.userRole);
    }

    onKeyDown(event: KeyboardEvent): void {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.send();
        }
    }

    private scrollToBottom(): void {
        try {
            this.messagesEnd?.nativeElement?.scrollIntoView({ behavior: 'smooth' });
        } catch {
            // scroll container not yet in DOM — safe to ignore
        }
    }
}