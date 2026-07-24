import { Component, Input, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

interface FallbackTableRow {
    readonly key: string;
    readonly value: string;
}

interface FallbackTableSection {
    readonly title: string | null;
    readonly rows: FallbackTableRow[];
}

/**
 * Renders when chat-response-validator.ts rejects a model's answer —
 * a plain, deterministic table built straight from the clean tool
 * result, per Phase 4/6 of the plan. First-class component, not an
 * inline *ngIf, so the "validation failed" path is as visible in the
 * codebase as the happy path.
 *
 * Handles both shapes of fallbackData ChatToolsService can return:
 * a single flat object (e.g. one room's telemetry), or an array of
 * objects (e.g. energy rankings, all-rooms telemetry).
 */
@Component({
    selector: 'app-chat-fallback-table',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div class="rounded-lg border border-border bg-card p-3 text-sm">
      <div class="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span class="material-symbols-outlined text-sm">info</span>
        <span>Showing raw data — the assistant's summary couldn't be verified.</span>
      </div>

      @for (section of sections(); track section.title) {
        <div class="mb-3 last:mb-0">
          @if (section.title) {
            <div class="mb-1 font-medium text-foreground">{{ section.title }}</div>
          }
          <table class="w-full border-collapse text-xs">
            <tbody>
              @for (row of section.rows; track row.key) {
                <tr class="border-b border-border last:border-0">
                  <td class="py-1 pr-3 align-top text-muted-foreground">{{ row.key }}</td>
                  <td class="py-1 align-top text-foreground">{{ row.value }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @empty {
        <div class="text-muted-foreground">No data available for this result.</div>
      }
    </div>
  `,
})
export class ChatFallbackTableComponent {
    private readonly rawData = signal<unknown>(null);

    @Input({ required: true })
    set data(value: unknown) {
        this.rawData.set(value);
    }

    readonly sections = computed<FallbackTableSection[]>(() => this.buildSections(this.rawData()));

    private buildSections(data: unknown): FallbackTableSection[] {
        if (data === null || data === undefined) return [];

        if (Array.isArray(data)) {
            return data.map((item, index) => ({
                title: this.deriveRowTitle(item, index),
                rows: this.flattenToRows(item),
            }));
        }

        if (typeof data === 'object') {
            return [{ title: null, rows: this.flattenToRows(data) }];
        }

        return [{ title: null, rows: [{ key: 'value', value: String(data) }] }];
    }

    private deriveRowTitle(item: unknown, index: number): string {
        if (item !== null && typeof item === 'object' && 'roomName' in item) {
            const roomName = (item as { roomName: unknown }).roomName;
            if (typeof roomName === 'string') return roomName;
        }
        return `Item ${index + 1}`;
    }

    private flattenToRows(obj: unknown): FallbackTableRow[] {
        if (obj === null || obj === undefined || typeof obj !== 'object') {
            return [{ key: 'value', value: String(obj) }];
        }

        return Object.entries(obj as Record<string, unknown>)
            .filter(([, value]) => value !== null && value !== undefined)
            .map(([key, value]) => ({
                key: this.humanizeKey(key),
                value: this.formatValue(value),
            }));
    }

    private humanizeKey(key: string): string {
        return key
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/^./, (char) => char.toUpperCase());
    }

    private formatValue(value: unknown): string {
        if (typeof value === 'boolean') return value ? 'Yes' : 'No';
        if (Array.isArray(value)) return value.map((v) => this.formatValue(v)).join(', ');
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }
}