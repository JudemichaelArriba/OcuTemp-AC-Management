import { EnergyDaily } from '../models/energy.model';

/**
 * Time series and scroll math for the Consumption Trend chart.
 *
 * The series runs from the first period with recorded usage through today, so periods from before
 * any data existed are never drawn, while zero periods after that stay visible as real zeros.
 */

export type EnergyTrendMode = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface EnergyTrendPoint {
  /** Stable bucket identity: `YYYY-MM-DD`, the week's end date, `YYYY-MM` or `YYYY`. */
  readonly key: string;
  /** Short axis label. */
  readonly label: string;
  /** Unambiguous tooltip title; includes the year because scrolling can span several years. */
  readonly tooltipTitle: string;
  /** Consecutive period number, which lets labels be derived for periods outside the series. */
  readonly ordinal: number;
  readonly kwh: number;
}

export interface EnergyTrendViewport {
  /** Visible x-axis range, in fractional point indexes. */
  readonly min: number;
  readonly max: number;
  /** Width of the scrollable content relative to the viewport. */
  readonly contentWidthPercent: number;
  readonly scrollable: boolean;
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;
const MONTHS_PER_YEAR = 12;
const KWH_DECIMALS = 4;

/**
 * Older date keys are rejected as device clock errors: an ESP without a synced clock can stamp
 * `1970-01-01`, which would otherwise stretch the axis by decades of empty periods.
 */
const HISTORY_FLOOR_KEY = '2020-01-01';

const PREFERRED_VISIBLE_POINTS: Readonly<Record<EnergyTrendMode, number>> = {
  daily: 7,
  weekly: 8,
  monthly: 12,
  yearly: 5,
};

/** Narrowest slot per point at which that mode's axis labels stay legible. */
const MIN_POINT_WIDTH_PX: Readonly<Record<EnergyTrendMode, number>> = {
  daily: 48,
  weekly: 96,
  monthly: 48,
  yearly: 64,
};

const SHORT_DAY_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const FULL_DAY_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const SHORT_MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const FULL_MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Days since the epoch for a real calendar date key, or null for anything else. */
function parseDayNumber(dateKey: string): number | null {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  // Date.UTC rolls impossible dates over (Feb 31 becomes Mar 3), so a mismatch means invalid input.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return ms / MS_PER_DAY;
}

function dayToDate(dayNumber: number): Date {
  return new Date(dayNumber * MS_PER_DAY);
}

function dayToKey(dayNumber: number): string {
  return dayToDate(dayNumber).toISOString().slice(0, 10);
}

function monthOrdinalOf(dayNumber: number): number {
  const date = dayToDate(dayNumber);
  return date.getUTCFullYear() * MONTHS_PER_YEAR + date.getUTCMonth();
}

function yearOf(dayNumber: number): number {
  return dayToDate(dayNumber).getUTCFullYear();
}

/**
 * Consecutive integer per period. Weeks are rolling 7-day windows ending today (matching
 * `getLast8WeekRanges`), so today's week is 0 and earlier weeks are negative.
 */
function toOrdinal(dayNumber: number, todayDay: number, mode: EnergyTrendMode): number {
  if (mode === 'daily') return dayNumber;
  if (mode === 'weekly') return -Math.floor((todayDay - dayNumber) / DAYS_PER_WEEK);
  if (mode === 'monthly') return monthOrdinalOf(dayNumber);
  return yearOf(dayNumber);
}

function describePeriod(
  ordinal: number,
  todayDay: number,
  mode: EnergyTrendMode
): Omit<EnergyTrendPoint, 'kwh' | 'ordinal'> {
  if (mode === 'daily') {
    const key = dayToKey(ordinal);
    return { key, label: key.slice(5), tooltipTitle: FULL_DAY_FORMAT.format(dayToDate(ordinal)) };
  }

  if (mode === 'weekly') {
    const endDay = todayDay + ordinal * DAYS_PER_WEEK;
    const start = dayToDate(endDay - (DAYS_PER_WEEK - 1));
    const end = dayToDate(endDay);
    const label = `${SHORT_DAY_FORMAT.format(start)} - ${SHORT_DAY_FORMAT.format(end)}`;
    const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
    const tooltipTitle = sameYear
      ? `${label}, ${end.getUTCFullYear()}`
      : `${FULL_DAY_FORMAT.format(start)} - ${FULL_DAY_FORMAT.format(end)}`;
    return { key: dayToKey(endDay), label, tooltipTitle };
  }

  if (mode === 'monthly') {
    const year = Math.floor(ordinal / MONTHS_PER_YEAR);
    const month = ordinal - year * MONTHS_PER_YEAR;
    const date = new Date(Date.UTC(year, month, 1));
    return {
      key: `${year}-${String(month + 1).padStart(2, '0')}`,
      label: SHORT_MONTH_FORMAT.format(date),
      tooltipTitle: FULL_MONTH_FORMAT.format(date),
    };
  }

  const year = String(ordinal);
  return { key: year, label: year, tooltipTitle: year };
}

function roundKwh(value: number): number {
  return parseFloat(value.toFixed(KWH_DECIMALS));
}

/**
 * Builds the facility-wide series for a mode in one pass over the entries. The energy stream emits
 * on every device telemetry change, so the cost must not multiply by the number of periods.
 * Returns an empty array when no usable usage is recorded.
 */
export function buildEnergyTrendSeries(
  energyData: Record<string, Record<string, EnergyDaily>>,
  mode: EnergyTrendMode,
  todayKey: string
): EnergyTrendPoint[] {
  const todayDay = parseDayNumber(todayKey);
  if (todayDay === null) return [];

  const totals = new Map<number, number>();
  let firstOrdinal: number | null = null;

  for (const days of Object.values(energyData ?? {})) {
    if (!days || typeof days !== 'object') continue;
    for (const [dateKey, entry] of Object.entries(days)) {
      const kwh = entry?.estimatedKwh;
      if (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh <= 0) continue;
      if (dateKey < HISTORY_FLOOR_KEY || dateKey > todayKey) continue;
      const dayNumber = parseDayNumber(dateKey);
      if (dayNumber === null) continue;

      const ordinal = toOrdinal(dayNumber, todayDay, mode);
      totals.set(ordinal, (totals.get(ordinal) ?? 0) + kwh);
      if (firstOrdinal === null || ordinal < firstOrdinal) firstOrdinal = ordinal;
    }
  }

  if (firstOrdinal === null) return [];

  const lastOrdinal = toOrdinal(todayDay, todayDay, mode);
  const series: EnergyTrendPoint[] = [];
  for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal++) {
    series.push({
      ...describePeriod(ordinal, todayDay, mode),
      ordinal,
      kwh: roundKwh(totals.get(ordinal) ?? 0),
    });
  }
  return series;
}

/** How many periods fit on screen; fewer than the mode's usual count on narrow screens. */
export function getVisibleCount(mode: EnergyTrendMode, widthPx: number): number {
  const preferred = PREFERRED_VISIBLE_POINTS[mode];
  if (!(widthPx > 0)) return preferred;
  return Math.min(preferred, Math.max(1, Math.floor(widthPx / MIN_POINT_WIDTH_PX[mode])));
}

/**
 * Maps scroll progress (0 oldest, 1 latest) to the visible axis range. The range is always exactly
 * `visibleCount` wide so point spacing never changes: series that fit sit centered with the
 * surrounding periods labeled but undrawn (indexes below 0 or past the end), and longer ones scroll
 * with half a slot of padding at each end.
 */
export function computeTrendViewport(
  pointCount: number,
  visibleCount: number,
  scrollProgress: number
): EnergyTrendViewport {
  const visible = Math.max(1, visibleCount);
  const scrollable = pointCount > visible;
  const progress = Number.isFinite(scrollProgress) ? Math.min(1, Math.max(0, scrollProgress)) : 0;
  const min = scrollable
    ? progress * (pointCount - visible) - 0.5
    : (pointCount - 1) / 2 - visible / 2;

  return {
    min,
    max: min + visible,
    contentWidthPercent: scrollable ? (pointCount / visible) * 100 : 100,
    scrollable,
  };
}

/**
 * Point indexes to label within an axis range. Indexes exactly on the bounds are left out because
 * their labels would be cut off at the chart edge.
 */
export function getTrendTickIndexes(min: number, max: number): number[] {
  const indexes: number[] = [];
  for (let index = Math.floor(min) + 1; index < max; index++) indexes.push(index);
  return indexes;
}

/**
 * Axis label for a point index, including periods before and after the series. Empty when there is
 * no series, because there is then no period to count from.
 */
export function getTrendSlotLabel(
  series: readonly EnergyTrendPoint[],
  index: number,
  mode: EnergyTrendMode,
  todayKey: string
): string {
  const point = series[index];
  if (point) return point.label;

  const todayDay = parseDayNumber(todayKey);
  if (series.length === 0 || todayDay === null) return '';
  return describePeriod(series[0].ordinal + index, todayDay, mode).label;
}

/** True when both series would draw identically, so a redraw can be skipped. */
export function isSameTrendSeries(a: readonly EnergyTrendPoint[], b: readonly EnergyTrendPoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((point, index) => point.key === b[index].key && point.kwh === b[index].kwh);
}
