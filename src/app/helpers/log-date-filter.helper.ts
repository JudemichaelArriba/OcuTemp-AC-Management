import { DropDownOption } from '../components/shared/drop-down/drop-down';

/**
 * Decision-log date filtering.
 *
 * `decisionLogs` are paginated and range-filtered by RTDB **push key**, not by the
 * `updatedAt` field. The producer writes `updatedAt` as a bare Manila wall-clock string
 * at minute precision (many ties) and it is `.indexOn`-dependent; push-ID keys are
 * unique, chronological, sort lexicographically the same way, and need no index, so key
 * bounds give a stable time window. Preset boundaries are computed in the facility
 * timezone (Asia/Manila, matching {@link ../services/energy-report.service}).
 * Storage is never touched.
 */

const MANILA_TZ = 'Asia/Manila';
const MANILA_OFFSET = '+08:00'; // Manila has no DST

/** Firebase push-ID alphabet — 64 chars, already in ASCII sort order. */
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

export type LogDatePreset = 'all' | 'today' | 'last7' | 'last30' | 'thisMonth';

/** Half-open instant interval: `start` inclusive, `end` exclusive (UTC ISO strings). */
export interface LogDateRange {
  readonly start?: string;
  readonly end?: string;
}

/** Push-key prefix bounds for {@link keyRangeForDateRange}. */
export interface LogKeyRange {
  readonly startKey?: string;
  readonly endKey?: string;
}

export const LOG_DATE_PRESETS: DropDownOption[] = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'thisMonth', label: 'This month' },
];

/** `YYYY-MM-DD` for the given instant in Manila local time. */
export function manilaDayKey(date: Date): string {
  // en-CA renders ISO-style `YYYY-MM-DD`.
  return date.toLocaleDateString('en-CA', { timeZone: MANILA_TZ });
}

/** UTC instant for Manila midnight at the start of `dayKey` (`YYYY-MM-DD`). */
function manilaDayStartUtc(dayKey: string): string {
  return new Date(`${dayKey}T00:00:00.000${MANILA_OFFSET}`).toISOString();
}

/** `dayKey` shifted by `deltaDays`, still a `YYYY-MM-DD` Manila day key. */
function shiftDayKey(dayKey: string, deltaDays: number): string {
  const shifted = new Date(`${dayKey}T00:00:00.000${MANILA_OFFSET}`);
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return manilaDayKey(shifted);
}

/** Resolves a preset to a UTC instant range. `all` yields an empty range. */
export function resolvePresetRange(preset: LogDatePreset, now: Date = new Date()): LogDateRange {
  const today = manilaDayKey(now);
  const tomorrowStart = manilaDayStartUtc(shiftDayKey(today, 1));

  switch (preset) {
    case 'today':
      return { start: manilaDayStartUtc(today), end: tomorrowStart };
    case 'last7':
      return { start: manilaDayStartUtc(shiftDayKey(today, -6)), end: tomorrowStart };
    case 'last30':
      return { start: manilaDayStartUtc(shiftDayKey(today, -29)), end: tomorrowStart };
    case 'thisMonth':
      return { start: manilaDayStartUtc(`${today.slice(0, 7)}-01`), end: tomorrowStart };
    case 'all':
    default:
      return {};
  }
}

/**
 * First 8 chars of a Firebase push ID for `epochMs` — a big-endian base-64 encoding of
 * the timestamp. Used as a lexical bound against full 20-char push keys.
 */
export function pushKeyPrefixForTime(epochMs: number): string {
  let remaining = Math.max(0, Math.floor(epochMs));
  const chars = new Array<string>(8);
  for (let i = 7; i >= 0; i--) {
    chars[i] = PUSH_CHARS.charAt(remaining % 64);
    remaining = Math.floor(remaining / 64);
  }
  return chars.join('');
}

/**
 * Maps a UTC-instant range to push-key prefix bounds for an `orderByKey()` query.
 * `startKey` is start-inclusive, `endKey` is end-exclusive (both hold because a full
 * push key created at instant T sorts after T's 8-char prefix).
 */
export function keyRangeForDateRange(range: LogDateRange): LogKeyRange {
  const startMs = range.start ? Date.parse(range.start) : NaN;
  const endMs = range.end ? Date.parse(range.end) : NaN;
  return {
    startKey: Number.isNaN(startMs) ? undefined : pushKeyPrefixForTime(startMs),
    endKey: Number.isNaN(endMs) ? undefined : pushKeyPrefixForTime(endMs),
  };
}

/**
 * Parses a stored `updatedAt` to a Date, tolerating both shapes the producer writes:
 * absolute ISO (`…Z` / `±HH:MM`) is used as-is; a bare wall-clock value is treated as
 * Manila local time (mirrors `normalizedTimestamp` in server/chat/tools/executor.ts).
 */
export function parseLogTimestamp(raw: string): Date {
  if (typeof raw !== 'string' || raw.length === 0) return new Date(NaN);
  const trimmed = raw.trim();
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  return new Date(hasZone ? trimmed : `${trimmed}${MANILA_OFFSET}`);
}
