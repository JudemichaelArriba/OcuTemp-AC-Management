import {
  DeviceRecord,
  OccupancyLogEntry,
  OverrideHistoryEntry,
} from '../models/esp.model';
import { parseLogTimestamp } from './log-date-filter.helper';

/**
 * Display helpers for the Room Details "Records" section (occupancy log, override history).
 *
 * Both record sets are small enough to load whole and filter in the browser. Dates are
 * filtered and displayed in the facility timezone (Asia/Manila), so the table, the count
 * and the PDF export agree with each other on any device, whatever its own timezone.
 */

export const RECORDS_PAGE_SIZE = 25;

const MANILA_TZ = 'Asia/Manila';
const MANILA_OFFSET = '+08:00'; // Manila has no DST
const DAY_MS = 86_400_000;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY_CELL = '—';

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: MANILA_TZ,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** Inclusive calendar-day bounds (`YYYY-MM-DD`, Manila). An empty string leaves that side open. */
export interface RecordDateRange {
  readonly startDate: string;
  readonly endDate: string;
}

export interface OccupancyLogRow {
  readonly id: string;
  readonly dateTime: string;
  readonly detectedBy: string;
}

export interface OverrideHistoryRow {
  readonly id: string;
  readonly dateTime: string;
  readonly user: string;
  readonly role: string;
  readonly action: string;
  readonly targetTemp: string;
  readonly activeUntil: string;
}

/** Epoch ms for a stored timestamp, or `NaN` when it is missing or unparseable. */
function recordTime(raw: string | undefined): number {
  return raw ? parseLogTimestamp(raw).getTime() : NaN;
}

/** Epoch ms of Manila midnight at the start of `dayKey`, or `NaN` for a malformed key. */
function dayStartTime(dayKey: string): number {
  return DAY_KEY_PATTERN.test(dayKey) ? Date.parse(`${dayKey}T00:00:00.000${MANILA_OFFSET}`) : NaN;
}

/**
 * Some engines separate the time and AM/PM with a narrow no-break space, which the PDF's
 * built-in fonts cannot draw. Plain spaces render the same everywhere.
 */
function plainSpaces(text: string): string {
  return text.replace(/[  ]/g, ' ');
}

export function hasRecordDateFilter(range: RecordDateRange): boolean {
  return range.startDate !== '' || range.endDate !== '';
}

/** False when a bound is malformed or the start day falls after the end day. */
export function isRecordDateRangeValid(range: RecordDateRange): boolean {
  const start = range.startDate ? dayStartTime(range.startDate) : null;
  const end = range.endDate ? dayStartTime(range.endDate) : null;
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return start === null || end === null || start <= end;
}

/**
 * Keeps records whose timestamp falls on a day inside `range` (both days inclusive).
 * With no bounds every record is kept; once a bound is set, records without a usable
 * timestamp are dropped because they cannot be placed in any period. An invalid range
 * matches nothing.
 */
export function filterRecordsByDateRange<T>(
  records: readonly T[],
  getTimestamp: (record: T) => string | undefined,
  range: RecordDateRange
): T[] {
  if (!hasRecordDateFilter(range)) return [...records];
  if (!isRecordDateRangeValid(range)) return [];

  const from = range.startDate ? dayStartTime(range.startDate) : -Infinity;
  const until = range.endDate ? dayStartTime(range.endDate) + DAY_MS : Infinity;

  return records.filter((record) => {
    const time = recordTime(getTimestamp(record));
    return time >= from && time < until;
  });
}

/**
 * Newest first by timestamp. Ties fall back to the push key (itself chronological), and
 * records without a usable timestamp sort last.
 */
export function sortRecordsNewestFirst<T extends { readonly id: string }>(
  records: readonly T[],
  getTimestamp: (record: T) => string | undefined
): T[] {
  return records
    .map((record) => ({ record, time: recordTime(getTimestamp(record)) }))
    .sort((a, b) => {
      const aValid = !Number.isNaN(a.time);
      const bValid = !Number.isNaN(b.time);
      if (aValid !== bValid) return aValid ? -1 : 1;
      if (aValid && a.time !== b.time) return b.time - a.time;
      if (a.record.id === b.record.id) return 0;
      return a.record.id < b.record.id ? 1 : -1;
    })
    .map(({ record }) => record);
}

/** `Aug 27, 2026, 3:05 PM` in Manila time. */
export function formatRecordDateTime(raw: string | undefined): string {
  const time = recordTime(raw);
  return Number.isNaN(time) ? 'Unknown time' : plainSpaces(DATE_TIME_FORMAT.format(time));
}

function formatDayKey(dayKey: string): string {
  const time = DAY_KEY_PATTERN.test(dayKey) ? Date.parse(`${dayKey}T00:00:00.000Z`) : NaN;
  return Number.isNaN(time) ? dayKey : DAY_FORMAT.format(time);
}

/** Human label for the selected period, e.g. `Aug 27, 2026 – Oct 7, 2026`. */
export function formatRecordDateRange(range: RecordDateRange): string {
  const { startDate, endDate } = range;
  if (startDate && endDate) {
    return startDate === endDate
      ? formatDayKey(startDate)
      : `${formatDayKey(startDate)} – ${formatDayKey(endDate)}`;
  }
  if (startDate) return `From ${formatDayKey(startDate)}`;
  if (endDate) return `Up to ${formatDayKey(endDate)}`;
  return 'All dates';
}

/**
 * Which sensor reported the occupancy. The boolean flags are authoritative; `reason`
 * carries the same triggers and is only consulted when an entry has no flag set.
 */
export function describeOccupancyDetection(entry: OccupancyLogEntry): string {
  let pir = entry.pirEdge === true || entry.pirLevel === true;
  let mlx = entry.mlxHit === true;

  if (!pir && !mlx) {
    const triggers = (entry.reason ?? '').split('+').map((trigger) => trigger.trim());
    pir = triggers.includes('pir_edge') || triggers.includes('pir_level');
    mlx = triggers.includes('mlx');
  }

  if (pir && mlx) return 'Both sensors';
  if (pir) return 'Motion sensor (PIR)';
  if (mlx) return 'Infrared sensor (MLX90614)';
  return 'Not recorded';
}

export function describeOverrideAction(action: string | undefined): string {
  switch (action) {
    case 'override': return 'Override set';
    case 'clear': return 'Override cleared';
    case 'forcedOff': return 'Forced off';
    default: return action?.trim() || EMPTY_CELL;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function toOccupancyLogRows(
  records: readonly DeviceRecord<OccupancyLogEntry>[]
): OccupancyLogRow[] {
  return records.map((record) => ({
    id: record.id,
    dateTime: formatRecordDateTime(record.timestamp),
    detectedBy: describeOccupancyDetection(record),
  }));
}

export function toOverrideHistoryRows(
  records: readonly DeviceRecord<OverrideHistoryEntry>[]
): OverrideHistoryRow[] {
  return records.map((record) => {
    const role = record.requestedByRole?.trim();
    return {
      id: record.id,
      dateTime: formatRecordDateTime(record.requestedAt),
      user: record.requestedByName?.trim() || 'Unknown user',
      role: role ? capitalize(role) : EMPTY_CELL,
      action: describeOverrideAction(record.action),
      targetTemp: typeof record.targetTemp === 'number' ? `${record.targetTemp}°C` : EMPTY_CELL,
      activeUntil: record.overrideUntil ? formatRecordDateTime(record.overrideUntil) : EMPTY_CELL,
    };
  });
}

/** Total pages for `total` rows; never less than 1 so an empty list still has a page. */
export function recordPageCount(total: number, pageSize: number = RECORDS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Rows for a 1-based `page`. */
export function pageOfRecords<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = RECORDS_PAGE_SIZE
): T[] {
  const start = (page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** e.g. `occupancy-log-room-101-2026-08-27_to_2026-10-07.pdf`. */
export function buildRecordsFileName(
  recordType: string,
  roomName: string,
  range: RecordDateRange
): string {
  const period = hasRecordDateFilter(range)
    ? `${range.startDate || 'start'}_to_${range.endDate || 'latest'}`
    : 'all-dates';
  const name = [slugify(recordType), slugify(roomName) || 'room'].join('-');
  return `${name}-${period}.pdf`;
}
