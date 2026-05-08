import { Injectable } from '@angular/core';
import { Database, ref, get, push, set, onValue, update, remove, query, orderByChild, equalTo } from '@angular/fire/database';
import { Room, Schedule } from '../models/room.model';
import { LoggerService } from './logger.service';

export interface RoomFloorPlanAssignment {
  floorPlanCellId: string;
}

@Injectable({
  providedIn: 'root'
})
export class RoomService {


  constructor(private db: Database, private logger: LoggerService) { }

  private sanitizePayload<T extends Record<string, any>>(obj: T): T {
    const sanitized = { ...obj };
    Object.keys(sanitized).forEach(key => {
      if (sanitized[key] === undefined) {
        delete sanitized[key];
      }
    });
    return sanitized;
  }

  async checkRoomNameExists(roomName: string, excludeUid?: string): Promise<boolean> {
    try {
      const roomsRef = ref(this.db, 'rooms');
      const snapshot = await get(roomsRef);
      if (!snapshot.exists()) return false;

      const rooms = snapshot.val();
      const normalizedName = roomName.toLowerCase().trim();

      return Object.entries(rooms).some(([uid, room]: [string, any]) => {
        if (excludeUid && uid === excludeUid) return false;
        if (!room?.roomName) return false;
        return room.roomName.toLowerCase().trim() === normalizedName;
      });
    } catch (error) {
      this.logger.error('Database error checking room name:', error);
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
        this.logger.error('System error creating room:', err);
      }
      throw err;
    }
  }

  async updateRoom(uid: string, roomUpdate: Partial<Omit<Room, 'uid'>>): Promise<void> {
    try {
      if (roomUpdate.floorPlanCellId) {
        await this.assertFloorPlanCellAvailable(roomUpdate.floorPlanCellId, uid);
      }

      const roomRef = ref(this.db, `rooms/${uid}`);
      const safeUpdate = this.sanitizePayload(roomUpdate);
      await update(roomRef, safeUpdate);
    } catch (err: any) {
      if (err.message !== 'Floorplan cell is already assigned') {
        this.logger.error(`System error updating room ${uid}:`, err);
      }
      throw err;
    }
  }

  async assignRoomToFloorPlan(uid: string, assignment: RoomFloorPlanAssignment): Promise<void> {
    try {
      const roomRef = ref(this.db, `rooms/${uid}`);
      const snapshot = await get(roomRef);
      if (!snapshot.exists()) {
        throw new Error('Room not found');
      }

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
      if (err.message !== 'Room not found' && err.message !== 'Floorplan cell is already assigned') {
        this.logger.error(`System error assigning room ${uid} to floor plan:`, err);
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
        this.logger.error(`System error unassigning room ${uid}:`, err);
      }
      throw err;
    }
  }


  streamRooms(callback: (rooms: Room[]) => void): () => void {
    const roomsRef = ref(this.db, 'rooms');
    return onValue(roomsRef, (snapshot) => {
      if (!snapshot.exists()) {
        callback([]);
        return;
      }

      const rawRooms = snapshot.val() as Record<string, Omit<Room, 'uid'> & Partial<Pick<Room, 'uid'>>>;
      const rooms = Object.entries(rawRooms).map(([uid, room]) => ({
        ...room,
        uid: room.uid ?? uid,
      })) as Room[];

      callback(rooms);
    });
  }

  streamRoomById(uid: string, callback: (room: Room | null) => void): () => void {
    const roomRef = ref(this.db, `rooms/${uid}`);
    return onValue(roomRef, (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }
      const rawRoom = snapshot.val() as Omit<Room, 'uid'> & Partial<Pick<Room, 'uid'>>;
      callback({
        ...rawRoom,
        uid: rawRoom.uid ?? uid,
      } as Room);
    });
  }

  streamRoomsByStatus(status: Room['status'], callback: (rooms: Room[]) => void): () => void {
    const roomsRef = ref(this.db, 'rooms');
    const q = query(roomsRef, orderByChild('status'), equalTo(status));
    return onValue(q, (snapshot) => {
      if (!snapshot.exists()) {
        callback([]);
        return;
      }
      const rawRooms = snapshot.val() as Record<string, Omit<Room, 'uid'> & Partial<Pick<Room, 'uid'>>>;
      const rooms = Object.entries(rawRooms).map(([uid, room]) => ({
        ...room,
        uid: room.uid ?? uid,
      })) as Room[];
      callback(rooms);
    });
  }

  async deleteRoom(uid: string): Promise<void> {
    try {
      const roomRef = ref(this.db, `rooms/${uid}`);
      await remove(roomRef);
    } catch (err) {
      this.logger.error(`System error deleting room ${uid}:`, err);
      throw err;
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