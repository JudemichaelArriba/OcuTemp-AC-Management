import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RecordsReport } from './records-report';
import { DeviceRecord, OccupancyLogEntry, OverrideHistoryEntry } from '../../models/esp.model';
import { Room } from '../../models/room.model';
import { RecordPage, RecordPageRequest } from '../../helpers/records-pager';
import { DeviceRecordsService } from '../../services/device-records.service';
import { LoggerService } from '../../services/logger.service';
import { SnackBarService } from '../../services/snack-bar.service';

type Occupancy = DeviceRecord<OccupancyLogEntry>;
type Override = DeviceRecord<OverrideHistoryEntry>;

const key = (time: number) => `k${time.toString().padStart(5, '0')}`;

function occupancy(deviceId: string, time: number, mlxHit = false): Occupancy {
  return {
    id: `${deviceId}/${key(time)}`,
    key: key(time),
    deviceId,
    timestamp: '2026-08-27T15:05:00+08:00',
    pirEdge: !mlxHit,
    mlxHit,
  };
}

function page<T extends { key: string }>(list: T[], request: RecordPageRequest): RecordPage<T> {
  const matching = list
    .filter((item) => !request.before || item.key < request.before)
    .sort((a, b) => (a.key < b.key ? 1 : -1));
  return { records: matching.slice(0, request.limit), hasMore: matching.length > request.limit };
}

/** In-memory stand-in for the database reads the component makes. */
class FakeRecordsService {
  occupancy: Record<string, Occupancy[]> = {};
  overrides: Record<string, Override[]> = {};
  occupancyReads = 0;
  overrideReads = 0;
  openTails = 0;
  failNext = false;

  async fetchOccupancyPage(deviceId: string, request: RecordPageRequest): Promise<RecordPage<Occupancy>> {
    this.occupancyReads++;
    await Promise.resolve();
    if (this.failNext) {
      this.failNext = false;
      throw new Error('permission_denied');
    }
    return page(this.occupancy[deviceId] ?? [], request);
  }

  async fetchOverridePage(deviceId: string, request: RecordPageRequest): Promise<RecordPage<Override>> {
    this.overrideReads++;
    await Promise.resolve();
    return page(this.overrides[deviceId] ?? [], request);
  }

  streamOccupancyFrom(): () => void {
    return this.tail();
  }

  streamOverridesFrom(): () => void {
    return this.tail();
  }

  private tail(): () => void {
    this.openTails++;
    return () => { this.openTails--; };
  }
}

const rooms: Room[] = [
  { uid: 'room-1', roomName: 'Room 101', status: 'active', device: 'dev-1' },
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RecordsReport', () => {
  let fixture: ComponentFixture<RecordsReport>;
  let component: RecordsReport;
  let records: FakeRecordsService;

  beforeEach(async () => {
    records = new FakeRecordsService();
    await TestBed.configureTestingModule({
      imports: [RecordsReport],
      providers: [
        { provide: DeviceRecordsService, useValue: records },
        { provide: LoggerService, useValue: { error: vi.fn(), warn: vi.fn() } },
        { provide: SnackBarService, useValue: { error: vi.fn(), warning: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RecordsReport);
    component = fixture.componentInstance;
  });

  async function showRooms(): Promise<void> {
    fixture.componentRef.setInput('rooms', rooms);
    fixture.componentRef.setInput('roomsLoaded', true);
    fixture.detectChanges();
    await settle();
  }

  it('waits for the rooms and loads only the visible tab', async () => {
    records.occupancy['dev-1'] = [1, 2, 3].map((time) => occupancy('dev-1', time));
    fixture.detectChanges();
    await settle();
    expect(records.occupancyReads).toBe(0);
    expect(component.isLoading).toBe(true);

    await showRooms();
    expect(component.isLoading).toBe(false);
    expect(component.occupancy.pageRows.map((row) => row.id)).toEqual(
      [3, 2, 1].map((time) => `dev-1/${key(time)}`)
    );
    expect(records.overrideReads).toBe(0);

    component.selectTab('overrides');
    await settle();
    expect(records.overrideReads).toBe(1);
    expect(component.overrides.state).toBe('ready');
  });

  it('pages through loaded and older records ten at a time', async () => {
    records.occupancy['dev-1'] = Array.from({ length: 25 }, (_, i) => occupancy('dev-1', i + 1));
    await showRooms();
    expect(component.countLabel).toBe('10+ records');

    component.nextPage();
    await settle();
    expect(component.occupancy.page).toBe(2);
    expect(component.occupancy.pageRows[0].id).toBe(`dev-1/${key(15)}`);

    component.nextPage();
    await settle();
    expect(component.occupancy.page).toBe(3);
    expect(component.occupancy.pageRows).toHaveLength(5);
    expect(component.canGoNext).toBe(false);
    expect(component.countLabel).toBe('25 records');

    component.previousPage();
    expect(component.occupancy.page).toBe(2);
  });

  it('fills a search page cut short by the scan budget before moving on', async () => {
    // Three matches among the newest 500 records, twenty among the 500 before them.
    const list: Occupancy[] = [];
    for (let time = 1; time <= 1500; time++) {
      const match = (time > 1200 && time % 100 === 0)
        || (time > 500 && time <= 1000 && time % 25 === 0);
      list.push(occupancy('dev-1', time, match));
    }
    records.occupancy['dev-1'] = list;
    await showRooms();

    component.searchQuery = 'infrared';
    component.onSearch();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await settle();
    expect(component.occupancy.pageRows).toHaveLength(3);
    expect(component.canGoNext).toBe(true);

    component.nextPage();
    await settle();
    expect(component.occupancy.page).toBe(1);
    expect(component.occupancy.pageRows).toHaveLength(10);
    expect(component.occupancy.loadedCount).toBe(13);

    component.nextPage();
    await settle();
    expect(component.occupancy.page).toBe(2);
    expect(component.occupancy.pageRows).toHaveLength(3);
  });

  it('shows a retry state when the first page fails and recovers on retry', async () => {
    records.occupancy['dev-1'] = [1].map((time) => occupancy('dev-1', time));
    records.failNext = true;
    await showRooms();
    expect(component.occupancy.state).toBe('failed');
    expect(component.isLoading).toBe(false);

    component.retry();
    await settle();
    expect(component.occupancy.state).toBe('ready');
    expect(component.occupancy.loadedCount).toBe(1);
  });

  it('drops a load that a filter change replaced', async () => {
    records.occupancy['dev-1'] = [1, 3].map((time) => occupancy('dev-1', time));
    records.occupancy['dev-2'] = [2, 4].map((time) => occupancy('dev-2', time));
    fixture.componentRef.setInput('rooms', [
      ...rooms,
      { uid: 'room-2', roomName: 'Room 102', status: 'active', device: 'dev-2' },
    ]);
    fixture.componentRef.setInput('roomsLoaded', true);
    fixture.detectChanges();

    // Still loading every room when the room filter changes to one of them.
    component.onRoomChange('dev-2');
    await settle();
    expect(component.occupancy.state).toBe('ready');
    expect(component.occupancy.pageRows.map((row) => row.device)).toEqual(['dev-2', 'dev-2']);
  });

  it('says so when no room has a device', async () => {
    fixture.componentRef.setInput('rooms', [{ ...rooms[0], device: '' }]);
    fixture.componentRef.setInput('roomsLoaded', true);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    expect(component.hasDevices).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('No room has a device linked yet');
  });

  it('closes every live tail when destroyed', async () => {
    records.occupancy['dev-1'] = [1].map((time) => occupancy('dev-1', time));
    await showRooms();
    expect(records.openTails).toBe(1);

    fixture.destroy();
    expect(records.openTails).toBe(0);
  });
});
