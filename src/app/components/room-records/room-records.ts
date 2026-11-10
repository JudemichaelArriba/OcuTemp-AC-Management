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
import { DeviceRecord, OccupancyLogEntry, OverrideHistoryEntry } from '../../models/esp.model';
import { DeviceRecordsService } from '../../services/device-records.service';
import { LoggerService } from '../../services/logger.service';
import { SnackBarService } from '../../services/snack-bar.service';
import {
  RECORDS_PAGE_SIZE,
  RecordDateRange,
  buildRecordsFileName,
  filterRecordsByDateRange,
  formatRecordDateRange,
  hasRecordDateFilter,
  isRecordDateRangeValid,
  pageOfRecords,
  recordPageCount,
  sortRecordsNewestFirst,
  toOccupancyLogRows,
  toOverrideHistoryRows,
} from '../../helpers/device-records.helper';

export type RecordsTab = 'occupancy' | 'overrides';

interface RecordColumn {
  readonly label: string;
  /** Keeps the column on one line in the PDF (dates). */
  readonly noWrap?: boolean;
}

/** One table row; `cells` line up with the record set's `columns`. */
interface TableRow {
  readonly id: string;
  readonly cells: readonly string[];
}

/** What the template and the PDF export need from a record set, whatever its record type. */
interface RecordSetView {
  readonly label: string;
  readonly columns: readonly RecordColumn[];
  loading: boolean;
  failed: boolean;
  /** Rows matching the current date range, newest first. */
  rows: TableRow[];
  pageRows: TableRow[];
  page: number;
}

interface RecordSet<TRecord> extends RecordSetView {
  readonly timestampOf: (record: TRecord) => string | undefined;
  readonly toTableRows: (records: readonly TRecord[]) => TableRow[];
  /** Everything loaded for the device, newest first, before date filtering. */
  records: TRecord[];
}

function createRecordSet<TRecord>(
  config: Pick<RecordSet<TRecord>, 'label' | 'columns' | 'timestampOf' | 'toTableRows'>
): RecordSet<TRecord> {
  return { ...config, loading: false, failed: false, records: [], rows: [], pageRows: [], page: 1 };
}

/**
 * Read-only "Records" section for Room Details: the device's occupancy log and the room's
 * override history. Each set is read once (no live listener) and then filtered, counted,
 * paged and exported in the browser.
 */
@Component({
  selector: 'app-room-records',
  standalone: true,
  templateUrl: './room-records.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoomRecords implements OnChanges, OnDestroy {
  @Input({ required: true }) roomUid = '';
  @Input({ required: true }) roomName = '';
  /** The room's assigned device; empty when the room has none. */
  @Input() deviceId: string | null | undefined = '';

  readonly tabs: readonly { readonly id: RecordsTab; readonly label: string }[] = [
    { id: 'occupancy', label: 'Occupancy Log' },
    { id: 'overrides', label: 'Override History' },
  ];
  readonly skeletonRows = [1, 2, 3, 4, 5];

  activeTab: RecordsTab = 'occupancy';
  startDate = '';
  endDate = '';
  isExporting = false;

  private readonly occupancy = createRecordSet<DeviceRecord<OccupancyLogEntry>>({
    label: 'Occupancy Log',
    columns: [{ label: 'Date and time', noWrap: true }, { label: 'Detected by' }],
    timestampOf: (record) => record.timestamp,
    toTableRows: (records) => toOccupancyLogRows(records)
      .map((row) => ({ id: row.id, cells: [row.dateTime, row.detectedBy] })),
  });

  private readonly overrides = createRecordSet<DeviceRecord<OverrideHistoryEntry>>({
    label: 'Override History',
    columns: [
      { label: 'Date and time', noWrap: true },
      { label: 'User' },
      { label: 'Role' },
      { label: 'Action' },
      { label: 'Target temperature' },
      { label: 'Active until', noWrap: true },
    ],
    timestampOf: (record) => record.requestedAt,
    toTableRows: (records) => toOverrideHistoryRows(records).map((row) => ({
      id: row.id,
      cells: [row.dateTime, row.user, row.role, row.action, row.targetTemp, row.activeUntil],
    })),
  });

  /** Bumped on every (re)load and on destroy so late responses are ignored. */
  private loadVersion = 0;

  constructor(
    private recordsService: DeviceRecordsService,
    private logger: LoggerService,
    private snackBar: SnackBarService,
    private injector: Injector,
    private cdr: ChangeDetectorRef,
  ) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['deviceId'] || changes['roomUid']) this.reload();
  }

  ngOnDestroy(): void {
    this.loadVersion++;
  }

  get active(): RecordSetView {
    return this.activeTab === 'occupancy' ? this.occupancy : this.overrides;
  }

  get hasDevice(): boolean {
    return this.normalizedDeviceId !== '';
  }

  get dateRange(): RecordDateRange {
    return { startDate: this.startDate, endDate: this.endDate };
  }

  get isFiltered(): boolean {
    return hasRecordDateFilter(this.dateRange);
  }

  get isRangeValid(): boolean {
    return isRecordDateRangeValid(this.dateRange);
  }

  get totalCount(): number {
    return this.active.rows.length;
  }

  get countLabel(): string {
    return `${this.totalCount} ${this.totalCount === 1 ? 'record' : 'records'}`;
  }

  get pageCount(): number {
    return recordPageCount(this.totalCount);
  }

  get firstRowNumber(): number {
    return (this.active.page - 1) * RECORDS_PAGE_SIZE + 1;
  }

  get lastRowNumber(): number {
    return Math.min(this.active.page * RECORDS_PAGE_SIZE, this.totalCount);
  }

  get canExport(): boolean {
    const set = this.active;
    return this.hasDevice && !set.loading && !set.failed && set.rows.length > 0 && !this.isExporting;
  }

  selectTab(tab: RecordsTab): void {
    this.activeTab = tab;
    this.cdr.markForCheck();
  }

  onStartDateChange(value: string): void {
    this.startDate = value;
    this.applyDateRange();
  }

  onEndDateChange(value: string): void {
    this.endDate = value;
    this.applyDateRange();
  }

  clearDates(): void {
    this.startDate = '';
    this.endDate = '';
    this.applyDateRange();
  }

  previousPage(): void {
    this.goToPage(this.active.page - 1);
  }

  nextPage(): void {
    this.goToPage(this.active.page + 1);
  }

  /** Re-reads both record sets; they are snapshots, so this is how new entries appear. */
  refresh(): void {
    this.reload();
  }

  async exportPdf(): Promise<void> {
    if (!this.canExport) return;

    const tab = this.activeTab;
    const set = this.active;
    const range = this.dateRange;
    const body = set.rows.map((row) => [...row.cells]);

    this.isExporting = true;
    this.cdr.markForCheck();

    try {
      // Loaded on demand so jsPDF stays out of the initial bundle.
      const { PdfExportService } = await import('../../services/pdf-export.service');
      await this.injector.get(PdfExportService).generateRecordsReport({
        recordType: set.label,
        roomName: this.roomName,
        deviceId: this.normalizedDeviceId,
        rangeLabel: formatRecordDateRange(range),
        head: set.columns.map((column) => column.label),
        body,
        noWrapColumns: set.columns.flatMap((column, index) => (column.noWrap ? [index] : [])),
        fileName: buildRecordsFileName(set.label, this.roomName, range),
      });
    } catch (err) {
      this.logger.error('Failed to export room records PDF', err, {
        component: 'RoomRecords',
        action: 'exportPdf',
        tab,
        roomUid: this.roomUid,
      });
      this.snackBar.error('Export failed', 'Unable to create the PDF. Please try again.');
    } finally {
      this.isExporting = false;
      this.cdr.markForCheck();
    }
  }

  private get normalizedDeviceId(): string {
    return (this.deviceId ?? '').trim();
  }

  private reload(): void {
    const version = ++this.loadVersion;
    const deviceId = this.normalizedDeviceId;
    const roomUid = this.roomUid;

    if (!deviceId) {
      for (const set of [this.occupancy, this.overrides]) {
        set.loading = false;
        set.failed = false;
      }
      this.occupancy.records = [];
      this.overrides.records = [];
      this.applyDateRange();
      return;
    }

    void this.load(this.occupancy, version, () => this.recordsService.getOccupancyLog(deviceId));
    void this.load(this.overrides, version, () =>
      this.recordsService.getOverrideHistory(deviceId, roomUid));
  }

  private async load<TRecord extends { readonly id: string }>(
    set: RecordSet<TRecord>,
    version: number,
    fetch: () => Promise<TRecord[]>
  ): Promise<void> {
    set.loading = true;
    set.failed = false;
    this.cdr.markForCheck();

    let records: TRecord[] = [];
    let failed = false;
    try {
      records = sortRecordsNewestFirst(await fetch(), set.timestampOf);
    } catch {
      // Already reported by DeviceRecordsService; the panel shows a retry state.
      failed = true;
    }

    if (version !== this.loadVersion) return;

    set.records = records;
    set.failed = failed;
    set.loading = false;
    this.applyDateRangeTo(set);
    this.cdr.markForCheck();
  }

  private applyDateRange(): void {
    this.applyDateRangeTo(this.occupancy);
    this.applyDateRangeTo(this.overrides);
    this.cdr.markForCheck();
  }

  private applyDateRangeTo<TRecord>(set: RecordSet<TRecord>): void {
    const matching = filterRecordsByDateRange(set.records, set.timestampOf, this.dateRange);
    set.rows = set.toTableRows(matching);
    set.page = 1;
    set.pageRows = pageOfRecords(set.rows, 1);
  }

  private goToPage(page: number): void {
    const set = this.active;
    const target = Math.min(Math.max(1, page), this.pageCount);
    if (target === set.page) return;
    set.page = target;
    set.pageRows = pageOfRecords(set.rows, target);
    this.cdr.markForCheck();
  }
}
