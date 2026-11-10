import { DeviceRecord, OccupancyLogEntry, OverrideHistoryEntry } from '../models/esp.model';
import {
  buildRecordsFileName,
  describeOccupancyDetection,
  describeOverrideAction,
  filterRecordsByDateRange,
  formatRecordDateRange,
  formatRecordDateTime,
  isRecordDateRangeValid,
  pageOfRecords,
  recordPageCount,
  sortRecordsNewestFirst,
  toOccupancyLogRows,
  toOverrideHistoryRows,
} from './device-records.helper';

interface Stamped {
  id: string;
  at?: string;
}

const at = (record: Stamped) => record.at;
const ids = (records: Stamped[]) => records.map((record) => record.id);

describe('filterRecordsByDateRange', () => {
  const RANGE = { startDate: '2026-08-27', endDate: '2026-10-07' };

  const records: Stamped[] = [
    { id: 'before-start', at: '2026-08-26T23:59:59+08:00' },
    { id: 'first-instant', at: '2026-08-27T00:00:00+08:00' },
    { id: 'middle', at: '2026-09-15T12:30:00+08:00' },
    { id: 'last-instant', at: '2026-10-07T23:59:59+08:00' },
    { id: 'after-end', at: '2026-10-08T00:00:00+08:00' },
  ];

  it('keeps only records on days inside the range, both ends inclusive', () => {
    expect(ids(filterRecordsByDateRange(records, at, RANGE))).toEqual([
      'first-instant',
      'middle',
      'last-instant',
    ]);
  });

  it('reads a timestamp without a zone as Manila wall-clock time', () => {
    const bare: Stamped[] = [
      { id: 'in', at: '2026-08-27T00:00:00' },
      { id: 'out', at: '2026-08-26T23:59:00' },
    ];
    expect(ids(filterRecordsByDateRange(bare, at, RANGE))).toEqual(['in']);
  });

  it('places UTC timestamps on their Manila calendar day', () => {
    const utc: Stamped[] = [
      // 2026-08-26 16:00 UTC is 2026-08-27 00:00 in Manila.
      { id: 'manila-aug-27', at: '2026-08-26T16:00:00.000Z' },
      { id: 'manila-aug-26', at: '2026-08-26T15:59:59.999Z' },
      // 2026-10-07 16:00 UTC is 2026-10-08 00:00 in Manila.
      { id: 'manila-oct-08', at: '2026-10-07T16:00:00.000Z' },
      { id: 'manila-oct-07', at: '2026-10-07T15:59:59.999Z' },
    ];
    expect(ids(filterRecordsByDateRange(utc, at, RANGE))).toEqual([
      'manila-aug-27',
      'manila-oct-07',
    ]);
  });

  it('supports a range that is open on one side', () => {
    expect(ids(filterRecordsByDateRange(records, at, { startDate: '2026-10-07', endDate: '' })))
      .toEqual(['last-instant', 'after-end']);
    expect(ids(filterRecordsByDateRange(records, at, { startDate: '', endDate: '2026-08-26' })))
      .toEqual(['before-start']);
  });

  it('keeps every record, including undated ones, when no bound is set', () => {
    const withUndated: Stamped[] = [...records, { id: 'undated' }, { id: 'garbage', at: 'nope' }];
    expect(filterRecordsByDateRange(withUndated, at, { startDate: '', endDate: '' }))
      .toHaveLength(withUndated.length);
  });

  it('drops records without a usable timestamp once a bound is set', () => {
    const withUndated: Stamped[] = [{ id: 'undated' }, { id: 'garbage', at: 'nope' }, records[2]];
    expect(ids(filterRecordsByDateRange(withUndated, at, RANGE))).toEqual(['middle']);
  });

  it('matches nothing when the start day is after the end day', () => {
    const inverted = { startDate: '2026-10-07', endDate: '2026-08-27' };
    expect(isRecordDateRangeValid(inverted)).toBe(false);
    expect(filterRecordsByDateRange(records, at, inverted)).toEqual([]);
  });

  it('treats a single-day range as valid', () => {
    const oneDay = { startDate: '2026-09-15', endDate: '2026-09-15' };
    expect(isRecordDateRangeValid(oneDay)).toBe(true);
    expect(ids(filterRecordsByDateRange(records, at, oneDay))).toEqual(['middle']);
  });
});

describe('sortRecordsNewestFirst', () => {
  it('orders by timestamp descending and leaves the input untouched', () => {
    const records: Stamped[] = [
      { id: 'a', at: '2026-09-01T08:00:00+08:00' },
      { id: 'b', at: '2026-09-03T08:00:00+08:00' },
      { id: 'c', at: '2026-09-02T08:00:00+08:00' },
    ];
    expect(ids(sortRecordsNewestFirst(records, at))).toEqual(['b', 'c', 'a']);
    expect(ids(records)).toEqual(['a', 'b', 'c']);
  });

  it('breaks timestamp ties by push key, newest key first', () => {
    const records: Stamped[] = [
      { id: '-Oa1', at: '2026-09-01T08:00:00+08:00' },
      { id: '-Oa3', at: '2026-09-01T08:00:00+08:00' },
      { id: '-Oa2', at: '2026-09-01T08:00:00+08:00' },
    ];
    expect(ids(sortRecordsNewestFirst(records, at))).toEqual(['-Oa3', '-Oa2', '-Oa1']);
  });

  it('sorts records without a usable timestamp last', () => {
    const records: Stamped[] = [
      { id: 'undated' },
      { id: 'dated', at: '2026-09-01T08:00:00+08:00' },
      { id: 'garbage', at: 'nope' },
    ];
    expect(ids(sortRecordsNewestFirst(records, at))).toEqual(['dated', 'undated', 'garbage']);
  });
});

describe('describeOccupancyDetection', () => {
  const entry = (fields: Partial<OccupancyLogEntry>): OccupancyLogEntry => ({
    timestamp: '2026-09-01T08:00:00+08:00',
    ...fields,
  });

  it('labels PIR-only detections from either PIR flag', () => {
    expect(describeOccupancyDetection(entry({ pirEdge: true }))).toBe('Motion sensor (PIR)');
    expect(describeOccupancyDetection(entry({ pirLevel: true, mlxHit: false })))
      .toBe('Motion sensor (PIR)');
  });

  it('labels MLX-only detections', () => {
    expect(describeOccupancyDetection(entry({ pirEdge: false, pirLevel: false, mlxHit: true })))
      .toBe('Infrared sensor (MLX90614)');
  });

  it('labels detections reported by both sensors', () => {
    expect(describeOccupancyDetection(entry({ pirLevel: true, mlxHit: true })))
      .toBe('Both sensors');
  });

  it('falls back to the reason string only when no flag is set', () => {
    expect(describeOccupancyDetection(entry({ reason: 'pir_edge+mlx' }))).toBe('Both sensors');
    expect(describeOccupancyDetection(entry({ reason: 'mlx' }))).toBe('Infrared sensor (MLX90614)');
    expect(describeOccupancyDetection(entry({ pirEdge: true, reason: 'mlx' })))
      .toBe('Motion sensor (PIR)');
  });

  it('says so when an entry names no sensor', () => {
    expect(describeOccupancyDetection(entry({}))).toBe('Not recorded');
  });
});

describe('row mapping', () => {
  it('builds occupancy rows without exposing diagnostic fields', () => {
    const records: DeviceRecord<OccupancyLogEntry>[] = [{
      id: '-Oa1',
      timestamp: '2026-08-27T15:05:00+08:00',
      pirEdge: true,
      mlxHit: true,
      mlxObjectTemp: 31.2,
      mlxAmbientTemp: 27.9,
      mlxDeltaTemp: 3.3,
      uptimeMs: 123456,
    }];
    expect(toOccupancyLogRows(records)).toEqual([
      { id: '-Oa1', dateTime: 'Aug 27, 2026, 3:05 PM', detectedBy: 'Both sensors' },
    ]);
  });

  it('builds override rows in Manila time with readable labels', () => {
    const records: DeviceRecord<OverrideHistoryEntry>[] = [{
      id: '-Ob1',
      action: 'override',
      requestedBy: 'uid-1',
      requestedByName: 'Ana Reyes',
      requestedByRole: 'admin',
      requestedAt: '2026-08-27T07:05:00.000Z',
      roomUid: 'room-1',
      targetTemp: 24,
      overrideUntil: '2026-08-27T08:05:00.000Z',
    }];
    expect(toOverrideHistoryRows(records)).toEqual([{
      id: '-Ob1',
      dateTime: 'Aug 27, 2026, 3:05 PM',
      user: 'Ana Reyes',
      role: 'Admin',
      action: 'Override set',
      targetTemp: '24°C',
      activeUntil: 'Aug 27, 2026, 4:05 PM',
    }]);
  });

  it('fills placeholders for fields an entry does not carry', () => {
    const records: DeviceRecord<OverrideHistoryEntry>[] = [{
      id: '-Ob2',
      action: 'clear',
      requestedBy: 'uid-1',
      requestedAt: '2026-08-27T07:05:00.000Z',
      roomUid: 'room-1',
    }];
    expect(toOverrideHistoryRows(records)[0]).toMatchObject({
      user: 'Unknown user',
      role: '—',
      action: 'Override cleared',
      targetTemp: '—',
      activeUntil: '—',
    });
  });

  it('labels every known action and passes unknown ones through', () => {
    expect(describeOverrideAction('forcedOff')).toBe('Forced off');
    expect(describeOverrideAction('somethingNew')).toBe('somethingNew');
    expect(describeOverrideAction(undefined)).toBe('—');
  });

  it('never emits the narrow no-break space the PDF fonts cannot draw', () => {
    expect(formatRecordDateTime('2026-08-27T15:05:00+08:00')).not.toMatch(/[  ]/);
    expect(formatRecordDateTime(undefined)).toBe('Unknown time');
  });
});

describe('formatRecordDateRange', () => {
  it('describes closed, open and empty ranges', () => {
    expect(formatRecordDateRange({ startDate: '2026-08-27', endDate: '2026-10-07' }))
      .toBe('Aug 27, 2026 – Oct 7, 2026');
    expect(formatRecordDateRange({ startDate: '2026-08-27', endDate: '2026-08-27' }))
      .toBe('Aug 27, 2026');
    expect(formatRecordDateRange({ startDate: '2026-08-27', endDate: '' }))
      .toBe('From Aug 27, 2026');
    expect(formatRecordDateRange({ startDate: '', endDate: '2026-10-07' }))
      .toBe('Up to Oct 7, 2026');
    expect(formatRecordDateRange({ startDate: '', endDate: '' })).toBe('All dates');
  });
});

describe('pagination', () => {
  const rows = Array.from({ length: 57 }, (_, index) => index + 1);

  it('splits 57 rows into pages of 25', () => {
    expect(recordPageCount(rows.length)).toBe(3);
    expect(pageOfRecords(rows, 1)).toHaveLength(25);
    expect(pageOfRecords(rows, 3)).toEqual([51, 52, 53, 54, 55, 56, 57]);
  });

  it('reports a single page for an empty list', () => {
    expect(recordPageCount(0)).toBe(1);
    expect(pageOfRecords([], 1)).toEqual([]);
  });
});

describe('buildRecordsFileName', () => {
  it('includes the record type, room and period', () => {
    expect(buildRecordsFileName('Occupancy Log', 'Room 101', {
      startDate: '2026-08-27',
      endDate: '2026-10-07',
    })).toBe('occupancy-log-room-101-2026-08-27_to_2026-10-07.pdf');
  });

  it('handles open ranges and names with no usable characters', () => {
    expect(buildRecordsFileName('Override History', '!!!', { startDate: '', endDate: '' }))
      .toBe('override-history-room-all-dates.pdf');
    expect(buildRecordsFileName('Override History', 'Lab A', { startDate: '2026-08-27', endDate: '' }))
      .toBe('override-history-lab-a-2026-08-27_to_latest.pdf');
  });
});
