import { Injectable } from '@angular/core';
import {
  Database, ref, query,
  orderByChild, limitToLast,
  endBefore, onValue, off, get, update
} from '@angular/fire/database';
import { DecisionLog } from '../models/logs.model';

const PAGE_SIZE = 25;

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


  async fetchPage(cursor: LogCursor | null): Promise<LogPage> {
    const logsRef = ref(this.db, 'decisionLogs');
    const q = cursor
      ? query(
        logsRef,
        orderByChild('updatedAt'),
        endBefore(cursor.updatedAt, cursor.key),
        limitToLast(PAGE_SIZE + 1),
      )
      : query(
        logsRef,
        orderByChild('updatedAt'),
        limitToLast(PAGE_SIZE + 1),
      );

    const snapshot = await get(q);
    const logs: DecisionLog[] = [];
    snapshot.forEach((child) => {
      if (child.key) logs.push({ id: child.key, ...child.val() } as DecisionLog);
    });
    logs.reverse();

    const hasMore = logs.length > PAGE_SIZE;
    const pageLogs = hasMore ? logs.slice(0, PAGE_SIZE) : logs;
    const oldest = pageLogs.at(-1);
    const nextCursor: LogCursor | null = oldest
      ? { updatedAt: oldest.updatedAt, key: oldest.id }
      : null;

    return { logs: pageLogs, hasMore, nextCursor };
  }

  async markAsRead(logId: string): Promise<void> {
    await update(ref(this.db, `decisionLogs/${logId}`), { read: true });
  }
}
