import { Schedule } from '../models/room.model';

const ROOM_NAME_PATTERN = /^[a-zA-Z0-9\s\-]+$/;
const SUBJECT_PATTERN = /^[a-zA-Z0-9\s\-]+$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function getRoomNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Room name is required.';
  if (!ROOM_NAME_PATTERN.test(trimmed)) {
    return 'Room name may only contain letters, numbers, spaces, and hyphens.';
  }
  return null;
}

export function isScheduleDay(value: string): value is Exclude<Schedule['day'], ''> {
  return (
    value === 'Monday' ||
    value === 'Tuesday' ||
    value === 'Wednesday' ||
    value === 'Thursday' ||
    value === 'Friday' ||
    value === 'Saturday' ||
    value === 'Sunday'
  );
}

export function normalizeSchedule(schedule: Schedule): Schedule {
  return {
    day: schedule.day,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    subject: schedule.subject.trim(),
  };
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function hasOverlap(start1: string, end1: string, start2: string, end2: string): boolean {
  const s1 = timeToMinutes(start1);
  const e1 = timeToMinutes(end1);
  const s2 = timeToMinutes(start2);
  const e2 = timeToMinutes(end2);
  return s1 < e2 && s2 < e1;
}

export function getScheduleValidationError(
  schedule: Schedule,
  schedules: Schedule[],
  excludeIndex?: number
): string | null {
  const { day, startTime, endTime, subject } = schedule;
  const trimmedSubject = subject.trim();

  if (!day || !startTime || !endTime || !trimmedSubject) {
    return 'All schedule fields are required.';
  }
  if (!isScheduleDay(day)) {
    return 'Please select a valid day.';
  }
  if (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime)) {
    return 'Please select a valid time value.';
  }
  if (!SUBJECT_PATTERN.test(trimmedSubject)) {
    return 'Subject may only contain letters, numbers, spaces, and hyphens.';
  }
  if (startTime === endTime) {
    return 'Start time and end time cannot be the same.';
  }
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    return 'Start time must be before end time.';
  }

  const normalized = normalizeSchedule(schedule);
  if (schedules.some((s, i) => i !== excludeIndex && s.subject.trim() === trimmedSubject)) {
    return 'Subject name must be unique.';
  }
  if (
    schedules.some(
      (s, i) =>
        i !== excludeIndex &&
        s.day === normalized.day &&
        s.startTime === normalized.startTime &&
        s.endTime === normalized.endTime &&
        s.subject.trim() === trimmedSubject
    )
  ) {
    return 'Duplicate schedule.';
  }
  if (
    schedules.some(
      (s, i) =>
        i !== excludeIndex &&
        s.day === normalized.day &&
        hasOverlap(normalized.startTime, normalized.endTime, s.startTime, s.endTime)
    )
  ) {
    return 'Schedules on the same day cannot overlap.';
  }

  return null;
}

export function validateSchedulesList(schedules: Schedule[]): string | null {
  for (let i = 0; i < schedules.length; i++) {
    const schedule = schedules[i];
    const error = getScheduleValidationError(schedule, schedules, i);
    if (error) return error;
  }
  return null;
}
