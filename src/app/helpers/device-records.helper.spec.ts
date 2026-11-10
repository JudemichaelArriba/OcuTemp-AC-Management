import { DeviceRecord, OccupancyLogEntry, OverrideHistoryEntry } from '../models/esp.model';
import {
  buildOccupancyDetails,
  buildOverrideDetails,
  buildRecordRoomLookup,
  buildRecordRoomOptions,
  buildRecordsFileName,
  clampRecordPage,
  classifyOccupancyDetection,
  describeOccupancyDetection,
  describeOverrideAction,
  filterRecordRows,
  filterRecordsByDateRange,
  formatRecordDateRange,
  formatRecordDateTime,
  isRecordDateRangeValid,
  pageOfRecords,
  recordDeviceIds,
  recordPageCount,
  resolveRecordPresetRange,
  resolveRecordRoom,
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
    expect(classifyOccupancyDetection(entry({}))).toBe('unknown');
  });
});

describe('row mapping', () => {
  const LOOKUP = buildRecordRoomLookup([
    { uid: 'room-1', roomName: 'Room 101', device: 'dev-1' },
    { uid: 'room-2', roomName: 'Room 102', device: 'dev-2' },
  ]);

  it('builds occupancy rows with their room and device, without diagnostic fields', () => {
    const records: DeviceRecord<OccupancyLogEntry>[] = [{
      id: '-Oa1',
      deviceId: 'dev-1',
      timestamp: '2026-08-27T15:05:00+08:00',
      pirEdge: true,
      mlxHit: true,
      mlxObjectTemp: 31.2,
      mlxAmbientTemp: 27.9,
      mlxDeltaTemp: 3.3,
      uptimeMs: 123456,
    }];
    expect(toOccupancyLogRows(records, LOOKUP)).toEqual([{
      id: '-Oa1',
      date: 'Aug 27, 2026',
      time: '3:05 PM',
      dateTime: 'Aug 27, 2026, 3:05 PM',
      roomUid: 'room-1',
      room: 'Room 101',
      device: 'dev-1',
      detection: 'both',
      detectedBy: 'Both sensors',
      pirEdge: true,
      pirLevel: false,
      mlxHit: true,
    }]);
  });

  it('builds override rows in Manila time with readable labels', () => {
    const records: DeviceRecord<OverrideHistoryEntry>[] = [{
      id: '-Ob1',
      deviceId: 'dev-1',
      action: 'override',
      requestedBy: 'uid-1',
      requestedByName: 'Ana Reyes',
      requestedByRole: 'admin',
      requestedAt: '2026-08-27T07:05:00.000Z',
      roomUid: 'room-1',
      targetTemp: 24,
      overrideUntil: '2026-08-27T08:05:00.000Z',
    }];
    expect(toOverrideHistoryRows(records, LOOKUP)).toEqual([{
      id: '-Ob1',
      date: 'Aug 27, 2026',
      time: '3:05 PM',
      dateTime: 'Aug 27, 2026, 3:05 PM',
      roomUid: 'room-1',
      room: 'Room 101',
      device: 'dev-1',
      user: 'Ana Reyes',
      role: 'Admin',
      actionKind: 'override',
      action: 'Override set',
      targetTemp: '24°C',
      activeUntil: 'Aug 27, 2026, 4:05 PM',
    }]);
  });

  it('names an override by the room it was made for, not the device\'s current room', () => {
    const records: DeviceRecord<OverrideHistoryEntry>[] = [{
      id: '-Ob4',
      deviceId: 'dev-1',
      action: 'clear',
      requestedBy: 'uid-1',
      requestedAt: '2026-08-27T07:05:00.000Z',
      roomUid: 'room-2',
    }];
    expect(toOverrideHistoryRows(records, LOOKUP)[0]).toMatchObject({
      roomUid: 'room-2',
      room: 'Room 102',
      device: 'dev-1',
    });
  });

  it('fills placeholders for fields an entry does not carry', () => {
    const records: DeviceRecord<OverrideHistoryEntry>[] = [{
      id: '-Ob2',
      deviceId: 'dev-1',
      action: 'clear',
      requestedBy: 'uid-1',
      requestedAt: '2026-08-27T07:05:00.000Z',
      roomUid: 'room-1',
    }];
    expect(toOverrideHistoryRows(records, LOOKUP)[0]).toMatchObject({
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
    expect(formatRecordDateTime('2026-08-27T15:05:00+08:00')).not.toMatch(/[\u00a0\u202f]/);
    expect(formatRecordDateTime(undefined)).toBe('Unknown time');
  });

  it('gives an undated record a readable date cell and no time', () => {
    const records: DeviceRecord<OccupancyLogEntry>[] = [
      { id: '-Oa9', deviceId: 'dev-9', timestamp: 'nope' },
    ];
    expect(toOccupancyLogRows(records, LOOKUP)[0]).toMatchObject({
      date: 'Unknown time',
      time: '',
      dateTime: 'Unknown time',
      roomUid: '',
      room: 'Unassigned',
    });
  });

  it('marks an action it does not know as other', () => {
    const records: DeviceRecord<OverrideHistoryEntry>[] = [{
      id: '-Ob3',
      deviceId: 'dev-1',
      action: 'somethingNew' as OverrideHistoryEntry['action'],
      requestedBy: 'uid-1',
      requestedAt: '2026-08-27T07:05:00.000Z',
      roomUid: 'room-1',
    }];
    expect(toOverrideHistoryRows(records, LOOKUP)[0]).toMatchObject({
      actionKind: 'other',
      action: 'somethingNew',
    });
  });
});

describe('rooms and devices', () => {
  const ROOMS = [
    { uid: 'room-2', roomName: 'Room 102', device: 'dev-2' },
    { uid: 'room-1', roomName: 'Room 101', device: 'dev-1' },
    { uid: 'room-3', roomName: 'Room 9', device: '' },
    { uid: 'room-old', roomName: 'Old Lab', device: '', deleted: true, deletedDevice: 'dev-1' },
    { uid: 'room-gone', roomName: 'Annex', device: '', deleted: true, deletedDevice: 'dev-7' },
  ];

  it('lists each device once, including those of deleted rooms', () => {
    expect(recordDeviceIds(ROOMS)).toEqual(['dev-1', 'dev-2', 'dev-7']);
  });

  it('prefers the live room over a deleted room that used the same device', () => {
    const lookup = buildRecordRoomLookup(ROOMS);
    expect(resolveRecordRoom(lookup, 'dev-1')).toEqual({ roomUid: 'room-1', roomName: 'Room 101' });
    expect(resolveRecordRoom(lookup, 'dev-7'))
      .toEqual({ roomUid: 'room-gone', roomName: 'Annex (deleted)' });
    expect(resolveRecordRoom(lookup, 'dev-x')).toEqual({ roomUid: '', roomName: 'Unassigned' });
  });

  it('falls back to the device room when the record names an unknown room', () => {
    const lookup = buildRecordRoomLookup(ROOMS);
    expect(resolveRecordRoom(lookup, 'dev-2', 'no-such-room').roomName).toBe('Room 102');
  });

  it('offers every room by name after All rooms', () => {
    expect(buildRecordRoomOptions(ROOMS).map((option) => option.label))
      .toEqual(['All rooms', 'Annex (deleted)', 'Old Lab (deleted)', 'Room 9', 'Room 101', 'Room 102']);
  });

  it('filters rows by room and by search text', () => {
    const lookup = buildRecordRoomLookup(ROOMS);
    const rows = toOccupancyLogRows([
      { id: 'a', deviceId: 'dev-1', timestamp: '2026-09-01T08:00:00+08:00', pirEdge: true },
      { id: 'b', deviceId: 'dev-2', timestamp: '2026-09-01T09:00:00+08:00', mlxHit: true },
    ], lookup);
    const text = (row: (typeof rows)[number]) => `${row.room} ${row.device} ${row.detectedBy}`;

    expect(filterRecordRows(rows, 'all', '', text).map((row) => row.id)).toEqual(['a', 'b']);
    expect(filterRecordRows(rows, 'room-2', '', text).map((row) => row.id)).toEqual(['b']);
    expect(filterRecordRows(rows, 'all', '  INFRARED ', text).map((row) => row.id)).toEqual(['b']);
    expect(filterRecordRows(rows, 'room-1', 'infrared', text)).toEqual([]);
  });
});

describe('record details', () => {
  const lookup = buildRecordRoomLookup([{ uid: 'room-1', roomName: 'Room 101', device: 'dev-1' }]);

  it('describes an occupancy entry without raw sensor readings', () => {
    const [row] = toOccupancyLogRows([{
      id: 'a',
      deviceId: 'dev-1',
      timestamp: '2026-08-27T15:05:00+08:00',
      pirEdge: true,
      mlxObjectTemp: 31.2,
      uptimeMs: 99,
    }], lookup);
    const details = buildOccupancyDetails(row);
    const rows = details.groups.flatMap((group) => group.rows);

    expect(details.subtitle).toBe('Aug 27, 2026, 3:05 PM');
    expect(rows).toContainEqual({ label: 'Room', value: 'Room 101' });
    expect(rows).toContainEqual({ label: 'Device', value: 'dev-1' });
    expect(rows).toContainEqual({ label: 'Motion sensor, new movement', value: 'Yes' });
    expect(rows).toContainEqual({ label: 'Infrared sensor', value: 'No' });
    expect(JSON.stringify(details)).not.toMatch(/31\.2|99/);
  });

  it('describes an override entry', () => {
    const [row] = toOverrideHistoryRows([{
      id: 'b',
      deviceId: 'dev-1',
      action: 'override',
      requestedBy: 'uid-1',
      requestedByName: 'Ana Reyes',
      requestedByRole: 'admin',
      requestedAt: '2026-08-27T07:05:00.000Z',
      roomUid: 'room-1',
      targetTemp: 24,
      overrideUntil: '2026-08-27T08:05:00.000Z',
    }], lookup);
    const details = buildOverrideDetails(row);
    const rows = details.groups.flatMap((group) => group.rows);

    expect(details.title).toBe('Override set');
    expect(rows).toContainEqual({ label: 'Requested by', value: 'Ana Reyes' });
    expect(rows).toContainEqual({ label: 'Target temperature', value: '24°C' });
    expect(rows).toContainEqual({ label: 'Active until', value: 'Aug 27, 2026, 4:05 PM' });
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

describe('resolveRecordPresetRange', () => {
  // 2026-11-10 01:30 in Manila, which is still 2026-11-09 in UTC.
  const NOW = new Date('2026-11-09T17:30:00.000Z');

  it('counts days in Manila time and ends today', () => {
    expect(resolveRecordPresetRange('today', NOW))
      .toEqual({ startDate: '2026-11-10', endDate: '2026-11-10' });
    expect(resolveRecordPresetRange('last7', NOW))
      .toEqual({ startDate: '2026-11-04', endDate: '2026-11-10' });
    expect(resolveRecordPresetRange('last30', NOW))
      .toEqual({ startDate: '2026-10-12', endDate: '2026-11-10' });
    expect(resolveRecordPresetRange('thisMonth', NOW))
      .toEqual({ startDate: '2026-11-01', endDate: '2026-11-10' });
  });

  it('leaves the range open for all time and custom', () => {
    expect(resolveRecordPresetRange('all', NOW)).toEqual({ startDate: '', endDate: '' });
    expect(resolveRecordPresetRange('custom', NOW)).toEqual({ startDate: '', endDate: '' });
  });

  it('crosses month boundaries correctly', () => {
    const marchFirst = new Date('2026-03-01T04:00:00.000Z');
    expect(resolveRecordPresetRange('last7', marchFirst))
      .toEqual({ startDate: '2026-02-23', endDate: '2026-03-01' });
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

  it('pulls an out-of-range page back onto the list', () => {
    expect(clampRecordPage(3, 57)).toBe(3);
    expect(clampRecordPage(3, 26)).toBe(2);
    expect(clampRecordPage(3, 0)).toBe(1);
    expect(clampRecordPage(0, 57)).toBe(1);
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
