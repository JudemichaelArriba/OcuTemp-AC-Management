import { Component, Input, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

interface FallbackTableRow {
    readonly key: string;
    readonly value: string;
    readonly isMonospace: boolean;
}

interface FallbackTableSection {
    readonly title: string | null;
    readonly rows: FallbackTableRow[];
}

/**
 * Renders when chat-response-validator.ts rejects a model's answer —
 * a plain, deterministic table built straight from the clean tool
 * result. This is a safety fallback that ensures users always get their
 * data even if the AI's interpretation can't be verified.
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
    <div class="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
      <div class="mb-3 flex items-start gap-2">
        <span class="material-symbols-outlined text-lg text-amber-600">warning</span>
        <div class="flex-1">
          <div class="font-medium text-amber-900 mb-1">Showing raw data</div>
          <div class="text-xs text-amber-700">
            The assistant's answer couldn't be verified, so here's the data
            directly from the system to ensure accuracy.
          </div>
        </div>
      </div>

      @for (section of sections(); track section.title) {
        <div class="mb-4 last:mb-0 rounded border border-amber-200 bg-white p-3">
          @if (section.title) {
            <div class="mb-2 font-semibold text-gray-900 text-sm border-b border-gray-200 pb-2">
              {{ section.title }}
            </div>
          }
          <table class="w-full border-collapse text-xs">
            <tbody>
              @for (row of section.rows; track row.key) {
                <tr class="border-b border-gray-100 last:border-0">
                  <td class="py-2 pr-4 align-top text-gray-600 font-medium w-2/5">
                    {{ row.key }}
                  </td>
                  <td class="py-2 align-top text-gray-900" [class.font-mono]="row.isMonospace">
                    {{ row.value }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @empty {
        <div class="rounded border border-amber-200 bg-white p-4 text-center text-sm text-gray-500">
          <span class="material-symbols-outlined text-2xl text-gray-400 mb-2 block">
            inbox
          </span>
          No data available for this query. The system may not have information
          matching your request.
        </div>
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


        if (typeof data === 'object' && 'found' in data && data.found === false) {
            return [{
                title: 'Not Found',
                rows: [{ key: 'Status', value: 'No data found for this request', isMonospace: false }],
            }];
        }

        if (Array.isArray(data)) {
            if (data.length === 0) {
                return [{
                    title: null,
                    rows: [{ key: 'Status', value: 'No results', isMonospace: false }],
                }];
            }

            return data.map((item, index) => ({
                title: this.deriveRowTitle(item, index),
                rows: this.flattenToRows(item),
            }));
        }

        if (typeof data === 'object') {
            return [{ title: null, rows: this.flattenToRows(data) }];
        }

        return [{ title: null, rows: [{ key: 'value', value: String(data), isMonospace: false }] }];
    }

    private deriveRowTitle(item: unknown, index: number): string {
        if (item !== null && typeof item === 'object') {

            if ('roomName' in item && typeof item.roomName === 'string') {
                return item.roomName;
            }

            if ('label' in item && typeof item.label === 'string') {
                return item.label;
            }

            if ('name' in item && typeof item.name === 'string') {
                return item.name;
            }
        }
        return `Entry ${index + 1}`;
    }

    private flattenToRows(obj: unknown): FallbackTableRow[] {
        if (obj === null || obj === undefined || typeof obj !== 'object') {
            return [{ key: 'value', value: String(obj), isMonospace: false }];
        }

        const entries = Object.entries(obj as Record<string, unknown>)
            .filter(([key, value]) => {

                if (value === null || value === undefined) return false;
                if (key === 'found' || key === 'restricted') return false;
                return true;
            })
            .map(([key, value]) => ({
                key: this.humanizeKey(key),
                value: this.formatValue(value),
                isMonospace: this.shouldUseMonospace(key, value),
            }));


        if (entries.length === 0) {
            return [{ key: 'Status', value: 'No displayable data', isMonospace: false }];
        }

        return entries;
    }

    private humanizeKey(key: string): string {

        const specialCases: Record<string, string> = {
            kwh: 'Energy (kWh)',
            acPower: 'AC Power',
            aiAutoApply: 'AI Auto-Apply',
            activeSchedulesCount: 'Active Schedules',
            onlineState: 'Status',
            lastSeen: 'Last Seen',
        };

        if (key in specialCases) {
            return specialCases[key];
        }


        return key
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/^./, (char) => char.toUpperCase());
    }

    private formatValue(value: unknown): string {
        if (typeof value === 'boolean') return value ? 'Yes' : 'No';
        if (typeof value === 'number') return value.toLocaleString();
        if (Array.isArray(value)) {
            if (value.length === 0) return 'None';
            return value.map((v) => this.formatValue(v)).join(', ');
        }
        if (value === null || value === undefined) return 'N/A';
        if (typeof value === 'object') {

            return `${Object.keys(value).length} items`;
        }
        return String(value);
    }

    private shouldUseMonospace(key: string, value: unknown): boolean {
        if (typeof value === 'number') return true;
        if (key.toLowerCase().includes('time') || key.toLowerCase().includes('date')) return true;
        if (key.toLowerCase().includes('id')) return true;
        return false;
    }
}