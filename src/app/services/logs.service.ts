import { Injectable } from '@angular/core';
import {
  Database, ref, query, QueryConstraint,
  orderByKey, limitToLast,
  startAt, endAt, onValue, get, update
} from '@angular/fire/database';
import { DecisionLog } from '../models/logs.model';
import { LogDateRange, keyRangeForDateRange } from '../helpers/log-date-filter.helper';
import { LoggerService } from './logger.service';

const PAGE_SIZE = 25;

export interface LogCursor {
  /** RTDB push key of the oldest row already shown. */
  key: string;
}

export interface LogPage {
  logs: DecisionLog[];
  hasMore: boolean;
  nextCursor: LogCursor | null;
}

@Injectable({ providedIn: 'root' })
export class LogService {

  constructor(private db: Database, private logger: LoggerService) { }

  streamLatest(
    limit: number,
    callback: (logs: DecisionLog[]) => void,
    onError?: (error: Error) => void
  ): () => void {
    const q = query(
      ref(this.db, 'decisionLogs'),
      orderByKey(),
      limitToLast(limit)
    );
    return onValue(q, (snapshot) => {
      const logs: DecisionLog[] = [];
      snapshot.forEach((child) => {
        if (child.key) logs.push({ id: child.key, ...child.val() } as DecisionLog);
      });
      callback(logs.reverse());
    }, (error: Error) => {
      this.logger.error('Decision log stream failed', error, {
        service: 'LogService',
        action: 'streamLatest',
        limit,
      });
      onError?.(error);
    });
  }

  /**
   * Pages `decisionLogs` newest-first by push key. Push-ID order is chronological,
   * unique (no tie ambiguity), and needs no `.indexOn` — unlike `orderByChild('updatedAt')`,
   * whose values are coarse (minute-precision, many ties) and index-dependent.
   * A `range` is applied as push-key prefix bounds (see {@link keyRangeForDateRange}).
   *
   * RTDB's `endBefore(key) + limitToLast(N)` combo is confirmed (live, against real data)
   * to under-count by one — it returns N-1 results instead of N. `endAt(key) + limitToLast`
   * does not have this bug, so the cursor is anchored with `endAt` and the cursor row
   * itself (already shown on the previous page) is dropped from the result below.
   */
  async fetchPage(cursor: LogCursor | null, range?: LogDateRange): Promise<LogPage> {
    try {
      const { startKey, endKey } = range ? keyRangeForDateRange(range) : {};
      const constraints: QueryConstraint[] = [orderByKey()];

      if (startKey) constraints.push(startAt(startKey));

      const excludeKey = cursor?.key;
      if (excludeKey) {
        constraints.push(endAt(excludeKey));
      } else if (endKey) {
        constraints.push(endAt(endKey));
      }

      constraints.push(limitToLast(excludeKey ? PAGE_SIZE + 2 : PAGE_SIZE + 1));

      const snapshot = await get(query(ref(this.db, 'decisionLogs'), ...constraints));

      const logs: DecisionLog[] = [];
      snapshot.forEach((child) => {
        if (child.key && child.key !== excludeKey) logs.push({ id: child.key, ...child.val() } as DecisionLog);
      });
      logs.reverse();

      const hasMore = logs.length > PAGE_SIZE;
      const pageLogs = hasMore ? logs.slice(0, PAGE_SIZE) : logs;
      const oldest = pageLogs.at(-1);
      const nextCursor: LogCursor | null = oldest ? { key: oldest.id } : null;

      return { logs: pageLogs, hasMore, nextCursor };
    } catch (err) {
      this.logger.error('Failed to fetch decision log page', err, {
        service: 'LogService',
        action: 'fetchPage',
        hasCursor: cursor !== null,
        hasRange: !!(range?.start || range?.end),
      });
      throw err;
    }
  }

  async markAsRead(logId: string): Promise<void> {
    await update(ref(this.db, `decisionLogs/${logId}`), { read: true });
  }
}
