import { Schedule } from '../models/room.model';

export interface ScheduleDayGroup {
  readonly day: Schedule['day'];
  readonly schedules: readonly Schedule[];
}

const DAY_ORDER: readonly Schedule['day'][] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  '',
];

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since midnight for a stored `HH:mm` value, or null when unparseable. */
function toMinutes(time: string | undefined): number | null {
  const match = TIME_PATTERN.exec(time ?? '');
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Schedules are stored as 24-hour `HH:mm`; this renders them as 12-hour clock
 * time for display only. Unparseable values fall through unchanged.
 */
export function formatTime12h(time: string): string {
  const minutes = toMinutes(time);
  if (minutes === null) return time || '--';
  const hours24 = Math.floor(minutes / 60);
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const suffix = hours24 < 12 ? 'AM' : 'PM';
  return `${hours12}:${String(minutes % 60).padStart(2, '0')} ${suffix}`;
}

export function formatTimeRange12h(startTime: string, endTime: string): string {
  return `${formatTime12h(startTime)} – ${formatTime12h(endTime)}`;
}

/** `08:00`–`09:30` becomes `1h 30m`. Empty when the range cannot be measured. */
export function formatScheduleDuration(startTime: string, endTime: string): string {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (start === null || end === null || end <= start) return '';

  const total = end - start;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

/** Groups schedules by weekday in calendar order, each group sorted by start time. */
export function groupSchedulesByDay(schedules: readonly Schedule[]): ScheduleDayGroup[] {
  const byDay = new Map<Schedule['day'], Schedule[]>();

  for (const schedule of schedules) {
    const existing = byDay.get(schedule.day);
    if (existing) existing.push(schedule);
    else byDay.set(schedule.day, [schedule]);
  }

  return DAY_ORDER.filter(day => byDay.has(day)).map(day => ({
    day,
    schedules: [...byDay.get(day)!].sort(
      (a, b) => (toMinutes(a.startTime) ?? 0) - (toMinutes(b.startTime) ?? 0),
    ),
  }));
}
