import {
  DeviceRecord,
  OccupancyLogEntry,
  OverrideHistoryEntry,
} from '../models/esp.model';
import { Room } from '../models/room.model';
import { DropDownOption } from '../components/shared/drop-down/drop-down';
import { LOG_DATE_PRESETS, manilaDayKey, parseLogTimestamp } from './log-date-filter.helper';

/**
 * Display helpers for the Energy Reports "Records" section (occupancy log, override history
 * across every room's device).
 *
 * Both record sets are small enough to stream whole and filter in the browser. Dates are
 * filtered and displayed in the facility timezone (Asia/Manila), so the table, the count
 * and the PDF export agree with each other on any device, whatever its own timezone.
 */

export const RECORDS_PAGE_SIZE = 25;

const MANILA_TZ = 'Asia/Manila';
const MANILA_OFFSET = '+08:00'; // Manila has no DST
const DAY_MS = 86_400_000;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Placeholder for a field an entry does not carry. */
export const EMPTY_RECORD_CELL = '—';
const EMPTY_CELL = EMPTY_RECORD_CELL;

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: MANILA_TZ,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: MANILA_TZ,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: MANILA_TZ,
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

/** `custom` means the user picked the start and end days by hand. */
export type RecordDatePreset = 'all' | 'today' | 'last7' | 'last30' | 'thisMonth' | 'custom';

export const RECORD_DATE_PRESETS: DropDownOption[] = [
  ...LOG_DATE_PRESETS,
  { value: 'custom', label: 'Custom range' },
];

export type OccupancyDetection = 'pir' | 'mlx' | 'both' | 'unknown';

export type OverrideActionKind = 'override' | 'clear' | 'forcedOff' | 'other';

/** Value of the room filter that keeps every room. */
export const ALL_ROOMS = 'all';
export const UNASSIGNED_ROOM_LABEL = 'Unassigned';

type RecordRoomSource = Pick<Room, 'uid' | 'roomName' | 'device' | 'deleted' | 'deletedDevice'>;

/** The room a record belongs to. `roomUid` is empty when no room can be matched. */
export interface RecordRoom {
  readonly roomUid: string;
  readonly roomName: string;
}

/** Room names by room uid and by the device a room uses (or used before it was deleted). */
export interface RecordRoomLookup {
  readonly byUid: ReadonlyMap<string, RecordRoom>;
  readonly byDevice: ReadonlyMap<string, RecordRoom>;
}

/** Fields every records table row shows, whatever the record type. */
export interface RecordRowBase {
  readonly id: string;
  /** `Aug 27, 2026` and `3:05 PM`; `dateTime` is the two joined, as printed in the PDF. */
  readonly date: string;
  readonly time: string;
  readonly dateTime: string;
  readonly roomUid: string;
  readonly room: string;
  readonly device: string;
}

export interface OccupancyLogRow extends RecordRowBase {
  readonly detection: OccupancyDetection;
  readonly detectedBy: string;
  readonly pirEdge: boolean;
  readonly pirLevel: boolean;
  readonly mlxHit: boolean;
}

export interface OverrideHistoryRow extends RecordRowBase {
  readonly user: string;
  readonly role: string;
  readonly actionKind: OverrideActionKind;
  readonly action: string;
  readonly targetTemp: string;
  readonly activeUntil: string;
}

export interface RecordDetailRow {
  readonly label: string;
  readonly value: string;
}

export interface RecordDetailGroup {
  readonly title: string;
  readonly icon: string;
  readonly rows: readonly RecordDetailRow[];
}

/** Everything the details modal shows for one record. */
export interface RecordDetails {
  readonly title: string;
  readonly subtitle: string;
  readonly groups: readonly RecordDetailGroup[];
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

/** `dayKey` shifted by `deltaDays`, still a `YYYY-MM-DD` key. */
function shiftDayKey(dayKey: string, deltaDays: number): string {
  const shifted = Date.parse(`${dayKey}T00:00:00.000Z`) + deltaDays * DAY_MS;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * Day bounds for a preset, counted in Manila days and ending today. `all` and `custom`
 * resolve to an open range: `custom` bounds come from the user, not from here.
 */
export function resolveRecordPresetRange(
  preset: RecordDatePreset,
  now: Date = new Date()
): RecordDateRange {
  const today = manilaDayKey(now);
  switch (preset) {
    case 'today': return { startDate: today, endDate: today };
    case 'last7': return { startDate: shiftDayKey(today, -6), endDate: today };
    case 'last30': return { startDate: shiftDayKey(today, -29), endDate: today };
    case 'thisMonth': return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
    default: return { startDate: '', endDate: '' };
  }
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

/** The date and the time of day as separate strings, for a two-line table cell. */
function formatRecordDateParts(raw: string | undefined): { date: string; time: string } {
  const time = recordTime(raw);
  if (Number.isNaN(time)) return { date: 'Unknown time', time: '' };
  return { date: DATE_FORMAT.format(time), time: plainSpaces(TIME_FORMAT.format(time)) };
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
export function classifyOccupancyDetection(entry: OccupancyLogEntry): OccupancyDetection {
  let pir = entry.pirEdge === true || entry.pirLevel === true;
  let mlx = entry.mlxHit === true;

  if (!pir && !mlx) {
    const triggers = (entry.reason ?? '').split('+').map((trigger) => trigger.trim());
    pir = triggers.includes('pir_edge') || triggers.includes('pir_level');
    mlx = triggers.includes('mlx');
  }

  if (pir && mlx) return 'both';
  if (pir) return 'pir';
  if (mlx) return 'mlx';
  return 'unknown';
}

export function describeOccupancyDetection(entry: OccupancyLogEntry): string {
  switch (classifyOccupancyDetection(entry)) {
    case 'both': return 'Both sensors';
    case 'pir': return 'Motion sensor (PIR)';
    case 'mlx': return 'Infrared sensor (MLX90614)';
    default: return 'Not recorded';
  }
}

export function classifyOverrideAction(action: string | undefined): OverrideActionKind {
  return action === 'override' || action === 'clear' || action === 'forcedOff' ? action : 'other';
}

export function describeOverrideAction(action: string | undefined): string {
  switch (classifyOverrideAction(action)) {
    case 'override': return 'Override set';
    case 'clear': return 'Override cleared';
    case 'forcedOff': return 'Forced off';
    default: return action?.trim() || EMPTY_CELL;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Indexes rooms for record lookups. A device maps to the live room that uses it now, or
 * failing that to the deleted room that last used it.
 */
export function buildRecordRoomLookup(rooms: readonly RecordRoomSource[]): RecordRoomLookup {
  const byUid = new Map<string, RecordRoom>();
  const byDevice = new Map<string, RecordRoom>();

  for (const room of rooms) {
    if (room.deleted !== true) continue;
    const entry = { roomUid: room.uid, roomName: `${room.roomName} (deleted)` };
    byUid.set(room.uid, entry);
    if (room.deletedDevice) byDevice.set(room.deletedDevice, entry);
  }
  for (const room of rooms) {
    if (room.deleted === true) continue;
    const entry = { roomUid: room.uid, roomName: room.roomName };
    byUid.set(room.uid, entry);
    if (room.device) byDevice.set(room.device, entry);
  }
  return { byUid, byDevice };
}

/** The room named by the record itself when it has one, otherwise the device's room. */
export function resolveRecordRoom(
  lookup: RecordRoomLookup,
  deviceId: string,
  roomUid?: string
): RecordRoom {
  return (roomUid ? lookup.byUid.get(roomUid) : undefined)
    ?? lookup.byDevice.get(deviceId)
    ?? { roomUid: '', roomName: UNASSIGNED_ROOM_LABEL };
}

/** Every device a room uses or used before deletion: the devices whose records are shown. */
export function recordDeviceIds(rooms: readonly RecordRoomSource[]): string[] {
  const ids = new Set<string>();
  for (const room of rooms) {
    const deviceId = (room.deleted === true ? room.deletedDevice : room.device)?.trim();
    if (deviceId) ids.add(deviceId);
  }
  return [...ids].sort();
}

/** Room filter options: every room by name, after an "All rooms" entry. */
export function buildRecordRoomOptions(rooms: readonly RecordRoomSource[]): DropDownOption[] {
  const lookup = buildRecordRoomLookup(rooms);
  const options = [...lookup.byUid.values()]
    .map((room) => ({ value: room.roomUid, label: room.roomName }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return [{ value: ALL_ROOMS, label: 'All rooms' }, ...options];
}

/**
 * Narrows table rows to one room (or `ALL_ROOMS`) and to a search query. `searchText`
 * returns the text of a row the query is matched against, case-insensitively.
 */
export function filterRecordRows<TRow extends RecordRowBase>(
  rows: readonly TRow[],
  roomUid: string,
  query: string,
  searchText: (row: TRow) => string
): TRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) =>
    (roomUid === ALL_ROOMS || row.roomUid === roomUid)
    && (!needle || searchText(row).toLowerCase().includes(needle)));
}

export function toOccupancyLogRows(
  records: readonly DeviceRecord<OccupancyLogEntry>[],
  lookup: RecordRoomLookup
): OccupancyLogRow[] {
  return records.map((record) => {
    const room = resolveRecordRoom(lookup, record.deviceId);
    return {
      id: record.id,
      ...formatRecordDateParts(record.timestamp),
      dateTime: formatRecordDateTime(record.timestamp),
      roomUid: room.roomUid,
      room: room.roomName,
      device: record.deviceId,
      detection: classifyOccupancyDetection(record),
      detectedBy: describeOccupancyDetection(record),
      pirEdge: record.pirEdge === true,
      pirLevel: record.pirLevel === true,
      mlxHit: record.mlxHit === true,
    };
  });
}

export function toOverrideHistoryRows(
  records: readonly DeviceRecord<OverrideHistoryEntry>[],
  lookup: RecordRoomLookup
): OverrideHistoryRow[] {
  return records.map((record) => {
    const role = record.requestedByRole?.trim();
    const room = resolveRecordRoom(lookup, record.deviceId, record.roomUid);
    return {
      id: record.id,
      ...formatRecordDateParts(record.requestedAt),
      dateTime: formatRecordDateTime(record.requestedAt),
      roomUid: room.roomUid,
      room: room.roomName,
      device: record.deviceId,
      user: record.requestedByName?.trim() || 'Unknown user',
      role: role ? capitalize(role) : EMPTY_CELL,
      actionKind: classifyOverrideAction(record.action),
      action: describeOverrideAction(record.action),
      targetTemp: typeof record.targetTemp === 'number' ? `${record.targetTemp}°C` : EMPTY_CELL,
      activeUntil: record.overrideUntil ? formatRecordDateTime(record.overrideUntil) : EMPTY_CELL,
    };
  });
}

const yesNo = (value: boolean): string => (value ? 'Yes' : 'No');

const whereGroup = (row: RecordRowBase): RecordDetailGroup => ({
  title: 'Where',
  icon: 'meeting_room',
  rows: [
    { label: 'Room', value: row.room },
    { label: 'Device', value: row.device },
  ],
});

/** Details modal content for one occupancy entry. Raw sensor diagnostics stay out. */
export function buildOccupancyDetails(row: OccupancyLogRow): RecordDetails {
  return {
    title: 'Room occupied',
    subtitle: row.dateTime,
    groups: [
      whereGroup(row),
      {
        title: 'Detection',
        icon: 'sensors',
        rows: [
          { label: 'Detected by', value: row.detectedBy },
          { label: 'Motion sensor, new movement', value: yesNo(row.pirEdge) },
          { label: 'Motion sensor, continued presence', value: yesNo(row.pirLevel) },
          { label: 'Infrared sensor', value: yesNo(row.mlxHit) },
        ],
      },
    ],
  };
}

/** Details modal content for one override history entry. */
export function buildOverrideDetails(row: OverrideHistoryRow): RecordDetails {
  return {
    title: row.action,
    subtitle: row.dateTime,
    groups: [
      whereGroup(row),
      {
        title: 'Request',
        icon: 'tune',
        rows: [
          { label: 'Requested by', value: row.user },
          { label: 'Role', value: row.role },
          { label: 'Target temperature', value: row.targetTemp },
          { label: 'Active until', value: row.activeUntil },
        ],
      },
    ],
  };
}

/** Total pages for `total` rows; never less than 1 so an empty list still has a page. */
export function recordPageCount(total: number, pageSize: number = RECORDS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** `page` pulled back into range, e.g. after a filter or a live update shrinks the list. */
export function clampRecordPage(
  page: number,
  total: number,
  pageSize: number = RECORDS_PAGE_SIZE
): number {
  return Math.min(Math.max(1, Math.floor(page) || 1), recordPageCount(total, pageSize));
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
