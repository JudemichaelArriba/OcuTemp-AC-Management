import { Injectable } from '@angular/core';
import { Database, ref, get, push, set, onValue, update, remove, query, orderByChild, equalTo } from '@angular/fire/database';
import { Room, Schedule } from '../models/room.model';
// import {query, orderByChild, equalTo} from '@angular/fire/database';

export interface RoomFloorPlanAssignment {
  floorPlanId: string;
  floorPlanCellId: string;
}

@Injectable({
  providedIn: 'root'
})
export class RoomService {
  constructor(private db: Database) { }

  async checkRoomNameExists(roomName: string, excludeUid?: string): Promise<boolean> {
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
  }

  async createRoom(room: Omit<Room, 'uid'>): Promise<Room> {
    const exists = await this.checkRoomNameExists(room.roomName);

    if (exists) {
      throw new Error('Room name already exists');
    }

    if (room.floorPlanId && room.floorPlanCellId) {
      await this.assertFloorPlanCellAvailable(room.floorPlanId, room.floorPlanCellId);
    }

    const roomsRef = ref(this.db, 'rooms');
    const newRef = push(roomsRef);
    const newRoom: Room = {
      ...room,
      floorPlanAssignedAt: room.floorPlanId && room.floorPlanCellId
        ? room.floorPlanAssignedAt ?? new Date().toISOString()
        : room.floorPlanAssignedAt,
      uid: newRef.key!,
    };
    await set(newRef, newRoom);
    return newRoom;
  }

  async updateRoom(uid: string, roomUpdate: Partial<Omit<Room, 'uid'>>): Promise<void> {
    if (roomUpdate.floorPlanId && roomUpdate.floorPlanCellId) {
      await this.assertFloorPlanCellAvailable(roomUpdate.floorPlanId, roomUpdate.floorPlanCellId, uid);
    }

    const roomRef = ref(this.db, `rooms/${uid}`);
    await update(roomRef, roomUpdate);
  }

  async assignRoomToFloorPlan(uid: string, assignment: RoomFloorPlanAssignment): Promise<void> {
    const roomRef = ref(this.db, `rooms/${uid}`);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) {
      throw new Error('Room not found');
    }

    await this.assertFloorPlanCellAvailable(
      assignment.floorPlanId,
      assignment.floorPlanCellId,
      uid
    );

    await update(roomRef, {
      floorPlanId: assignment.floorPlanId,
      floorPlanCellId: assignment.floorPlanCellId,
      floorPlanAssignedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async unassignRoomFromFloorPlan(uid: string): Promise<void> {
    const roomRef = ref(this.db, `rooms/${uid}`);
    const snapshot = await get(roomRef);
    if (!snapshot.exists()) {
      throw new Error('Room not found');
    }

    await update(roomRef, {
      floorPlanId: null,
      floorPlanCellId: null,
      floorPlanAssignedAt: null,
      updatedAt: new Date().toISOString(),
    });
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
    const roomRef = ref(this.db, `rooms/${uid}`);
    await remove(roomRef);
  }

  private async assertFloorPlanCellAvailable(
    floorPlanId: string,
    floorPlanCellId: string,
    excludeUid?: string
  ): Promise<void> {
    const roomsRef = ref(this.db, 'rooms');
    const snapshot = await get(roomsRef);
    if (!snapshot.exists()) return;

    const rooms = snapshot.val() as Record<string, Partial<Room>>;
    const assignedRoom = Object.entries(rooms).find(([uid, room]) => {
      if (excludeUid && uid === excludeUid) return false;
      return (
        room.floorPlanId === floorPlanId &&
        room.floorPlanCellId === floorPlanCellId
      );
    });

    if (assignedRoom) {
      throw new Error('Floorplan cell is already assigned');
    }
  }
}
