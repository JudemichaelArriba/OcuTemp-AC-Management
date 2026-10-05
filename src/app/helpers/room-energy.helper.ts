import { EnergyDaily } from '../models/energy.model';
import { Room } from '../models/room.model';
import { isRoomDeleted } from './room-validation';

/**
 * Per-room energy attribution.
 *
 * The ESP stamps each `devices/{deviceId}/energyDaily/{date}` entry with the `roomUid` it was
 * serving that day. Grouping by that `roomUid` (instead of by each room's current `device`)
 * keeps a room's history with the room when a device is moved, and keeps showing the history
 * of inactive and soft-deleted rooms. Every entry lands in exactly one group, so per-room totals
 * always add up to the facility total.
 */

type EnergyByDevice = Record<string, Record<string, EnergyDaily>>;
export type EnergyByGroup = Record<string, Record<string, EnergyDaily>>;

export interface RoomEnergyIndex {
  /** Energy re-keyed by group (room uid, or an unassigned-device bucket). */
  readonly energy: EnergyByGroup;
  /** Device ids that contributed to each group, sorted. */
  readonly devices: Readonly<Record<string, readonly string[]>>;
}

export type EnergyRoomEntryKind = 'active' | 'inactive' | 'deleted' | 'removed' | 'unassigned';

export interface EnergyRoomEntry {
  /** Group key into the result of {@link groupEnergyByRoom}. */
  readonly key: string;
  readonly label: string;
  readonly deviceLabel: string;
  readonly kind: EnergyRoomEntryKind;
}

const UNASSIGNED_PREFIX = 'device:';
const MANILA_TZ = 'Asia/Manila';
const HISTORY_YEARS = 5;

function unassignedKey(deviceId: string): string {
  return `${UNASSIGNED_PREFIX}${deviceId}`;
}

function laterIso(a: string | undefined, b: string | undefined): string {
  if (!a) return b ?? '';
  if (!b) return a;
  return a > b ? a : b;
}

function mergeDaily(existing: EnergyDaily | undefined, next: EnergyDaily, roomUid: string): EnergyDaily {
  const incoming: EnergyDaily = {
    estimatedKwh: next.estimatedKwh ?? 0,
    estimatedWattsOn: next.estimatedWattsOn ?? 0,
    roomUid,
    runtimeSeconds: next.runtimeSeconds ?? 0,
    sessionCount: next.sessionCount ?? 0,
    updatedAt: next.updatedAt ?? '',
  };
  if (!existing) return incoming;
  return {
    estimatedKwh: existing.estimatedKwh + incoming.estimatedKwh,
    estimatedWattsOn: Math.max(existing.estimatedWattsOn, incoming.estimatedWattsOn),
    roomUid,
    runtimeSeconds: existing.runtimeSeconds + incoming.runtimeSeconds,
    sessionCount: existing.sessionCount + incoming.sessionCount,
    updatedAt: laterIso(existing.updatedAt, incoming.updatedAt),
  };
}

/**
 * Re-keys device-keyed energy by room. Key resolution per entry:
 * 1. the entry's own `roomUid`;
 * 2. legacy entries without one: the non-deleted room currently holding that device
 *    (today's attribution, so older data is shown exactly as before);
 * 3. otherwise an unassigned bucket for the device.
 * Entries that resolve to the same key and date (e.g. two devices serving one room on the
 * same day) are merged.
 */
export function groupEnergyByRoom(energyData: EnergyByDevice, rooms: readonly Room[]): RoomEnergyIndex {
  const roomByDevice = new Map<string, string>();
  for (const room of rooms) {
    if (isRoomDeleted(room)) continue;
    const device = room.device?.trim();
    if (device && !roomByDevice.has(device)) roomByDevice.set(device, room.uid);
  }

  const grouped: EnergyByGroup = {};
  const sources = new Map<string, Set<string>>();
  for (const [deviceId, days] of Object.entries(energyData ?? {})) {
    if (!days || typeof days !== 'object') continue;
    for (const [dateKey, entry] of Object.entries(days)) {
      if (!entry || typeof entry !== 'object') continue;
      const stamped = typeof entry.roomUid === 'string' ? entry.roomUid.trim() : '';
      const key = stamped || roomByDevice.get(deviceId) || unassignedKey(deviceId);
      const bucket = (grouped[key] ??= {});
      bucket[dateKey] = mergeDaily(bucket[dateKey], entry, stamped);
      if (!sources.has(key)) sources.set(key, new Set());
      sources.get(key)!.add(deviceId);
    }
  }

  const devices: Record<string, string[]> = {};
  for (const [key, ids] of sources) devices[key] = [...ids].sort();
  return { energy: grouped, devices };
}

function manilaDateKey(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: MANILA_TZ });
}

function hasRecentEnergy(days: Record<string, EnergyDaily> | undefined, sinceKey: string): boolean {
  if (!days) return false;
  return Object.entries(days).some(([dateKey, entry]) => dateKey >= sinceKey && (entry?.estimatedKwh ?? 0) > 0);
}

function shortDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: MANILA_TZ });
}

function shortKey(key: string): string {
  return key.replace(UNASSIGNED_PREFIX, '').slice(-4);
}

interface DraftEntry extends EnergyRoomEntry {
  readonly suffix: string;
}

/**
 * Builds the ordered list of rows/bars to show.
 * - `'active'` (dashboard): non-deleted active rooms only, in the given order.
 * - `'all'` (Energy Reports): active rooms always; inactive, deleted, removed (energy for a room
 *   record that no longer exists) and unassigned rows only when they used energy in the last
 *   five years. Order: active, inactive, deleted (newest first), removed, unassigned.
 * Labels are ASCII and guaranteed unique.
 */
export function buildEnergyRoomEntries(
  rooms: readonly Room[],
  index: RoomEnergyIndex,
  mode: 'active' | 'all',
  now: Date = new Date()
): EnergyRoomEntry[] {
  const grouped = index.energy;
  const active = rooms.filter((room) => !isRoomDeleted(room) && room.status === 'active');
  const activeEntries: DraftEntry[] = active.map((room) => ({
    key: room.uid,
    label: room.roomName,
    deviceLabel: room.device || '-',
    kind: 'active',
    suffix: shortKey(room.uid),
  }));
  if (mode === 'active') return finalizeLabels(activeEntries);

  const sinceKey = `${Number(manilaDateKey(now).slice(0, 4)) - (HISTORY_YEARS - 1)}-01-01`;
  const used = (key: string) => hasRecentEnergy(grouped[key], sinceKey);
  const knownUids = new Set(rooms.map((room) => room.uid));

  const inactiveEntries: DraftEntry[] = rooms
    .filter((room) => !isRoomDeleted(room) && room.status !== 'active' && used(room.uid))
    .map((room) => ({
      key: room.uid,
      label: `${room.roomName} (inactive)`,
      deviceLabel: room.device || '-',
      kind: 'inactive',
      suffix: shortKey(room.uid),
    }));

  const deletedEntries: DraftEntry[] = rooms
    .filter((room) => isRoomDeleted(room) && used(room.uid))
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
    .map((room) => ({
      key: room.uid,
      label: `${room.roomName} (deleted)`,
      deviceLabel: room.deletedDevice ? `${room.deletedDevice} (former)` : '-',
      kind: 'deleted',
      suffix: shortDate(room.deletedAt) || shortKey(room.uid),
    }));

  const removedEntries: DraftEntry[] = [];
  const unassignedEntries: DraftEntry[] = [];
  for (const key of Object.keys(grouped).sort()) {
    if (knownUids.has(key) || !used(key)) continue;
    if (key.startsWith(UNASSIGNED_PREFIX)) {
      const deviceId = key.slice(UNASSIGNED_PREFIX.length);
      unassignedEntries.push({ key, label: `Unassigned - ${deviceId}`, deviceLabel: deviceId, kind: 'unassigned', suffix: shortKey(key) });
    } else {
      const devices = index.devices[key] ?? [];
      removedEntries.push({
        key,
        label: devices.length ? `Removed room - ${devices.join('/')}` : 'Removed room',
        deviceLabel: devices.length ? devices.join(', ') : '-',
        kind: 'removed',
        suffix: shortKey(key),
      });
    }
  }

  return finalizeLabels([...activeEntries, ...inactiveEntries, ...deletedEntries, ...removedEntries, ...unassignedEntries]);
}

function finalizeLabels(entries: DraftEntry[]): EnergyRoomEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);

  const taken = new Set<string>();
  return entries.map(({ suffix, ...entry }) => {
    let label = (counts.get(entry.label) ?? 0) > 1 && suffix ? `${entry.label} - ${suffix}` : entry.label;
    let n = 2;
    while (taken.has(label)) label = `${entry.label} - ${suffix || n} (${n++})`;
    taken.add(label);
    return { ...entry, label };
  });
}
