import { Injectable } from '@angular/core';
import { Database, DatabaseReference, ref, get, push, set, onValue, update, query, orderByChild, equalTo, runTransaction } from '@angular/fire/database';
import { Room, Schedule } from '../models/room.model';
import { getRoomNameError, isRoomDeleted, toScheduleArray, validateSchedulesList } from '../helpers/room-validation';
import { DeviceService, OverrideActor } from './device.service';
import { LoggerService } from './logger.service';

export interface RoomFloorPlanAssignment {
  floorPlanCellId: string;
}

/** Who performed a room action; name/role are stored as a snapshot for audit display. */
export interface RoomActor extends OverrideActor {
  uid?: string | null;
}

export type RoomActionErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_DELETED'
  | 'ROOM_NOT_DELETED'
  | 'NAME_TAKEN'
  | 'INVALID_NAME'
  | 'DEVICE_UNAVAILABLE'
  | 'INVALID_SCHEDULES';

/** Expected, user-facing failure of a room action. `message` is safe to show in the UI. */
export class RoomActionError extends Error {
  constructor(readonly code: RoomActionErrorCode, message: string) {
    super(message);
    this.name = 'RoomActionError';
  }
}

export function isRoomActionError(err: unknown): err is RoomActionError {
  return err instanceof RoomActionError;
}

export interface RoomNameConflict {
  /** A non-deleted room already uses this name. */
  readonly activeConflict: boolean;
  /** Soft-deleted rooms with this name, most recently deleted first. */
  readonly deletedMatches: Room[];
}

export interface RestoreRoomInput {
  roomName: string;
  device: string;
  schedules: Schedule[];
  /** Cell to assign. When omitted, the room's previous cell is re-assigned if still free. */
  floorPlanCellId?: string;
}

type StoredRoom = Omit<Room, 'uid'> & Partial<Pick<Room, 'uid'>>;

@Injectable({
  providedIn: 'root'
})
export class RoomService {


  constructor(
    private db: Database,
    private logger: LoggerService,
    private deviceService: DeviceService,
  ) { }

  private sanitizePayload<T extends Record<string, any>>(obj: T): T {
    const sanitized = { ...obj };
    Object.keys(sanitized).forEach(key => {
      if (sanitized[key] === undefined) {
        delete sanitized[key];
      }
    });
    return sanitized;
  }

  private toRoomList(raw: Record<string, StoredRoom> | null | undefined): Room[] {
    return Object.entries(raw ?? {}).map(([uid, room]) => ({
      ...room,
      uid: room.uid ?? uid,
    })) as Room[];
  }

  private normalizeName(name: string): string {
    return name.toLowerCase().trim();
  }

  /** True when a non-deleted room (other than `excludeUid`) already uses `roomName`. */
  async checkRoomNameExists(roomName: string, excludeUid?: string): Promise<boolean> {
    const conflict = await this.findRoomNameConflict(roomName, excludeUid);
    return conflict.activeConflict;
  }

  async findRoomNameConflict(roomName: string, excludeUid?: string): Promise<RoomNameConflict> {
    try {
      const snapshot = await get(ref(this.db, 'rooms'));
      if (!snapshot.exists()) return { activeConflict: false, deletedMatches: [] };

      const normalizedName = this.normalizeName(roomName);
      const matches = this.toRoomList(snapshot.val()).filter((room) =>
        room.uid !== excludeUid &&
        typeof room.roomName === 'string' &&
        this.normalizeName(room.roomName) === normalizedName
      );

      return {
        activeConflict: matches.some((room) => !isRoomDeleted(room)),
        deletedMatches: matches
          .filter((room) => isRoomDeleted(room))
          .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')),
      };
    } catch (error) {
      this.logger.error('Database error checking room name', error, {
        service: 'RoomService',
        action: 'findRoomNameConflict',
        excludeUid,
      });
      throw error;
    }
  }

  async createRoom(room: Omit<Room, 'uid'>): Promise<Room> {
    try {
      const exists = await this.checkRoomNameExists(room.roomName);

      if (exists) {
        throw new Error('Room name already exists');
      }

      if (room.floorPlanCellId) {
        await this.assertFloorPlanCellAvailable(room.floorPlanCellId);
      }

      const roomsRef = ref(this.db, 'rooms');
      const newRef = push(roomsRef);

      const newRoom: Room = {
        ...room,
        uid: newRef.key!,
      };

      if (newRoom.floorPlanCellId && !newRoom.floorPlanAssignedAt) {
        newRoom.floorPlanAssignedAt = new Date().toISOString();
      }

      const safePayload = this.sanitizePayload(newRoom);
      await set(newRef, safePayload);

      return safePayload as Room;
    } catch (err: any) {

      if (err.message !== 'Room name already exists' && err.message !== 'Floorplan cell is already assigned') {
        this.logger.error('System error creating room', err, {
          service: 'RoomService',
          action: 'createRoom',
          floorPlanCellId: room.floorPlanCellId,
        });
      }
      throw err;
    }
  }

  async updateRoom(uid: string, roomUpdate: Partial<Omit<Room, 'uid'>>): Promise<void> {
    try {
      const roomRef = ref(this.db, `rooms/${uid}`);
      await this.assertRoomEditable(roomRef);

      if (roomUpdate.floorPlanCellId) {
        await this.assertFloorPlanCellAvailable(roomUpdate.floorPlanCellId, uid);
      }

      const safeUpdate = this.sanitizePayload(roomUpdate);
      await update(roomRef, safeUpdate);
    } catch (err: any) {
      if (!isRoomActionError(err) && err.message !== 'Floorplan cell is already assigned') {
        this.logger.error('System error updating room', err, {
          service: 'RoomService',
          action: 'updateRoom',
          uid,
          floorPlanCellId: roomUpdate.floorPlanCellId,
        });
      }
      throw err;
    }
  }

  async assignRoomToFloorPlan(uid: string, assignment: RoomFloorPlanAssignment): Promise<void> {
    try {
      const roomRef = ref(this.db, `rooms/${uid}`);
      await this.assertRoomEditable(roomRef);

      await this.assertFloorPlanCellAvailable(
        assignment.floorPlanCellId,
        uid
      );

      await update(roomRef, {
        floorPlanCellId: assignment.floorPlanCellId,
        floorPlanAssignedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      if (!isRoomActionError(err) && err.message !== 'Floorplan cell is already assigned') {
        this.logger.error('System error assigning room to floor plan', err, {
          service: 'RoomService',
          action: 'assignRoomToFloorPlan',
          uid,
          floorPlanCellId: assignment.floorPlanCellId,
        });
      }
      throw err;
    }
  }

  async unassignRoomFromFloorPlan(uid: string): Promise<void> {
    try {
      const roomRef = ref(this.db, `rooms/${uid}`);
      const snapshot = await get(roomRef);
      if (!snapshot.exists()) {
        throw new Error('Room not found');
      }

      await update(roomRef, {
        floorPlanCellId: null,
        floorPlanAssignedAt: null,
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      if (err.message !== 'Room not found') {
        this.logger.error('System error unassigning room', err, {
          service: 'RoomService',
          action: 'unassignRoomFromFloorPlan',
          uid,
        });
      }
      throw err;
    }
  }

  /**
   * Streams rooms. Soft-deleted rooms are excluded unless `includeDeleted` is set, so every
   * existing list (cards, floor plan, assign dropdowns) hides them by default.
   */
  streamRooms(
    callback: (rooms: Room[]) => void,
    onError?: (error: Error) => void,
    options: { includeDeleted?: boolean } = {}
  ): () => void {
    const roomsRef = ref(this.db, 'rooms');
    return onValue(roomsRef, (snapshot) => {
      if (!snapshot.exists()) {
        callback([]);
        return;
      }

      const rooms = this.toRoomList(snapshot.val());
      callback(options.includeDeleted ? rooms : rooms.filter((room) => !isRoomDeleted(room)));
    }, (error: Error) => {
      this.logger.error('Room stream failed', error, {
        service: 'RoomService',
        action: 'streamRooms',
      });
      onError?.(error);
    });
  }

  /** Includes soft-deleted rooms (with `deleted: true`) so a detail page can show their state. */
  streamRoomById(
    uid: string,
    callback: (room: Room | null) => void,
    onError?: (error: Error) => void
  ): () => void {
    const roomRef = ref(this.db, `rooms/${uid}`);
    return onValue(roomRef, (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }
      const rawRoom = snapshot.val() as StoredRoom;
      callback({
        ...rawRoom,
        uid: rawRoom.uid ?? uid,
      } as Room);
    }, (error: Error) => {
      this.logger.error('Room detail stream failed', error, {
        service: 'RoomService',
        action: 'streamRoomById',
        uid,
      });
      onError?.(error);
    });
  }

  streamRoomsByStatus(
    status: Room['status'],
    callback: (rooms: Room[]) => void,
    onError?: (error: Error) => void
  ): () => void {
    const roomsRef = ref(this.db, 'rooms');
    const q = query(roomsRef, orderByChild('status'), equalTo(status));
    return onValue(q, (snapshot) => {
      if (!snapshot.exists()) {
        callback([]);
        return;
      }
      callback(this.toRoomList(snapshot.val()).filter((room) => !isRoomDeleted(room)));
    }, (error: Error) => {
      this.logger.error('Room status stream failed', error, {
        service: 'RoomService',
        action: 'streamRoomsByStatus',
        status,
      });
      onError?.(error);
    });
  }

  /**
   * Soft-deletes a room: keeps the record (and therefore its energy history and name) but
   * detaches its device, archives its schedules and clears its floor plan cell, so nothing can
   * drive the AC from it. Afterwards, if the detached device's AC is running or under override,
   * a Forced Off is sent. The room write happens first so a failed delete never leaves a live
   * room's AC forced off. Already-deleted rooms are a no-op.
   */
  async softDeleteRoom(uid: string, actor: RoomActor = {}): Promise<{ acOffFailed: boolean }> {
    const roomRef = ref(this.db, `rooms/${uid}`);
    let detachedDevice = '';

    try {
      const result = await runTransaction(roomRef, (current: StoredRoom | null) => {
        // RTDB first runs transactions against the local cache, which may be empty; passing
        // null through lets the server re-run this with the real value. Never return
        // undefined here: that aborts the transaction.
        if (current === null) return null;
        if (current.deleted === true) return undefined;

        detachedDevice = typeof current.device === 'string' ? current.device.trim() : '';
        return this.buildSoftDeletedRoom(uid, current, actor);
      }, { applyLocally: false });

      if (result.committed && !result.snapshot.exists()) {
        throw new RoomActionError('ROOM_NOT_FOUND', 'This room no longer exists.');
      }
      if (!result.committed) {
        return { acOffFailed: false };
      }
    } catch (err) {
      if (!isRoomActionError(err)) {
        this.logger.error('System error deleting room', err, {
          service: 'RoomService',
          action: 'softDeleteRoom',
          uid,
        });
      }
      throw err;
    }

    if (!detachedDevice) return { acOffFailed: false };

    try {
      if (await this.deviceService.isAcActive(detachedDevice)) {
        await this.deviceService.sendForcedOff(detachedDevice, actor.uid ?? undefined, uid, actor);
      }
      return { acOffFailed: false };
    } catch (err) {
      this.logger.error('Room deleted but forced-off command failed', err, {
        service: 'RoomService',
        action: 'softDeleteRoom',
        uid,
        deviceId: detachedDevice,
      });
      return { acOffFailed: true };
    }
  }

  /**
   * Restores a soft-deleted room with a (possibly new) name, device and schedules. Returns
   * whether a floor plan cell was assigned (the requested one, or the room's previous one if it
   * is still free).
   */
  async restoreRoom(uid: string, input: RestoreRoomInput): Promise<{ room: Room; cellRestored: boolean }> {
    const roomRef = ref(this.db, `rooms/${uid}`);
    const roomName = input.roomName.trim();
    const device = input.device.trim();
    const schedules = toScheduleArray(input.schedules);

    try {
      const nameError = getRoomNameError(roomName);
      if (nameError) {
        throw new RoomActionError('INVALID_NAME', nameError);
      }
      if (schedules.length === 0) {
        throw new RoomActionError('INVALID_SCHEDULES', 'Add at least one schedule before restoring the room.');
      }
      const scheduleError = validateSchedulesList(schedules);
      if (scheduleError) {
        throw new RoomActionError('INVALID_SCHEDULES', scheduleError);
      }

      const snapshot = await get(roomRef);
      if (!snapshot.exists()) {
        throw new RoomActionError('ROOM_NOT_FOUND', 'This room no longer exists.');
      }
      const stored = snapshot.val() as StoredRoom;
      if (stored.deleted !== true) {
        throw new RoomActionError('ROOM_NOT_DELETED', 'This room has already been restored.');
      }

      if (await this.checkRoomNameExists(roomName, uid)) {
        throw new RoomActionError('NAME_TAKEN', `A room named "${roomName}" already exists. Choose a different name to restore this room.`);
      }

      const availableDevices = await this.deviceService.getAvailableDevices();
      if (!device || !availableDevices.includes(device)) {
        throw new RoomActionError('DEVICE_UNAVAILABLE', 'The selected device is no longer available. Choose another device.');
      }

      let cellId: string | null = null;
      if (input.floorPlanCellId) {
        await this.assertFloorPlanCellAvailable(input.floorPlanCellId, uid);
        cellId = input.floorPlanCellId;
      } else if (stored.deletedFloorPlanCellId) {
        try {
          await this.assertFloorPlanCellAvailable(stored.deletedFloorPlanCellId, uid);
          cellId = stored.deletedFloorPlanCellId;
        } catch {
          cellId = null;
        }
      }

      const now = new Date().toISOString();
      const result = await runTransaction(roomRef, (current: StoredRoom | null) => {
        if (current === null) return null;
        if (current.deleted !== true) return undefined;
        return this.buildRestoredRoom(uid, current, { roomName, device, schedules, cellId, now });
      }, { applyLocally: false });

      if (!result.committed) {
        throw new RoomActionError('ROOM_NOT_DELETED', 'This room was restored or changed by someone else. Refresh and try again.');
      }
      if (!result.snapshot.exists()) {
        throw new RoomActionError('ROOM_NOT_FOUND', 'This room no longer exists.');
      }

      const restored = result.snapshot.val() as StoredRoom;
      return { room: { ...restored, uid: restored.uid ?? uid } as Room, cellRestored: cellId !== null };
    } catch (err: any) {
      if (!isRoomActionError(err) && err?.message !== 'Floorplan cell is already assigned') {
        this.logger.error('System error restoring room', err, {
          service: 'RoomService',
          action: 'restoreRoom',
          uid,
        });
      }
      throw err;
    }
  }

  private buildSoftDeletedRoom(uid: string, current: StoredRoom, actor: RoomActor): StoredRoom {
    const now = new Date().toISOString();
    const {
      schedules,
      floorPlanCellId,
      floorPlanAssignedAt: _assignedAt,
      restoredAt: _restoredAt,
      pendingMlSuggestion: _pending,
      ...rest
    } = current;
    const device = typeof current.device === 'string' ? current.device.trim() : '';
    const archived = toScheduleArray(schedules);
    const actorName = actor.fullName?.trim();

    const deleted: StoredRoom = {
      ...rest,
      uid: current.uid ?? uid,
      createdAt: current.createdAt ?? current.updatedAt ?? now,
      roomName: current.roomName ?? '',
      device: '',
      status: 'inactive',
      deleted: true,
      deletedAt: now,
      updatedAt: now,
      ...(actor.uid ? { deletedBy: actor.uid } : {}),
      ...(actorName ? { deletedByName: actorName } : {}),
      ...(device ? { deletedDevice: device } : {}),
      ...(floorPlanCellId ? { deletedFloorPlanCellId: floorPlanCellId } : {}),
      ...(archived.length ? { archivedSchedules: archived } : {}),
    };
    return this.sanitizePayload(deleted);
  }

  private buildRestoredRoom(
    uid: string,
    current: StoredRoom,
    next: { roomName: string; device: string; schedules: Schedule[]; cellId: string | null; now: string }
  ): StoredRoom {
    const {
      deleted: _deleted,
      deletedAt: _deletedAt,
      deletedBy: _deletedBy,
      deletedByName: _deletedByName,
      deletedDevice: _deletedDevice,
      deletedFloorPlanCellId: _deletedCell,
      archivedSchedules: _archived,
      floorPlanCellId: _cell,
      floorPlanAssignedAt: _assignedAt,
      pendingMlSuggestion: _pending,
      ...rest
    } = current;

    const restored: StoredRoom = {
      ...rest,
      uid: current.uid ?? uid,
      createdAt: current.createdAt ?? current.updatedAt ?? next.now,
      roomName: next.roomName,
      device: next.device,
      schedules: next.schedules,
      status: 'active',
      restoredAt: next.now,
      updatedAt: next.now,
      ...(next.cellId ? { floorPlanCellId: next.cellId, floorPlanAssignedAt: next.now } : {}),
    };
    return this.sanitizePayload(restored);
  }

  /** Rejects writes to rooms that no longer exist or were soft-deleted (e.g. a stale open modal). */
  private async assertRoomEditable(roomRef: DatabaseReference): Promise<void> {
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) {
      throw new RoomActionError('ROOM_NOT_FOUND', 'This room no longer exists. Refresh to see the latest rooms.');
    }
    if (isRoomDeleted(snapshot.val())) {
      throw new RoomActionError('ROOM_DELETED', 'This room was deleted. Refresh to see the latest rooms.');
    }
  }

  private async assertFloorPlanCellAvailable(
    floorPlanCellId: string,
    excludeUid?: string
  ): Promise<void> {
    const roomsRef = ref(this.db, 'rooms');
    const snapshot = await get(roomsRef);
    if (!snapshot.exists()) return;

    const rooms = snapshot.val() as Record<string, Partial<Room>>;
    const assignedRoom = Object.entries(rooms).find(([uid, room]) => {
      if (excludeUid && uid === excludeUid) return false;
      return room.floorPlanCellId === floorPlanCellId;
    });

    if (assignedRoom) {
      throw new Error('Floorplan cell is already assigned');
    }
  }
}
