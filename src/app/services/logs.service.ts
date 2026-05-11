import { Injectable } from '@angular/core';
import {
  Database, ref, query,
  orderByChild, limitToLast,
  startAt, endAt, endBefore, startAfter,
  onValue, off, get
} from '@angular/fire/database';
import { DecisionLog } from '../models/logs.model';

const PAGE_SIZE = 25;
const LAST_VIEWED_KEY = 'ocutemp_logs_last_viewed';

export interface LogCursor {
  updatedAt: string;
  key: string;
}

export interface LogPage {
  logs: DecisionLog[];
  hasMore: boolean;
  nextCursor: LogCursor | null;
}

@Injectable({ providedIn: 'root' })
export class LogService {

  constructor(private db: Database) { }


  streamLatest(limit: number, callback: (logs: DecisionLog[]) => void): () => void {
    const q = query(
      ref(this.db, 'decisionLogs'),
      orderByChild('updatedAt'),
      limitToLast(limit)
    );
    const handler = onValue(q, (snapshot) => {
      const logs: DecisionLog[] = [];
      snapshot.forEach((child) => {
        if (child.key) logs.push({ id: child.key, ...child.val() } as DecisionLog);
      });
      callback(logs.reverse());
    });
    return () => off(q, 'value', handler);
  }


  async fetchPage(cursor: LogCursor | null, dateFilter?: string): Promise<LogPage> {
    const logsRef = ref(this.db, 'decisionLogs');
    let q;

    if (dateFilter) {
      const dayStart = `${dateFilter}T00:00:00`;
      const dayEnd = `${dateFilter}T23:59:59`;
      q = cursor
        ? query(logsRef, orderByChild('updatedAt'),
          startAt(dayStart), endBefore(cursor.updatedAt, cursor.key),
          limitToLast(PAGE_SIZE))
        : query(logsRef, orderByChild('updatedAt'),
          startAt(dayStart), endAt(dayEnd),
          limitToLast(PAGE_SIZE));
    } else {
      q = cursor
        ? query(logsRef, orderByChild('updatedAt'),
          endBefore(cursor.updatedAt, cursor.key),
          limitToLast(PAGE_SIZE))
        : query(logsRef, orderByChild('updatedAt'),
          limitToLast(PAGE_SIZE));
    }

    const snapshot = await get(q);
    const logs: DecisionLog[] = [];
    snapshot.forEach((child) => {
      if (child.key) logs.push({ id: child.key, ...child.val() } as DecisionLog);
    });
    logs.reverse();

    const oldest = logs.at(-1);
    const nextCursor: LogCursor | null = oldest
      ? { updatedAt: oldest.updatedAt, key: oldest.id }
      : null;

    return { logs, hasMore: logs.length === PAGE_SIZE, nextCursor };
  }

  async fetchAvailableDates(): Promise<string[]> {
    const q = query(
      ref(this.db, 'decisionLogs'),
      orderByChild('updatedAt'),
      limitToLast(500)
    );
    const snapshot = await get(q);
    const dates = new Set<string>();
    snapshot.forEach((child) => {
      const v: string = child.val()?.updatedAt;
      if (v) dates.add(v.slice(0, 10));
    });
    return [...dates].sort((a, b) => b.localeCompare(a));
  }



  getLastViewedAt(): Date | null {
    const stored = localStorage.getItem(LAST_VIEWED_KEY);
    return stored ? new Date(stored) : null;
  }

  markAllViewed(): void {
    localStorage.setItem(LAST_VIEWED_KEY, new Date().toISOString());
  }

  isUnread(log: DecisionLog, lastViewed: Date | null): boolean {
    if (!lastViewed) return true;
    return new Date(log.updatedAt) > lastViewed;
  }


  async fetchUnreadCount(lastViewed: Date | null): Promise<number> {
    const q = lastViewed
      ? query(ref(this.db, 'decisionLogs'), orderByChild('updatedAt'),
        startAfter(lastViewed.toISOString()))
      : query(ref(this.db, 'decisionLogs'), orderByChild('updatedAt'),
        limitToLast(99));

    const snapshot = await get(q);


    let count = 0;
    snapshot.forEach(() => { count++; });
    return count;
  }
}