import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Injector,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DropDown, DropDownOption } from '../shared/drop-down/drop-down';
import { RecordDetailsModal } from '../record-details-modal/record-details-modal';
import { DeviceRecord, OccupancyLogEntry, OverrideHistoryEntry } from '../../models/esp.model';
import { Room } from '../../models/room.model';
import { DeviceRecordsService } from '../../services/device-records.service';
import { LoggerService } from '../../services/logger.service';
import { SnackBarService } from '../../services/snack-bar.service';
import {
  ALL_ROOMS,
  OccupancyDetection,
  OccupancyLogRow,
  OverrideActionKind,
  OverrideHistoryRow,
  RECORDS_PAGE_SIZE,
  RECORD_DATE_PRESETS,
  RecordDatePreset,
  RecordDateRange,
  RecordDetails,
  RecordRoomLookup,
  RecordRowBase,
  buildOccupancyDetails,
  buildOverrideDetails,
  buildRecordRoomLookup,
  buildRecordRoomOptions,
  buildRecordsFileName,
  clampRecordPage,
  filterRecordRows,
  filterRecordsByDateRange,
  formatRecordDateRange,
  hasRecordDateFilter,
  pageOfRecords,
  recordDeviceIds,
  recordPageCount,
  resolveRecordPresetRange,
  sortRecordsNewestFirst,
  toOccupancyLogRows,
  toOverrideHistoryRows,
} from '../../helpers/device-records.helper';

export type RecordsTab = 'occupancy' | 'overrides';

/** How long a row that just arrived stays highlighted. */
const FRESH_ROW_MS = 2600;
const SEARCH_DEBOUNCE_MS = 200;

interface ChipStyle {
  readonly icon: string;
  readonly classes: string;
}

interface SelectedRecord {
  readonly details: RecordDetails;
  readonly chip: ChipStyle;
}

/** What the shared parts of the template need from a record set, whatever its row type. */
interface RecordSetView {
  readonly label: string;
  /** Shown when no device has stored an entry of this kind. */
  readonly emptyHint: string;
  readonly pdfHead: readonly string[];
  /** PDF column indexes kept on one line (dates). */
  readonly pdfNoWrapColumns: readonly number[];
  /** Devices that have not delivered their first snapshot yet. */
  readonly pending: Set<string>;
  failed: boolean;
  /** Entries stored across all devices, before any filter. */
  storedCount: number;
  /** Rows matching the current filters, newest first. */
  rowCount: number;
  page: number;
  /** One string per PDF column for every row matching the current filters. */
  pdfBody(): string[][];
}

interface RecordSet<TRecord, TRow extends RecordRowBase> extends RecordSetView {
  readonly timestampOf: (record: TRecord) => string | undefined;
  readonly toRows: (records: readonly TRecord[], lookup: RecordRoomLookup) => TRow[];
  /** Text of a row that the search box is matched against. */
  readonly searchText: (row: TRow) => string;
  readonly byDevice: Map<string, TRecord[]>;
  /** True once every device has delivered a snapshot, so later ones can be diffed for new rows. */
  loaded: boolean;
  records: TRecord[];
  rows: TRow[];
  pageRows: TRow[];
}

function createRecordSet<TRecord, TRow extends RecordRowBase>(
  config: Pick<
    RecordSet<TRecord, TRow>,
    'label' | 'emptyHint' | 'pdfHead' | 'pdfNoWrapColumns' | 'timestampOf' | 'toRows' | 'searchText'
  > & { readonly toPdfRow: (row: TRow) => string[] }
): RecordSet<TRecord, TRow> {
  const set: RecordSet<TRecord, TRow> = {
    ...config,
    byDevice: new Map<string, TRecord[]>(),
    pending: new Set<string>(),
    failed: false,
    loaded: false,
    storedCount: 0,
    rowCount: 0,
    page: 1,
    records: [],
    rows: [],
    pageRows: [],
    pdfBody: () => set.rows.map(config.toPdfRow),
  };
  return set;
}

/**
 * Read-only "Records" section of Energy Reports: the occupancy log and override history of
 * every room's device, with the room and device on each row. Both sets stream live, and are
 * searched, filtered, paged and exported in the browser. Clicking a row opens its details.
 */
@Component({
  selector: 'app-records-report',
  standalone: true,
  imports: [FormsModule, DropDown, RecordDetailsModal],
  templateUrl: './records-report.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecordsReport implements OnChanges, OnDestroy {
  /** Every room, including inactive and deleted ones, so their records keep a room name. */
  @Input() rooms: Room[] = [];
  /** False until the parent's room stream has delivered, so "no devices" is not shown early. */
  @Input() roomsLoaded = false;

  readonly tabs: readonly { readonly id: RecordsTab; readonly label: string }[] = [
    { id: 'occupancy', label: 'Occupancy log' },
    { id: 'overrides', label: 'Override history' },
  ];
  readonly presetOptions = RECORD_DATE_PRESETS;
  readonly skeletonRows = [1, 2, 3, 4, 5];

  readonly detectionChips: Record<OccupancyDetection, ChipStyle> = {
    pir: { icon: 'directions_walk', classes: 'bg-blue-50 text-blue-700' },
    mlx: { icon: 'device_thermostat', classes: 'bg-orange-50 text-orange-700' },
    both: { icon: 'done_all', classes: 'bg-emerald-50 text-emerald-700' },
    unknown: { icon: 'help', classes: 'bg-slate-100 text-slate-500' },
  };

  readonly actionChips: Record<OverrideActionKind, ChipStyle> = {
    override: { icon: 'tune', classes: 'bg-blue-50 text-blue-700' },
    clear: { icon: 'undo', classes: 'bg-slate-100 text-slate-600' },
    forcedOff: { icon: 'power_settings_new', classes: 'bg-rose-50 text-rose-700' },
    other: { icon: 'more_horiz', classes: 'bg-slate-100 text-slate-600' },
  };

  activeTab: RecordsTab = 'occupancy';
  searchQuery = '';
  roomOptions: DropDownOption[] = buildRecordRoomOptions([]);
  roomFilter = ALL_ROOMS;
  preset: RecordDatePreset = 'all';
  startDate = '';
  endDate = '';
  isExporting = false;
  hasDevices = false;
  selected: SelectedRecord | null = null;

  /** IDs of rows that arrived in the latest live update, highlighted briefly. */
  freshIds: ReadonlySet<string> = new Set<string>();

  readonly occupancy = createRecordSet<DeviceRecord<OccupancyLogEntry>, OccupancyLogRow>({
    label: 'Occupancy Log',
    emptyHint: 'An entry is added each time a room goes from empty to occupied.',
    pdfHead: ['Date and time', 'Room', 'Device', 'Detected by'],
    pdfNoWrapColumns: [0],
    timestampOf: (record) => record.timestamp,
    toRows: toOccupancyLogRows,
    searchText: (row) => `${row.room} ${row.device} ${row.detectedBy} ${row.dateTime}`,
    toPdfRow: (row) => [row.dateTime, row.room, row.device, row.detectedBy],
  });

  readonly overrides = createRecordSet<DeviceRecord<OverrideHistoryEntry>, OverrideHistoryRow>({
    label: 'Override History',
    emptyHint: 'An entry is added each time someone sets or clears a manual override.',
    pdfHead: [
      'Date and time', 'Room', 'Device', 'User', 'Role', 'Action', 'Target temperature', 'Active until',
    ],
    pdfNoWrapColumns: [0, 7],
    timestampOf: (record) => record.requestedAt,
    toRows: toOverrideHistoryRows,
    searchText: (row) =>
      `${row.room} ${row.device} ${row.user} ${row.role} ${row.action} ${row.dateTime}`,
    toPdfRow: (row) => [
      row.dateTime, row.room, row.device, row.user, row.role, row.action, row.targetTemp,
      row.activeUntil,
    ],
  });

  private roomLookup: RecordRoomLookup = buildRecordRoomLookup([]);
  /** What the current streams and room names were built from; unchanged rooms are ignored. */
  private roomsSignature = '';
  private devicesKey = '';
  private appliedQuery = '';
  private unsubscribers: Array<() => void> = [];
  private freshTimer?: ReturnType<typeof setTimeout>;
  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private recordsService: DeviceRecordsService,
    private logger: LoggerService,
    private snackBar: SnackBarService,
    private injector: Injector,
    private cdr: ChangeDetectorRef,
  ) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['rooms']) this.syncRooms();
  }

  ngOnDestroy(): void {
    this.disconnect();
    clearTimeout(this.freshTimer);
    clearTimeout(this.searchTimer);
  }

  get active(): RecordSetView {
    return this.activeTab === 'occupancy' ? this.occupancy : this.overrides;
  }

  get isLoading(): boolean {
    return !this.roomsLoaded || (this.hasDevices && this.active.pending.size > 0);
  }

  get dateRange(): RecordDateRange {
    return { startDate: this.startDate, endDate: this.endDate };
  }

  /** True when a search, room or period filter is narrowing the list. */
  get isFiltered(): boolean {
    return this.appliedQuery !== ''
      || this.roomFilter !== ALL_ROOMS
      || hasRecordDateFilter(this.dateRange);
  }

  get countLabel(): string {
    const count = this.active.rowCount;
    return `${count} ${count === 1 ? 'record' : 'records'}`;
  }

  get pageCount(): number {
    return recordPageCount(this.active.rowCount);
  }

  get firstRowNumber(): number {
    return this.active.rowCount === 0 ? 0 : (this.active.page - 1) * RECORDS_PAGE_SIZE + 1;
  }

  get lastRowNumber(): number {
    return Math.min(this.active.page * RECORDS_PAGE_SIZE, this.active.rowCount);
  }

  get canExport(): boolean {
    const set = this.active;
    return !this.isLoading && !set.failed && set.rowCount > 0 && !this.isExporting;
  }

  /** Rows matching the filters for a tab, or null while that tab has nothing to count yet. */
  tabCount(tab: RecordsTab): number | null {
    const set: RecordSetView = tab === 'occupancy' ? this.occupancy : this.overrides;
    const ready = this.roomsLoaded && set.pending.size === 0 && !set.failed;
    return ready ? set.rowCount : null;
  }

  selectTab(tab: RecordsTab): void {
    this.activeTab = tab;
    this.cdr.markForCheck();
  }

  onSearch(): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.appliedQuery = this.searchQuery.trim();
      this.applyFilters();
    }, SEARCH_DEBOUNCE_MS);
  }

  clearSearch(): void {
    clearTimeout(this.searchTimer);
    this.searchQuery = '';
    this.appliedQuery = '';
    this.applyFilters();
  }

  onRoomChange(value: string): void {
    if (!this.roomOptions.some((option) => option.value === value)) return;
    this.roomFilter = value;
    this.applyFilters();
  }

  onPresetChange(value: string): void {
    const option = this.presetOptions.find((candidate) => candidate.value === value);
    if (!option) return;

    this.preset = option.value as RecordDatePreset;
    // "Custom range" keeps whatever days are already selected as the starting point.
    if (this.preset !== 'custom') {
      const range = resolveRecordPresetRange(this.preset);
      this.startDate = range.startDate;
      this.endDate = range.endDate;
    }
    this.applyFilters();
  }

  onStartDateChange(value: string): void {
    this.startDate = value;
    this.preset = 'custom';
    this.applyFilters();
  }

  onEndDateChange(value: string): void {
    this.endDate = value;
    this.preset = 'custom';
    this.applyFilters();
  }

  clearFilters(): void {
    clearTimeout(this.searchTimer);
    this.searchQuery = '';
    this.appliedQuery = '';
    this.roomFilter = ALL_ROOMS;
    this.preset = 'all';
    this.startDate = '';
    this.endDate = '';
    this.applyFilters();
  }

  previousPage(): void {
    this.goToPage(this.active.page - 1);
  }

  nextPage(): void {
    this.goToPage(this.active.page + 1);
  }

  openOccupancy(row: OccupancyLogRow): void {
    this.selected = {
      details: buildOccupancyDetails(row),
      chip: this.detectionChips[row.detection],
    };
    this.cdr.markForCheck();
  }

  openOverride(row: OverrideHistoryRow): void {
    this.selected = {
      details: buildOverrideDetails(row),
      chip: this.actionChips[row.actionKind],
    };
    this.cdr.markForCheck();
  }

  closeDetails(): void {
    this.selected = null;
    this.cdr.markForCheck();
  }

  /** Reopens the live streams after one of them failed. */
  retry(): void {
    this.connect(recordDeviceIds(this.rooms));
  }

  async exportPdf(): Promise<void> {
    if (!this.canExport) return;

    const tab = this.activeTab;
    const set = this.active;
    const range = this.dateRange;
    const roomLabel = this.roomOptions.find((option) => option.value === this.roomFilter)?.label
      ?? 'All rooms';
    const body = set.pdfBody();

    this.isExporting = true;
    this.cdr.markForCheck();

    try {
      // Loaded on demand so jsPDF stays out of the initial bundle.
      const { PdfExportService } = await import('../../services/pdf-export.service');
      await this.injector.get(PdfExportService).generateRecordsReport({
        recordType: set.label,
        roomName: roomLabel,
        rangeLabel: formatRecordDateRange(range),
        head: [...set.pdfHead],
        body,
        noWrapColumns: [...set.pdfNoWrapColumns],
        fileName: buildRecordsFileName(set.label, roomLabel, range),
      });
    } catch (err) {
      this.logger.error('Failed to export records PDF', err, {
        component: 'RecordsReport',
        action: 'exportPdf',
        tab,
      });
      this.snackBar.error('Export failed', 'The PDF could not be created. Try again.');
    } finally {
      this.isExporting = false;
      this.cdr.markForCheck();
    }
  }

  /** Rebuilds room names and, when the set of devices changed, the live streams. */
  private syncRooms(): void {
    const signature = this.rooms
      .map((room) =>
        [room.uid, room.roomName, room.device, room.deleted === true, room.deletedDevice ?? ''].join('|'))
      .join('\n');
    if (signature === this.roomsSignature && this.roomsLoaded) return;
    this.roomsSignature = signature;

    this.roomLookup = buildRecordRoomLookup(this.rooms);
    this.roomOptions = buildRecordRoomOptions(this.rooms);
    if (!this.roomOptions.some((option) => option.value === this.roomFilter)) {
      this.roomFilter = ALL_ROOMS;
    }

    const deviceIds = recordDeviceIds(this.rooms);
    const devicesKey = deviceIds.join('\n');
    if (devicesKey !== this.devicesKey) {
      this.connect(deviceIds);
    } else {
      this.applyFilters();
    }
  }

  /** (Re)opens one live stream per device for each record type. */
  private connect(deviceIds: string[]): void {
    this.disconnect();
    this.clearFresh();
    this.devicesKey = deviceIds.join('\n');
    this.hasDevices = deviceIds.length > 0;

    this.reset(this.occupancy, deviceIds);
    this.reset(this.overrides, deviceIds);
    this.cdr.markForCheck();

    for (const deviceId of deviceIds) {
      this.unsubscribers.push(
        this.recordsService.streamOccupancyLog(
          deviceId,
          (records) => this.receive(this.occupancy, deviceId, records),
          () => this.fail(this.occupancy)
        ),
        this.recordsService.streamOverrideHistory(
          deviceId,
          (records) => this.receive(this.overrides, deviceId, records),
          () => this.fail(this.overrides)
        ),
      );
    }
  }

  private disconnect(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
  }

  private reset<TRecord, TRow extends RecordRowBase>(
    set: RecordSet<TRecord, TRow>,
    deviceIds: string[]
  ): void {
    set.byDevice.clear();
    set.pending.clear();
    deviceIds.forEach((deviceId) => set.pending.add(deviceId));
    set.failed = false;
    set.loaded = false;
    set.records = [];
    this.applyFiltersTo(set, 1);
  }

  private receive<TRecord extends { readonly id: string }, TRow extends RecordRowBase>(
    set: RecordSet<TRecord, TRow>,
    deviceId: string,
    incoming: TRecord[]
  ): void {
    set.byDevice.set(deviceId, incoming);
    set.pending.delete(deviceId);

    const records = sortRecordsNewestFirst([...set.byDevice.values()].flat(), set.timestampOf);
    if (set.loaded) {
      const known = new Set(set.records.map((record) => record.id));
      this.markFresh(records.filter((record) => !known.has(record.id)).map((record) => record.id));
    }

    set.records = records;
    if (set.pending.size === 0) set.loaded = true;
    // A live update keeps the reader on the page they were viewing.
    this.applyFiltersTo(set, set.page);
    this.cdr.markForCheck();
  }

  /** The stream is already closed and reported by DeviceRecordsService; show the retry state. */
  private fail<TRecord, TRow extends RecordRowBase>(set: RecordSet<TRecord, TRow>): void {
    set.failed = true;
    this.cdr.markForCheck();
  }

  private markFresh(ids: string[]): void {
    if (ids.length === 0) return;
    this.freshIds = new Set([...this.freshIds, ...ids]);
    clearTimeout(this.freshTimer);
    this.freshTimer = setTimeout(() => {
      this.freshIds = new Set<string>();
      this.cdr.markForCheck();
    }, FRESH_ROW_MS);
  }

  private clearFresh(): void {
    clearTimeout(this.freshTimer);
    this.freshIds = new Set<string>();
  }

  private applyFilters(): void {
    this.applyFiltersTo(this.occupancy, 1);
    this.applyFiltersTo(this.overrides, 1);
    this.cdr.markForCheck();
  }

  private applyFiltersTo<TRecord, TRow extends RecordRowBase>(
    set: RecordSet<TRecord, TRow>,
    page: number
  ): void {
    const inPeriod = filterRecordsByDateRange(set.records, set.timestampOf, this.dateRange);
    set.rows = filterRecordRows(
      set.toRows(inPeriod, this.roomLookup),
      this.roomFilter,
      this.appliedQuery,
      set.searchText
    );
    set.storedCount = set.records.length;
    set.rowCount = set.rows.length;
    this.showPage(set, page);
  }

  private goToPage(page: number): void {
    if (this.activeTab === 'occupancy') this.showPage(this.occupancy, page);
    else this.showPage(this.overrides, page);
    this.cdr.markForCheck();
  }

  private showPage<TRecord, TRow extends RecordRowBase>(
    set: RecordSet<TRecord, TRow>,
    page: number
  ): void {
    set.page = clampRecordPage(page, set.rowCount);
    set.pageRows = pageOfRecords(set.rows, set.page);
  }
}
