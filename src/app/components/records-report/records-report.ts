import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Injector,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  inject,
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
  PagedRecord,
  RecordsPager,
  RecordsPagerQuery,
  RecordsPagerSource,
  collectRecords,
} from '../../helpers/records-pager';
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
  formatRecordDateRange,
  hasRecordDateFilter,
  isRecordDateRangeValid,
  isRecordRangeOpenEnded,
  recordDeviceIds,
  recordKeyRange,
  resolveRecordPresetRange,
  toOccupancyLogRow,
  toOverrideHistoryRow,
} from '../../helpers/device-records.helper';

export type RecordsTab = 'occupancy' | 'overrides';

const SEARCH_DEBOUNCE_MS = 200;
/** Text search cannot run on the server, so matches are found by reading in larger chunks. */
const SEARCH_CHUNK_SIZE = 100;
/** Most records one page request may read while searching; "next" continues from there. */
const SEARCH_SCAN_BUDGET = 500;
const EXPORT_CHUNK_SIZE = 500;
/** Keeps a PDF export bounded; a narrower period or room gets the rest. */
const EXPORT_MAX_ROWS = 5000;

/** `idle`: nothing requested yet for the current filters. */
type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

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
  state: LoadState;
  /** Reading an older page after "next". */
  loadingMore: boolean;
  /** 1-based page of the loaded rows on screen. */
  page: number;
  /** Rows loaded so far for the current filters. */
  loadedCount: number;
  /** Older matching records may still exist on the server. */
  hasMore: boolean;
  /** Records read from the server so far, matching the search or not. */
  scanned: number;
}

interface RecordSet<TRecord extends PagedRecord, TRow extends RecordRowBase> extends RecordSetView {
  readonly source: RecordsPagerSource<TRecord>;
  readonly pager: RecordsPager<TRecord>;
  readonly toRow: (record: TRecord, lookup: RecordRoomLookup) => TRow;
  /** Text of a row that the search box is matched against. */
  readonly searchText: (row: TRow) => string;
  readonly toPdfRow: (row: TRow) => string[];
  /** Bumped on every (re)load so a superseded request cannot update the view. */
  loadToken: number;
  /** Filters changed since this set was loaded; reload when its tab is shown. */
  stale: boolean;
  pageRows: TRow[];
}

type RecordSetConfig<TRecord extends PagedRecord, TRow extends RecordRowBase> = Pick<
  RecordSet<TRecord, TRow>,
  'label' | 'emptyHint' | 'pdfHead' | 'pdfNoWrapColumns' | 'source' | 'toRow' | 'searchText' | 'toPdfRow'
>;

/**
 * Read-only "Records" section of Energy Reports: the occupancy log and override history of
 * every room's device, with the room and device on each row.
 *
 * Rows are read from the database a page at a time (`RecordsPager`), newest first, and new
 * records are added on top as they arrive. Room and period are applied by the server;
 * the search box is matched while reading. Clicking a row opens its details.
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

  private readonly recordsService = inject(DeviceRecordsService);
  private readonly logger = inject(LoggerService);
  private readonly snackBar = inject(SnackBarService);
  private readonly injector = inject(Injector);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly pageSize = RECORDS_PAGE_SIZE;
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

  readonly occupancy = this.createRecordSet<DeviceRecord<OccupancyLogEntry>, OccupancyLogRow>({
    label: 'Occupancy Log',
    emptyHint: 'An entry is added each time a room goes from empty to occupied.',
    pdfHead: ['Date and time', 'Room', 'Device', 'Detected by'],
    pdfNoWrapColumns: [0],
    source: {
      fetchPage: (deviceId, request) => this.recordsService.fetchOccupancyPage(deviceId, request),
      streamFrom: (deviceId, fromKey, onRecords) =>
        this.recordsService.streamOccupancyFrom(deviceId, fromKey, onRecords),
    },
    toRow: toOccupancyLogRow,
    searchText: (row) => `${row.room} ${row.device} ${row.detectedBy} ${row.dateTime}`,
    toPdfRow: (row) => [row.dateTime, row.room, row.device, row.detectedBy],
  });

  readonly overrides = this.createRecordSet<DeviceRecord<OverrideHistoryEntry>, OverrideHistoryRow>({
    label: 'Override History',
    emptyHint: 'An entry is added each time someone sets or clears a manual override.',
    pdfHead: [
      'Date and time', 'Room', 'Device', 'User', 'Role', 'Action', 'Target temperature', 'Active until',
    ],
    pdfNoWrapColumns: [0, 7],
    source: {
      fetchPage: (deviceId, request) => this.recordsService.fetchOverridePage(deviceId, request),
      streamFrom: (deviceId, fromKey, onRecords) =>
        this.recordsService.streamOverridesFrom(deviceId, fromKey, onRecords),
    },
    toRow: toOverrideHistoryRow,
    searchText: (row) =>
      `${row.room} ${row.device} ${row.user} ${row.role} ${row.action} ${row.dateTime}`,
    toPdfRow: (row) => [
      row.dateTime, row.room, row.device, row.user, row.role, row.action, row.targetTemp,
      row.activeUntil,
    ],
  });

  private roomLookup: RecordRoomLookup = buildRecordRoomLookup([]);
  private deviceIds: string[] = [];
  /** What the room names and device list were built from; unchanged rooms are ignored. */
  private roomsSignature: string | null = null;
  private appliedQuery = '';
  private searchTimer?: ReturnType<typeof setTimeout>;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['rooms'] || changes['roomsLoaded']) this.syncRooms();
  }

  ngOnDestroy(): void {
    this.occupancy.pager.dispose();
    this.overrides.pager.dispose();
    clearTimeout(this.searchTimer);
  }

  get active(): RecordSetView {
    return this.activeTab === 'occupancy' ? this.occupancy : this.overrides;
  }

  get isLoading(): boolean {
    const state = this.active.state;
    return !this.roomsLoaded || state === 'idle' || state === 'loading';
  }

  get dateRange(): RecordDateRange {
    return { startDate: this.startDate, endDate: this.endDate };
  }

  get isSearching(): boolean {
    return this.appliedQuery !== '';
  }

  /** True when a search, room or period filter is narrowing the list. */
  get isFiltered(): boolean {
    return this.isSearching || this.roomFilter !== ALL_ROOMS || hasRecordDateFilter(this.dateRange);
  }

  /** `30+ records` while older ones may exist, the exact total once everything is loaded. */
  get countLabel(): string {
    const { loadedCount, hasMore } = this.active;
    if (loadedCount === 0 && hasMore) return 'No matches yet';
    return `${loadedCount}${hasMore ? '+' : ''} ${loadedCount === 1 && !hasMore ? 'record' : 'records'}`;
  }

  get firstRowNumber(): number {
    return (this.active.page - 1) * this.pageSize + 1;
  }

  get lastRowNumber(): number {
    return Math.min(this.active.page * this.pageSize, this.active.loadedCount);
  }

  get canGoPrevious(): boolean {
    return this.active.state === 'ready' && this.active.page > 1 && !this.active.loadingMore;
  }

  get canGoNext(): boolean {
    const set = this.active;
    return set.state === 'ready'
      && !set.loadingMore
      && (set.loadedCount > set.page * this.pageSize || set.hasMore);
  }

  get canExport(): boolean {
    return this.active.state === 'ready' && this.active.loadedCount > 0 && !this.isExporting;
  }

  selectTab(tab: RecordsTab): void {
    this.activeTab = tab;
    this.loadActiveIfNeeded();
    this.cdr.markForCheck();
  }

  onSearch(): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      const query = this.searchQuery.trim();
      if (query === this.appliedQuery) return;
      this.appliedQuery = query;
      this.applyFilters();
    }, SEARCH_DEBOUNCE_MS);
  }

  clearSearch(): void {
    clearTimeout(this.searchTimer);
    this.searchQuery = '';
    if (this.appliedQuery === '') return;
    this.appliedQuery = '';
    this.applyFilters();
  }

  onRoomChange(value: string): void {
    if (value === this.roomFilter || !this.roomOptions.some((option) => option.value === value)) return;
    this.roomFilter = value;
    this.applyFilters();
  }

  onPresetChange(value: string): void {
    const option = this.presetOptions.find((candidate) => candidate.value === value);
    if (!option) return;

    this.preset = option.value as RecordDatePreset;
    // "Custom range" keeps whatever days are already selected as the starting point.
    if (this.preset === 'custom') {
      this.cdr.markForCheck();
      return;
    }
    const range = resolveRecordPresetRange(this.preset);
    this.setDates(range.startDate, range.endDate);
  }

  onStartDateChange(value: string): void {
    this.preset = 'custom';
    this.setDates(value, this.endDate);
  }

  onEndDateChange(value: string): void {
    this.preset = 'custom';
    this.setDates(this.startDate, value);
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
    if (!this.canGoPrevious) return;
    if (this.activeTab === 'occupancy') this.showPage(this.occupancy, this.occupancy.page - 1);
    else this.showPage(this.overrides, this.overrides.page - 1);
    this.cdr.markForCheck();
  }

  /** Shows the next loaded page, reading older records from the server first when needed. */
  nextPage(): void {
    if (!this.canGoNext) return;
    if (this.activeTab === 'occupancy') void this.advance(this.occupancy);
    else void this.advance(this.overrides);
  }

  retry(): void {
    if (this.activeTab === 'occupancy') void this.load(this.occupancy);
    else void this.load(this.overrides);
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

  exportPdf(): void {
    if (!this.canExport) return;
    if (this.activeTab === 'occupancy') void this.export(this.occupancy);
    else void this.export(this.overrides);
  }

  private createRecordSet<TRecord extends PagedRecord, TRow extends RecordRowBase>(
    config: RecordSetConfig<TRecord, TRow>
  ): RecordSet<TRecord, TRow> {
    const set: RecordSet<TRecord, TRow> = {
      ...config,
      pager: new RecordsPager<TRecord>(config.source, {
        pageSize: RECORDS_PAGE_SIZE,
        filteredChunkSize: SEARCH_CHUNK_SIZE,
        scanBudget: SEARCH_SCAN_BUDGET,
        onLiveRecords: () => {
          // New rows go on top; the reader stays on the page they were viewing.
          this.showPage(set, set.page);
          this.cdr.markForCheck();
        },
      }),
      state: 'idle',
      loadingMore: false,
      page: 1,
      loadedCount: 0,
      hasMore: false,
      scanned: 0,
      loadToken: 0,
      stale: false,
      pageRows: [],
    };
    return set;
  }

  /** Rebuilds room names and, when the set of devices changed, reloads the records. */
  private syncRooms(): void {
    if (!this.roomsLoaded) return;

    const signature = this.rooms
      .map((room) =>
        [room.uid, room.roomName, room.device, room.deleted === true, room.deletedDevice ?? ''].join('|'))
      .join('\n');
    if (signature === this.roomsSignature) return;
    this.roomsSignature = signature;

    const deviceIds = recordDeviceIds(this.rooms);
    const devicesChanged = deviceIds.join('\n') !== this.deviceIds.join('\n');

    this.roomLookup = buildRecordRoomLookup(this.rooms);
    this.roomOptions = buildRecordRoomOptions(this.rooms);
    this.deviceIds = deviceIds;
    this.hasDevices = deviceIds.length > 0;
    if (!this.roomOptions.some((option) => option.value === this.roomFilter)) {
      this.roomFilter = ALL_ROOMS;
    }

    if (devicesChanged || this.active.state === 'idle') {
      this.applyFilters();
    } else {
      // Only names changed: relabel the rows already on screen.
      this.showPage(this.occupancy, this.occupancy.page);
      this.showPage(this.overrides, this.overrides.page);
      this.cdr.markForCheck();
    }
  }

  private setDates(startDate: string, endDate: string): void {
    if (startDate === this.startDate && endDate === this.endDate) {
      this.cdr.markForCheck();
      return;
    }
    this.startDate = startDate;
    this.endDate = endDate;
    this.applyFilters();
  }

  /** Filters changed: the visible tab reloads now, the hidden one when it is next shown. */
  private applyFilters(): void {
    this.invalidate(this.occupancy);
    this.invalidate(this.overrides);
    this.loadActiveIfNeeded();
    this.cdr.markForCheck();
  }

  private loadActiveIfNeeded(): void {
    if (!this.roomsLoaded) return;
    if (this.activeTab === 'occupancy') {
      if (this.occupancy.stale || this.occupancy.state === 'idle') void this.load(this.occupancy);
    } else if (this.overrides.stale || this.overrides.state === 'idle') {
      void this.load(this.overrides);
    }
  }

  /** Drops a set's rows and live tails; it reloads the next time its tab is shown. */
  private invalidate<TRecord extends PagedRecord, TRow extends RecordRowBase>(
    set: RecordSet<TRecord, TRow>
  ): void {
    set.loadToken++;
    set.stale = true;
    set.state = 'idle';
    set.loadingMore = false;
    set.pager.start({ deviceIds: [] });
    this.showPage(set, 1);
  }

  private buildQuery<TRecord extends PagedRecord, TRow extends RecordRowBase>(
    set: RecordSet<TRecord, TRow>
  ): RecordsPagerQuery<TRecord> {
    const range = this.dateRange;
    if (!isRecordDateRangeValid(range)) return { deviceIds: [] };

    const needle = this.appliedQuery.toLowerCase();
    return {
      deviceIds: this.roomFilter === ALL_ROOMS ? this.deviceIds : [this.roomFilter],
      keyRange: recordKeyRange(range),
      matches: needle
        ? (record) => set.searchText(set.toRow(record, this.roomLookup)).toLowerCase().includes(needle)
        : undefined,
      live: isRecordRangeOpenEnded(range),
    };
  }

  /** Starts the current filters from the first page. */
  private async load<TRecord extends PagedRecord, TRow extends RecordRowBase>(
    set: RecordSet<TRecord, TRow>
  ): Promise<void> {
    const token = ++set.loadToken;
    set.stale = false;
    set.state = 'loading';
    set.loadingMore = false;
    set.pager.start(this.buildQuery(set));
    this.showPage(set, 1);
    this.cdr.markForCheck();

    try {
      await set.pager.loadMore();
    } catch {
      // Already reported by DeviceRecordsService; the table shows a retry state.
      if (token !== set.loadToken) return;
      set.state = 'failed';
      this.cdr.markForCheck();
      return;
    }

    if (token !== set.loadToken) return;
    set.state = 'ready';
    this.showPage(set, 1);
    this.cdr.markForCheck();
  }

  private async advance<TRecord extends PagedRecord, TRow extends RecordRowBase>(
    set: RecordSet<TRecord, TRow>
  ): Promise<void> {
    const shownThrough = set.page * this.pageSize;

    if (set.pager.loaded.length <= shownThrough && set.pager.hasMore) {
      const token = set.loadToken;
      set.loadingMore = true;
      this.cdr.markForCheck();

      try {
        await set.pager.loadMore();
      } catch {
        if (token !== set.loadToken) return;
        this.snackBar.error('Couldn\'t load older records', 'Check your connection and try again.');
      }

      if (token !== set.loadToken) return;
      set.loadingMore = false;
    }

    const hasNextPage = set.pager.loaded.length > shownThrough;
    this.showPage(set, hasNextPage ? set.page + 1 : set.page);
    this.cdr.markForCheck();
  }

  /** Maps the requested page of loaded records to table rows and refreshes the counters. */
  private showPage<TRecord extends PagedRecord, TRow extends RecordRowBase>(
    set: RecordSet<TRecord, TRow>,
    page: number
  ): void {
    const loaded = set.pager.loaded;
    const lastPage = Math.max(1, Math.ceil(loaded.length / this.pageSize));

    set.page = Math.min(Math.max(1, page), lastPage);
    set.loadedCount = loaded.length;
    set.hasMore = set.pager.hasMore;
    set.scanned = set.pager.scanned;

    const start = (set.page - 1) * this.pageSize;
    set.pageRows = loaded
      .slice(start, start + this.pageSize)
      .map((record) => set.toRow(record, this.roomLookup));
  }

  /** Exports every record matching the filters, not only the pages loaded on screen. */
  private async export<TRecord extends PagedRecord, TRow extends RecordRowBase>(
    set: RecordSet<TRecord, TRow>
  ): Promise<void> {
    const range = this.dateRange;
    const roomLabel = this.roomOptions.find((option) => option.value === this.roomFilter)?.label
      ?? 'All rooms';
    const query = this.buildQuery(set);

    this.isExporting = true;
    this.cdr.markForCheck();
    // The export reads the same devices; their live tails must not overlap those reads.
    set.pager.suspendLive();

    try {
      const { records, truncated } = await collectRecords(
        set.source, query, EXPORT_MAX_ROWS, EXPORT_CHUNK_SIZE
      );
      // Loaded on demand so jsPDF stays out of the initial bundle.
      const { PdfExportService } = await import('../../services/pdf-export.service');
      await this.injector.get(PdfExportService).generateRecordsReport({
        recordType: set.label,
        roomName: roomLabel,
        rangeLabel: formatRecordDateRange(range),
        head: [...set.pdfHead],
        body: records.map((record) => set.toPdfRow(set.toRow(record, this.roomLookup))),
        noWrapColumns: [...set.pdfNoWrapColumns],
        fileName: buildRecordsFileName(set.label, roomLabel, range),
      });
      if (truncated) {
        this.snackBar.warning(
          'Export shortened',
          `Only the newest ${EXPORT_MAX_ROWS.toLocaleString('en-US')} records were exported. Choose a shorter period or one room to get the rest.`
        );
      }
    } catch (err) {
      this.logger.error('Failed to export records PDF', err, {
        component: 'RecordsReport',
        action: 'exportPdf',
        recordType: set.label,
      });
      this.snackBar.error('Export failed', 'The PDF could not be created. Try again.');
    } finally {
      set.pager.resumeLive();
      this.isExporting = false;
      this.cdr.markForCheck();
    }
  }
}
