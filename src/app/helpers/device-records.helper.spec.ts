import { DeviceRecord, OccupancyLogEntry, OverrideHistoryEntry } from '../models/esp.model';
import { pushKeyPrefixForTime } from './log-date-filter.helper';
import {
  buildOccupancyDetails,
  buildOverrideDetails,
  buildRecordRoomLookup,
  buildRecordRoomOptions,
  buildRecordsFileName,
  classifyOccupancyDetection,
  describeOccupancyDetection,
  describeOverrideAction,
  formatRecordDateRange,
  formatRecordDateTime,
  isRecordDateRangeValid,
  isRecordRangeOpenEnded,
  recordDeviceIds,
  recordKeyRange,
  resolveRecordPresetRange,
  resolveRecordRoomName,
  toOccupancyLogRow,
  toOverrideHistoryRow,
} from './device-records.helper';

const occupancy = (
  fields: Partial<DeviceRecord<OccupancyLogEntry>>
): DeviceRecord<OccupancyLogEntry> => ({
  id: 'dev-1/-Oa1',
  key: '-Oa1',
  deviceId: 'dev-1',
  timestamp: '2026-08-27T15:05:00+08:00',
  ...fields,
});

const override = (
  fields: Partial<DeviceRecord<OverrideHistoryEntry>>
): DeviceRecord<OverrideHistoryEntry> => ({
  id: 'dev-1/-Ob1',
  key: '-Ob1',
  deviceId: 'dev-1',
  action: 'override',
  requestedBy: 'uid-1',
  requestedAt: '2026-08-27T07:05:00.000Z',
  roomUid: 'room-1',
  ...fields,
});

describe('recordKeyRange', () => {
  const RANGE = { startDate: '2026-08-27', endDate: '2026-10-07' };
  const keyAt = (iso: string) => `${pushKeyPrefixForTime(Date.parse(iso))}AAAAAAAAAAAA`;
  const inRange = (iso: string, range = RANGE): boolean => {
    const { startKey, endKey } = recordKeyRange(range) ?? {};
    const key = keyAt(iso);
    return (!startKey || key >= startKey) && (!endKey || key < endKey);
  };

  it('covers the first and last instant of the range in Manila time', () => {
    expect(inRange('2026-08-26T23:59:59+08:00')).toBe(false);
    expect(inRange('2026-08-27T00:00:00+08:00')).toBe(true);
    expect(inRange('2026-09-15T12:30:00+08:00')).toBe(true);
    expect(inRange('2026-10-07T23:59:59+08:00')).toBe(true);
    expect(inRange('2026-10-08T00:00:00+08:00')).toBe(false);
  });

  it('places UTC instants on their Manila calendar day', () => {
    // 2026-08-26 16:00 UTC is 2026-08-27 00:00 in Manila.
    expect(inRange('2026-08-26T15:59:59.999Z')).toBe(false);
    expect(inRange('2026-08-26T16:00:00.000Z')).toBe(true);
    // 2026-10-07 16:00 UTC is 2026-10-08 00:00 in Manila.
    expect(inRange('2026-10-07T15:59:59.999Z')).toBe(true);
    expect(inRange('2026-10-07T16:00:00.000Z')).toBe(false);
  });

  it('leaves an unset side open', () => {
    const fromOnly = { startDate: '2026-10-07', endDate: '' };
    expect(recordKeyRange(fromOnly)?.endKey).toBeUndefined();
    expect(inRange('2026-10-06T23:59:59+08:00', fromOnly)).toBe(false);
    expect(inRange('2030-01-01T00:00:00+08:00', fromOnly)).toBe(true);

    const untilOnly = { startDate: '', endDate: '2026-08-26' };
    expect(recordKeyRange(untilOnly)?.startKey).toBeUndefined();
    expect(inRange('2020-01-01T00:00:00+08:00', untilOnly)).toBe(true);
    expect(inRange('2026-08-27T00:00:00+08:00', untilOnly)).toBe(false);
  });

  it('is undefined when no day is selected', () => {
    expect(recordKeyRange({ startDate: '', endDate: '' })).toBeUndefined();
  });
});

describe('record date ranges', () => {
  it('rejects a start day after the end day and accepts a single day', () => {
    expect(isRecordDateRangeValid({ startDate: '2026-10-07', endDate: '2026-08-27' })).toBe(false);
    expect(isRecordDateRangeValid({ startDate: '2026-09-15', endDate: '2026-09-15' })).toBe(true);
    expect(isRecordDateRangeValid({ startDate: '', endDate: '' })).toBe(true);
    expect(isRecordDateRangeValid({ startDate: 'nope', endDate: '' })).toBe(false);
  });

  it('knows whether new records can still fall inside a range', () => {
    // 2026-11-10 01:30 in Manila, which is still 2026-11-09 in UTC.
    const now = new Date('2026-11-09T17:30:00.000Z');
    expect(isRecordRangeOpenEnded({ startDate: '', endDate: '' }, now)).toBe(true);
    expect(isRecordRangeOpenEnded({ startDate: '2026-11-01', endDate: '2026-11-10' }, now)).toBe(true);
    expect(isRecordRangeOpenEnded({ startDate: '2026-08-27', endDate: '2026-11-09' }, now)).toBe(false);
  });

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

describe('rooms and devices', () => {
  const ROOMS = [
    { uid: 'room-2', roomName: 'Room 102', device: 'dev-2' },
    { uid: 'room-1', roomName: 'Room 101', device: 'dev-1' },
    { uid: 'room-3', roomName: 'Room 9', device: '' },
    { uid: 'room-old', roomName: 'Old Lab', device: '', deleted: true, deletedDevice: 'dev-1' },
    { uid: 'room-gone', roomName: 'Annex', device: '', deleted: true, deletedDevice: 'dev-7' },
  ];
  const lookup = buildRecordRoomLookup(ROOMS);

  it('lists each device once, including those of deleted rooms', () => {
    expect(recordDeviceIds(ROOMS)).toEqual(['dev-1', 'dev-2', 'dev-7']);
  });

  it('prefers the live room over a deleted room that used the same device', () => {
    expect(resolveRecordRoomName(lookup, 'dev-1')).toBe('Room 101');
    expect(resolveRecordRoomName(lookup, 'dev-7')).toBe('Annex (deleted)');
    expect(resolveRecordRoomName(lookup, 'dev-x')).toBe('Unassigned');
  });

  it('uses the room a record names, falling back to the device room when it is unknown', () => {
    expect(resolveRecordRoomName(lookup, 'dev-1', 'room-2')).toBe('Room 102');
    expect(resolveRecordRoomName(lookup, 'dev-2', 'no-such-room')).toBe('Room 102');
  });

  it('offers one option per device, labelled with its room, after All rooms', () => {
    expect(buildRecordRoomOptions(ROOMS)).toEqual([
      { value: 'all', label: 'All rooms' },
      { value: 'dev-7', label: 'Annex (deleted)', hint: 'dev-7' },
      { value: 'dev-1', label: 'Room 101', hint: 'dev-1' },
      { value: 'dev-2', label: 'Room 102', hint: 'dev-2' },
    ]);
  });
});

describe('row mapping', () => {
  const lookup = buildRecordRoomLookup([
    { uid: 'room-1', roomName: 'Room 101', device: 'dev-1' },
    { uid: 'room-2', roomName: 'Room 102', device: 'dev-2' },
  ]);

  it('builds an occupancy row with its room and device, without diagnostic fields', () => {
    const row = toOccupancyLogRow(occupancy({
      pirEdge: true,
      mlxHit: true,
      mlxObjectTemp: 31.2,
      mlxAmbientTemp: 27.9,
      mlxDeltaTemp: 3.3,
      uptimeMs: 123456,
    }), lookup);

    expect(row).toEqual({
      id: 'dev-1/-Oa1',
      date: 'Aug 27, 2026',
      time: '3:05 PM',
      dateTime: 'Aug 27, 2026, 3:05 PM',
      room: 'Room 101',
      device: 'dev-1',
      detection: 'both',
      detectedBy: 'Both sensors',
      pirEdge: true,
      pirLevel: false,
      mlxHit: true,
    });
  });

  it('builds an override row in Manila time with readable labels', () => {
    const row = toOverrideHistoryRow(override({
      requestedByName: 'Ana Reyes',
      requestedByRole: 'admin',
      targetTemp: 24,
      overrideUntil: '2026-08-27T08:05:00.000Z',
    }), lookup);

    expect(row).toEqual({
      id: 'dev-1/-Ob1',
      date: 'Aug 27, 2026',
      time: '3:05 PM',
      dateTime: 'Aug 27, 2026, 3:05 PM',
      room: 'Room 101',
      device: 'dev-1',
      user: 'Ana Reyes',
      role: 'Admin',
      actionKind: 'override',
      action: 'Override set',
      targetTemp: '24°C',
      activeUntil: 'Aug 27, 2026, 4:05 PM',
    });
  });

  it('names an override by the room it was made for, not the device\'s current room', () => {
    expect(toOverrideHistoryRow(override({ action: 'clear', roomUid: 'room-2' }), lookup))
      .toMatchObject({ room: 'Room 102', device: 'dev-1' });
  });

  it('fills placeholders for fields an entry does not carry', () => {
    expect(toOverrideHistoryRow(override({ action: 'clear' }), lookup)).toMatchObject({
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
    expect(toOverrideHistoryRow(
      override({ action: 'somethingNew' as OverrideHistoryEntry['action'] }),
      lookup
    )).toMatchObject({ actionKind: 'other', action: 'somethingNew' });
  });

  it('never emits the narrow no-break space the PDF fonts cannot draw', () => {
    expect(formatRecordDateTime('2026-08-27T15:05:00+08:00')).not.toMatch(/[  ]/);
    expect(formatRecordDateTime(undefined)).toBe('Unknown time');
  });

  it('gives an undated record from an unknown device a readable row', () => {
    expect(toOccupancyLogRow(occupancy({ deviceId: 'dev-9', timestamp: 'nope' }), lookup))
      .toMatchObject({ date: 'Unknown time', time: '', dateTime: 'Unknown time', room: 'Unassigned' });
  });
});

describe('record details', () => {
  const lookup = buildRecordRoomLookup([{ uid: 'room-1', roomName: 'Room 101', device: 'dev-1' }]);

  it('describes an occupancy entry without raw sensor readings', () => {
    const details = buildOccupancyDetails(
      toOccupancyLogRow(occupancy({ pirEdge: true, mlxObjectTemp: 31.2, uptimeMs: 99 }), lookup)
    );
    const rows = details.groups.flatMap((group) => group.rows);

    expect(details.subtitle).toBe('Aug 27, 2026, 3:05 PM');
    expect(rows).toContainEqual({ label: 'Room', value: 'Room 101' });
    expect(rows).toContainEqual({ label: 'Device', value: 'dev-1' });
    expect(rows).toContainEqual({ label: 'Motion sensor, new movement', value: 'Yes' });
    expect(rows).toContainEqual({ label: 'Infrared sensor', value: 'No' });
    expect(JSON.stringify(details)).not.toMatch(/31\.2|99/);
  });

  it('describes an override entry', () => {
    const details = buildOverrideDetails(toOverrideHistoryRow(override({
      requestedByName: 'Ana Reyes',
      requestedByRole: 'admin',
      targetTemp: 24,
      overrideUntil: '2026-08-27T08:05:00.000Z',
    }), lookup));
    const rows = details.groups.flatMap((group) => group.rows);

    expect(details.title).toBe('Override set');
    expect(rows).toContainEqual({ label: 'Requested by', value: 'Ana Reyes' });
    expect(rows).toContainEqual({ label: 'Target temperature', value: '24°C' });
    expect(rows).toContainEqual({ label: 'Active until', value: 'Aug 27, 2026, 4:05 PM' });
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
