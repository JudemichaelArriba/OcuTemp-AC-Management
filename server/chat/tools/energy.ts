import type {
    EnergyBucket,
    EnergyRange,
    EnergyReportPresentation,
    EnergyRoomDataStatus,
    EnergyRoomRow,
    EnergyTrendPoint,
    GroundingFact,
    PlannerToolPlan,
} from '../types/chat.types.js';
import { ChatApiError } from '../types/chat.types.js';

const TIME_ZONE = 'Asia/Manila' as const;
const MAX_RANGE_DAYS = 5 * 366;
const MAX_TREND_POINTS = 60;
const MAX_KWH_PER_DAY = 100_000;
const MAX_RUNTIME_SECONDS_PER_DAY = 172_800;
const MAX_SESSIONS_PER_DAY = 10_000;

interface CalendarDate {
    readonly year: number;
    readonly month: number;
    readonly day: number;
}

interface EnergyRecord {
    readonly date: string;
    readonly estimatedKwh: number;
    readonly runtimeSeconds: number | null;
    readonly sessionCount: number | null;
    readonly updatedAt: string | null;
}

export interface EnergyRoomInput {
    readonly roomName: string;
    readonly deviceId: string | null;
    readonly deviceAssigned?: boolean;
    readonly deviceAvailable: boolean;
    readonly daily: Record<string, unknown> | null;
    readonly readFailed?: boolean;
}

export interface BuildEnergyReportOptions {
    readonly id: string;
    readonly factPrefix: string;
    readonly plan: PlannerToolPlan;
    readonly rooms: readonly EnergyRoomInput[];
    readonly now: Date;
}

export interface BuiltEnergyReport {
    readonly presentation: EnergyReportPresentation;
    readonly facts: GroundingFact[];
    readonly notices: string[];
    readonly partial: boolean;
}

interface ResolvedEnergyRange {
    readonly range: EnergyRange;
    readonly start: CalendarDate;
    readonly end: CalendarDate;
    readonly notice: string | null;
}

interface AggregatedRoom {
    readonly input: EnergyRoomInput;
    readonly status: EnergyRoomDataStatus;
    readonly records: readonly EnergyRecord[];
    readonly estimatedKwh: number | null;
    readonly runtimeSeconds: number | null;
    readonly sessionCount: number | null;
    readonly lastUpdatedAt: string | null;
}

/**
 * Builds the complete, estimated energy report from bounded daily snapshots.
 * This module is deliberately pure: it does not know how Firebase is reached
 * and cannot perform writes.
 */
export function buildEnergyReport(options: BuildEnergyReportOptions): BuiltEnergyReport {
    const resolved = resolveRange(options.plan, options.now);
    const buckets = buildBuckets(resolved.start, resolved.end, resolved.range.bucket);
    const notices: string[] = resolved.notice ? [resolved.notice] : [];
    if (resolved.range.bucket === 'day' && differenceInDays(resolved.start, resolved.end) + 1 > MAX_TREND_POINTS) {
        notices.push('The earliest adjacent days were combined to keep the trend at 60 points.');
    }

    const aggregated = options.rooms.map((room) => aggregateRoom(room, resolved.start, resolved.end));
    const recordedRooms = aggregated
        .filter((room) => room.status === 'recorded')
        .sort((left, right) => {
            const valueOrder = publishedKwh(recordedKwh(right)) - publishedKwh(recordedKwh(left));
            return valueOrder || left.input.roomName.localeCompare(right.input.roomName);
        });

    const totalKwh = sum(recordedRooms.map(recordedKwh));
    const totalRuntimeSeconds = sumComplete(recordedRooms.map((room) => room.runtimeSeconds));
    const totalSessionCount = sumComplete(recordedRooms.map((room) => room.sessionCount));
    const incompleteRuntime = recordedRooms.length > 0 && totalRuntimeSeconds === null;
    const incompleteSessions = recordedRooms.length > 0 && totalSessionCount === null;
    const rankByRoom = rankRooms(recordedRooms);

    const rows: EnergyRoomRow[] = aggregated
        .map((room) => ({
            roomName: room.input.roomName,
            estimatedKwh: room.estimatedKwh === null ? null : round(room.estimatedKwh, 3),
            sharePercent:
                room.status !== 'recorded'
                    ? null
                    : round(totalKwh > 0 ? (recordedKwh(room) / totalKwh) * 100 : 0, 1),
            rank: rankByRoom.get(room) ?? null,
            runtimeSeconds:
                room.runtimeSeconds === null ? null : Math.round(room.runtimeSeconds),
            sessionCount: room.sessionCount === null ? null : Math.round(room.sessionCount),
            status: room.status,
            lastUpdatedAt: room.lastUpdatedAt,
        }))
        .sort(compareEnergyRows);

    const trend: EnergyTrendPoint[] = recordedRooms.length === 0
        ? []
        : buckets.map((bucket) => {
            const bucketRecords = recordedRooms.flatMap((room) =>
                room.records.filter((record) =>
                    isBetween(parseDateKey(record.date)!, bucket.start, bucket.end)),
            );
            const recordedDates = new Set(bucketRecords.map((record) => record.date));
            return {
                label: bucket.label,
                start: dateKey(bucket.start),
                end: dateKey(bucket.end),
                estimatedKwh: bucketRecords.length === 0
                    ? null
                    : round(sum(bucketRecords.map((record) => record.estimatedKwh)), 3),
                recordedDays: recordedDates.size,
                expectedDays: differenceInDays(bucket.start, bucket.end) + 1,
            };
        });

    const recordedDateKeys = new Set(
        recordedRooms.flatMap((room) => room.records.map((record) => record.date)),
    );
    const expectedDays = differenceInDays(resolved.start, resolved.end) + 1;
    const recordedDays = recordedDateKeys.size;
    const dataCoveragePercent = round(
        expectedDays > 0 ? (recordedDays / expectedDays) * 100 : 0,
        1,
    );

    const roomsWithRecords = recordedRooms.length;
    const coveragePercent = round(
        options.rooms.length > 0 ? (roomsWithRecords / options.rooms.length) * 100 : 0,
        1,
    );
    const presentation: EnergyReportPresentation = {
        kind: 'energy-report',
        availability: 'available',
        id: options.id,
        title: `Estimated energy report — ${resolved.range.label}`,
        partId: options.plan.partId,
        toolName: options.plan.name,
        estimated: true,
        range: resolved.range,
        metrics: {
            totalKwh: roomsWithRecords > 0 ? round(totalKwh, 3) : null,
            runtimeSeconds:
                roomsWithRecords > 0 && totalRuntimeSeconds !== null
                    ? Math.round(totalRuntimeSeconds)
                    : null,
            sessionCount:
                roomsWithRecords > 0 && totalSessionCount !== null
                    ? Math.round(totalSessionCount)
                    : null,
            activeRooms: options.rooms.length,
            roomsWithRecords,
            coveragePercent,
            recordedDays,
            expectedDays,
            dataCoveragePercent,
        },
        trend,
        rooms: rows,
    };

    const facts = buildEnergyFacts(
        options.factPrefix,
        options.plan.partId,
        presentation,
        aggregated,
        expectedDays,
    );
    const unavailableRooms = aggregated.filter((room) => room.status === 'device_unavailable').length;
    const failedReads = aggregated.filter((room) => room.input.readFailed === true).length;
    if (failedReads > 0) {
        notices.push(
            `${failedReads} room${failedReads === 1 ? '' : 's'} could not be read and ` +
                `${failedReads === 1 ? 'is' : 'are'} marked device unavailable.`,
        );
    } else if (unavailableRooms > 0) {
        notices.push(
            `${unavailableRooms} active room${unavailableRooms === 1 ? '' : 's'} ` +
                `${unavailableRooms === 1 ? 'has' : 'have'} unavailable assigned-device data.`,
        );
    }
    if (recordedDays > 0 && recordedDays < expectedDays) {
        notices.push(
            `Energy records exist on ${recordedDays} of ${expectedDays} calendar days ` +
                `in the selected range (${dataCoveragePercent}% temporal coverage); unrecorded intervals are gaps, not zero usage.`,
        );
    }
    if (incompleteRuntime || incompleteSessions) {
        notices.push(
            `Some recorded energy entries lack valid ${[
                incompleteRuntime ? 'runtime' : null,
                incompleteSessions ? 'session-count' : null,
            ].filter((value): value is string => value !== null).join(' and ')} data; ` +
                'the corresponding aggregate remains unavailable rather than being treated as zero.',
        );
    }

    return {
        presentation,
        facts,
        notices,
        partial:
            unavailableRooms > 0 || coveragePercent < 100 ||
            (recordedDays > 0 && recordedDays < expectedDays) ||
            incompleteRuntime || incompleteSessions,
    };
}

/** Resolve presets using Philippine calendar dates, never the server's locale. */
export function resolveEnergyRange(plan: PlannerToolPlan, now: Date): EnergyRange {
    return resolveRange(plan, now).range;
}

function resolveRange(plan: PlannerToolPlan, now: Date): ResolvedEnergyRange {
    if (!Number.isFinite(now.getTime())) {
        throw new ChatApiError('invalid_request', 'The report time is invalid.', 400);
    }

    const today = manilaDate(now);
    let start: CalendarDate;
    let end: CalendarDate;
    let label: string;

    switch (plan.rangePreset) {
        case 'today':
            start = today;
            end = today;
            label = `Today (${formatLongDate(today)})`;
            break;
        case 'this_week':
            start = startOfWeek(today);
            end = today;
            label = 'This week';
            break;
        case 'last_week': {
            end = addDays(startOfWeek(today), -1);
            start = addDays(end, -6);
            label = 'Last week';
            break;
        }
        case 'last_7_days':
            start = addDays(today, -6);
            end = today;
            label = 'Last 7 days';
            break;
        case 'last_month': {
            const previousMonth = addMonths(startOfMonth(today), -1);
            start = previousMonth;
            end = addDays(addMonths(previousMonth, 1), -1);
            label = formatMonth(previousMonth);
            break;
        }
        case 'this_year':
            start = { year: today.year, month: 1, day: 1 };
            end = today;
            label = `This year (${today.year})`;
            break;
        case 'last_12_months':
            start = addMonths(startOfMonth(today), -11);
            end = today;
            label = 'Last 12 months';
            break;
        case 'custom': {
            const customStart = parseDateKey(plan.startDate);
            const customEnd = parseDateKey(plan.endDate);
            if (!customStart || !customEnd || compareDates(customStart, customEnd) > 0) {
                throw new ChatApiError(
                    'invalid_request',
                    'Custom energy dates must be valid YYYY-MM-DD values with the start on or before the end.',
                    400,
                );
            }
            if (compareDates(customEnd, today) > 0) {
                throw new ChatApiError(
                    'invalid_request',
                    'Custom energy reports cannot end after the current date in Asia/Manila.',
                    400,
                );
            }
            if (compareDates(customEnd, addYears(customStart, 5)) > 0) {
                throw new ChatApiError(
                    'invalid_request',
                    'Custom energy reports are limited to a maximum range of five years.',
                    400,
                );
            }
            start = customStart;
            end = customEnd;
            label = `${formatLongDate(start)} to ${formatLongDate(end)}`;
            break;
        }
        case 'this_month':
        default:
            start = startOfMonth(today);
            end = today;
            label = `Current month (${formatMonth(today)})`;
            break;
    }

    if (differenceInDays(start, end) + 1 > MAX_RANGE_DAYS) {
        throw new ChatApiError(
            'invalid_request',
            'Energy reports are limited to a maximum range of five years.',
            400,
        );
    }

    const requestedBucket = isBucket(plan.bucket) ? plan.bucket : 'auto';
    const selectedBucket = chooseBucket(start, end, requestedBucket);
    const range: EnergyRange = {
        label,
        start: dateKey(start),
        end: dateKey(end),
        bucket: selectedBucket,
    };
    const notice =
        requestedBucket !== 'auto' && requestedBucket !== selectedBucket
            ? `The requested ${requestedBucket} buckets were widened to ${selectedBucket} buckets ` +
                `to keep the trend at ${MAX_TREND_POINTS} points or fewer.`
            : null;

    return { range, start, end, notice };
}

function aggregateRoom(
    room: EnergyRoomInput,
    start: CalendarDate,
    end: CalendarDate,
): AggregatedRoom {
    if (!room.deviceId && room.deviceAssigned !== true) {
        return emptyAggregation(room, 'no_device');
    }
    if (!room.deviceId || !room.deviceAvailable || room.readFailed === true) {
        return emptyAggregation(room, 'device_unavailable');
    }

    const records = Object.entries(room.daily ?? {})
        .map(([key, value]) => parseEnergyRecord(key, value))
        .filter((record): record is EnergyRecord => record !== null)
        .filter((record) => isBetween(parseDateKey(record.date)!, start, end))
        .sort((left, right) => left.date.localeCompare(right.date));

    if (records.length === 0) {
        return emptyAggregation(room, 'no_records');
    }

    return {
        input: room,
        status: 'recorded',
        records,
        estimatedKwh: sum(records.map((record) => record.estimatedKwh)),
        runtimeSeconds: sumComplete(records.map((record) => record.runtimeSeconds)),
        sessionCount: sumComplete(records.map((record) => record.sessionCount)),
        lastUpdatedAt: latestTimestamp(records.map((record) => record.updatedAt)),
    };
}

function emptyAggregation(
    input: EnergyRoomInput,
    status: Exclude<EnergyRoomDataStatus, 'recorded'>,
): AggregatedRoom {
    return {
        input,
        status,
        records: [],
        estimatedKwh: null,
        runtimeSeconds: null,
        sessionCount: null,
        lastUpdatedAt: null,
    };
}

function parseEnergyRecord(key: string, value: unknown): EnergyRecord | null {
    if (!parseDateKey(key) || !isRecord(value)) return null;

    const estimatedKwh = boundedNumber(value['estimatedKwh'], 0, MAX_KWH_PER_DAY);
    if (estimatedKwh === null) return null;

    return {
        date: key,
        estimatedKwh,
        runtimeSeconds: boundedNumber(value['runtimeSeconds'], 0, MAX_RUNTIME_SECONDS_PER_DAY),
        sessionCount: boundedInteger(value['sessionCount'], 0, MAX_SESSIONS_PER_DAY),
        updatedAt: normalizedTimestamp(value['updatedAt']),
    };
}

function rankRooms(rooms: readonly AggregatedRoom[]): ReadonlyMap<AggregatedRoom, number> {
    const ranks = new Map<AggregatedRoom, number>();
    let previousValue: number | null = null;
    let previousRank = 0;

    rooms.forEach((room, index) => {
        const value = publishedKwh(recordedKwh(room));
        const rank = previousValue !== null && value === previousValue ? previousRank : index + 1;
        ranks.set(room, rank);
        previousValue = value;
        previousRank = rank;
    });
    return ranks;
}

function compareEnergyRows(left: EnergyRoomRow, right: EnergyRoomRow): number {
    if (left.rank !== null && right.rank !== null) return left.rank - right.rank;
    if (left.rank !== null) return -1;
    if (right.rank !== null) return 1;
    return left.roomName.localeCompare(right.roomName);
}

function buildEnergyFacts(
    prefix: string,
    partId: PlannerToolPlan['partId'],
    presentation: EnergyReportPresentation,
    aggregated: readonly AggregatedRoom[],
    expectedDays: number,
): GroundingFact[] {
    const recordedDaysByRoom = new Map<string, number>(
        aggregated.map((room): [string, number] => [
            room.input.roomName,
            new Set(room.records.map((record) => record.date)).size,
        ]),
    );
    const recordedEnergyAvailable =
        presentation.metrics.roomsWithRecords > 0 && presentation.metrics.totalKwh !== null;
    const noRecords = presentation.rooms.filter((room) => room.status === 'no_records').length;
    const noDevice = presentation.rooms.filter((room) => room.status === 'no_device').length;
    const unavailable = presentation.rooms.filter((room) => room.status === 'device_unavailable').length;
    const unavailableDetails: string[] = [];
    if (noRecords > 0) {
        unavailableDetails.push(
            `${noRecords} active room${noRecords === 1 ? '' : 's'} ${noRecords === 1 ? 'was' : 'were'} read successfully and ${noRecords === 1 ? 'has' : 'have'} no energy records in the selected range.`,
        );
    }
    if (noDevice > 0) {
        unavailableDetails.push(
            `${noDevice} active room${noDevice === 1 ? '' : 's'} ${noDevice === 1 ? 'has' : 'have'} no assigned device.`,
        );
    }
    if (unavailable > 0) {
        unavailableDetails.push(
            `Assigned-device energy data is unavailable for ${unavailable} active room${unavailable === 1 ? '' : 's'}.`,
        );
    }
    if (presentation.metrics.activeRooms === 0) {
        unavailableDetails.push('No active rooms matched the requested energy scope.');
    }
    const summary = recordedEnergyAvailable
        ? `${presentation.range.label} (${presentation.range.start} through ${presentation.range.end}): ` +
            `${presentation.metrics.roomsWithRecords} of ${presentation.metrics.activeRooms} active rooms ` +
            `have records (${presentation.metrics.coveragePercent}% coverage); those recorded rooms total an estimated ` +
            `${presentation.metrics.totalKwh} kWh. Records exist on ${presentation.metrics.recordedDays} of ` +
            `${presentation.metrics.expectedDays} calendar days (${presentation.metrics.dataCoveragePercent}% temporal coverage). ` +
            (presentation.metrics.runtimeSeconds === null
                ? 'A complete runtime total is unavailable. '
                : `Complete recorded runtime totals ${presentation.metrics.runtimeSeconds} seconds. `) +
            (presentation.metrics.sessionCount === null
                ? 'A complete session total is unavailable.'
                : `Complete recorded sessions total ${presentation.metrics.sessionCount}.`)
        : `${presentation.range.label} (${presentation.range.start} through ${presentation.range.end}): ` +
            'no verified recorded energy total, runtime total, session total, or trend is available. ' +
            (unavailableDetails.join(' ') || 'Recorded totals could not be verified.');
    const facts: GroundingFact[] = [
        {
            id: `${prefix}.summary`,
            partId,
            statement: summary.trim(),
        },
    ];
    const firstPlace = presentation.rooms.filter(
        (room) => room.status === 'recorded' && room.rank === 1,
    );
    if (firstPlace.length === 1) {
        const winner = firstPlace[0]!;
        facts.push({
            id: `${prefix}.rank.first`,
            partId,
            statement:
                `${winner.roomName} is the sole rank-one room for ${presentation.range.label} ` +
                `with an estimated ${winner.estimatedKwh} kWh (${winner.sharePercent}% of the recorded total), ` +
                `based on records for ${recordedDaysByRoom.get(winner.roomName) ?? 0} of ` +
                `${expectedDays} calendar days.`,
        });
    } else if (firstPlace.length > 1) {
        facts.push({
            id: `${prefix}.rank.first`,
            partId,
            statement:
                `${firstPlace.map((room) => room.roomName).join(', ')} are tied for rank one for ` +
                `${presentation.range.label} at an estimated ${firstPlace[0]!.estimatedKwh} kWh each. ` +
                `Their recorded-day coverage is ${firstPlace.map((room) =>
                    `${room.roomName}: ${recordedDaysByRoom.get(room.roomName) ?? 0}/${expectedDays}`
                ).join('; ')}.`,
        });
    }

    presentation.rooms.forEach((room, index) => {
        let statement: string;
        switch (room.status) {
            case 'recorded': {
                const roomRecordedDays = recordedDaysByRoom.get(room.roomName) ?? 0;
                statement =
                    `${room.roomName} ranks ${room.rank} with an estimated ${room.estimatedKwh} kWh ` +
                    `(${room.sharePercent}% share), ` +
                    (room.runtimeSeconds === null
                        ? 'runtime unavailable, '
                        : `${room.runtimeSeconds} runtime seconds, `) +
                    (room.sessionCount === null
                        ? 'and session count unavailable.'
                        : `and ${room.sessionCount} sessions.`) +
                    ` Its total is based on records for ${roomRecordedDays} of ` +
                    `${expectedDays} calendar days in the selected range.`;
                break;
            }
            case 'no_device':
                statement = `${room.roomName} is active but has no assigned device.`;
                break;
            case 'device_unavailable':
                statement = `${room.roomName} is active but its assigned device data is unavailable.`;
                break;
            case 'no_records':
                statement = `${room.roomName} has no energy records in the selected range.`;
                break;
        }
        facts.push({ id: `${prefix}.room.${index + 1}`, partId, statement });
    });

    presentation.trend.forEach((point, index) => {
        facts.push({
            id: `${prefix}.trend.${index + 1}`,
            partId,
            statement: point.estimatedKwh === null
                ? `${point.label} (${point.start} through ${point.end}) has no recorded energy data; ` +
                    `the interval is a gap, not measured zero usage.`
                : `${point.label} (${point.start} through ${point.end}) totals an estimated ` +
                    `${point.estimatedKwh} kWh from records on ${point.recordedDays} of ` +
                    `${point.expectedDays} calendar days.`,
        });
    });
    return facts;
}

interface DateBucket {
    readonly start: CalendarDate;
    readonly end: CalendarDate;
    readonly label: string;
}

function buildBuckets(
    start: CalendarDate,
    end: CalendarDate,
    bucket: Exclude<EnergyBucket, 'auto'>,
): DateBucket[] {
    const result: DateBucket[] = [];
    let cursor = start;

    while (compareDates(cursor, end) <= 0 && result.length < MAX_TREND_POINTS) {
        let bucketEnd: CalendarDate;
        switch (bucket) {
            case 'day': {
                // Auto day resolution is intentionally retained through 62 days.
                // Coalescing only the earliest overflow keeps the complete range
                // while enforcing the presentation's hard 60-point ceiling.
                const remainingDays = differenceInDays(cursor, end) + 1;
                const remainingSlots = MAX_TREND_POINTS - result.length;
                bucketEnd = addDays(cursor, Math.max(0, remainingDays - remainingSlots));
                break;
            }
            case 'week':
                bucketEnd = minDate(addDays(cursor, 6 - dayOfWeekMondayZero(cursor)), end);
                break;
            case 'month':
                bucketEnd = minDate(addDays(addMonths(startOfMonth(cursor), 1), -1), end);
                break;
            case 'year':
                bucketEnd = minDate({ year: cursor.year, month: 12, day: 31 }, end);
                break;
        }

        result.push({
            start: cursor,
            end: bucketEnd,
            label: formatBucketLabel(cursor, bucketEnd, bucket),
        });
        cursor = addDays(bucketEnd, 1);
    }

    return result;
}

function chooseBucket(
    start: CalendarDate,
    end: CalendarDate,
    requested: EnergyBucket,
): Exclude<EnergyBucket, 'auto'> {
    const order: ReadonlyArray<Exclude<EnergyBucket, 'auto'>> = ['day', 'week', 'month', 'year'];
    if (requested === 'auto') {
        const days = differenceInDays(start, end) + 1;
        if (days <= 62) return 'day';
        if (days <= 180) return 'week';
        if (days <= 731) return 'month';
        return 'year';
    }

    const firstIndex = order.indexOf(requested);

    for (let index = Math.max(0, firstIndex); index < order.length; index += 1) {
        const candidate = order[index]!;
        if (countBuckets(start, end, candidate) <= MAX_TREND_POINTS) return candidate;
    }
    return 'year';
}

function countBuckets(
    start: CalendarDate,
    end: CalendarDate,
    bucket: Exclude<EnergyBucket, 'auto'>,
): number {
    let count = 0;
    let cursor = start;
    while (compareDates(cursor, end) <= 0 && count <= MAX_TREND_POINTS) {
        count += 1;
        switch (bucket) {
            case 'day':
                cursor = addDays(cursor, 1);
                break;
            case 'week':
                cursor = addDays(cursor, 7 - dayOfWeekMondayZero(cursor));
                break;
            case 'month':
                cursor = addMonths(startOfMonth(cursor), 1);
                break;
            case 'year':
                cursor = { year: cursor.year + 1, month: 1, day: 1 };
                break;
        }
    }
    return count;
}

function formatBucketLabel(
    start: CalendarDate,
    end: CalendarDate,
    bucket: Exclude<EnergyBucket, 'auto'>,
): string {
    if (bucket === 'day' && compareDates(start, end) === 0) return formatLongDate(start);
    if (bucket === 'month' && start.day === 1) return formatMonth(start);
    if (bucket === 'year' && start.month === 1 && start.day === 1) return String(start.year);
    return `${formatShortDate(start)} – ${formatShortDate(end)}`;
}

function isBucket(value: unknown): value is EnergyBucket {
    return value === 'auto' || value === 'day' || value === 'week' || value === 'month' || value === 'year';
}

function manilaDate(date: Date): CalendarDate {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
        Number(parts.find((part) => part.type === type)?.value);
    return { year: value('year'), month: value('month'), day: value('day') };
}

function parseDateKey(value: unknown): CalendarDate | null {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const parsed = {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
    };
    const checked = fromUtcDate(toUtcDate(parsed));
    return dateKey(checked) === value ? checked : null;
}

function dateKey(date: CalendarDate): string {
    return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function toUtcDate(date: CalendarDate): Date {
    return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

function fromUtcDate(date: Date): CalendarDate {
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
    };
}

function addDays(date: CalendarDate, amount: number): CalendarDate {
    const result = toUtcDate(date);
    result.setUTCDate(result.getUTCDate() + amount);
    return fromUtcDate(result);
}

function addMonths(date: CalendarDate, amount: number): CalendarDate {
    const monthIndex = date.year * 12 + date.month - 1 + amount;
    const year = Math.floor(monthIndex / 12);
    const month = ((monthIndex % 12) + 12) % 12 + 1;
    const lastDay = fromUtcDate(new Date(Date.UTC(year, month, 0))).day;
    return { year, month, day: Math.min(date.day, lastDay) };
}

function addYears(date: CalendarDate, amount: number): CalendarDate {
    const lastDay = fromUtcDate(new Date(Date.UTC(date.year + amount, date.month, 0))).day;
    return {
        year: date.year + amount,
        month: date.month,
        day: Math.min(date.day, lastDay),
    };
}

function startOfMonth(date: CalendarDate): CalendarDate {
    return { year: date.year, month: date.month, day: 1 };
}

function startOfWeek(date: CalendarDate): CalendarDate {
    return addDays(date, -dayOfWeekMondayZero(date));
}

function dayOfWeekMondayZero(date: CalendarDate): number {
    return (toUtcDate(date).getUTCDay() + 6) % 7;
}

function compareDates(left: CalendarDate, right: CalendarDate): number {
    return dateKey(left).localeCompare(dateKey(right));
}

function differenceInDays(start: CalendarDate, end: CalendarDate): number {
    return Math.floor((toUtcDate(end).getTime() - toUtcDate(start).getTime()) / 86_400_000);
}

function isBetween(value: CalendarDate, start: CalendarDate, end: CalendarDate): boolean {
    return compareDates(value, start) >= 0 && compareDates(value, end) <= 0;
}

function minDate(left: CalendarDate, right: CalendarDate): CalendarDate {
    return compareDates(left, right) <= 0 ? left : right;
}

function displayDate(date: CalendarDate, options: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(toUtcDate(date));
}

function formatLongDate(date: CalendarDate): string {
    return displayDate(date, { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatShortDate(date: CalendarDate): string {
    return displayDate(date, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatMonth(date: CalendarDate): string {
    return displayDate(date, { month: 'long', year: 'numeric' });
}

function normalizedTimestamp(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 64) return null;
    const trimmed = value.trim();
    const absoluteIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
    const legacyManila = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u;
    if (!absoluteIso.test(trimmed) && !legacyManila.test(trimmed) ||
        !hasValidIsoCalendarParts(trimmed)) return null;
    const timestamp = new Date(legacyManila.test(trimmed) ? `${trimmed}+08:00` : trimmed);
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function hasValidIsoCalendarParts(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59 || month < 1 || month > 12 || day < 1) {
        return false;
    }
    return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function latestTimestamp(values: readonly (string | null)[]): string | null {
    return values
        .filter((value): value is string => value !== null)
        .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
        ? value
        : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
    const parsed = boundedNumber(value, minimum, maximum);
    return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

/** Missing runtime/session fields stay unavailable rather than becoming false zeroes. */
function sumComplete(values: readonly (number | null)[]): number | null {
    let total = 0;
    for (const value of values) {
        if (value === null) return null;
        total += value;
    }
    return total;
}

/** Ranking and tie detection use the same precision exposed in the public report. */
function recordedKwh(room: AggregatedRoom): number {
    if (room.status !== 'recorded' || room.estimatedKwh === null) {
        throw new ChatApiError(
            'data_unavailable',
            'A recorded energy aggregation is incomplete.',
            503,
        );
    }
    return room.estimatedKwh;
}

function publishedKwh(value: number): number {
    return round(value, 3);
}

function round(value: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * factor) / factor;
}
