import { Injectable } from '@angular/core';
import { Database, ref, get, push, set, update } from '@angular/fire/database';
import { Room, Schedule } from '../models/room.model';

@Injectable({
  providedIn: 'root'
})
export class RoomService {
  constructor(private db: Database) {}

  async getDevices(): Promise<string[]> {
    const devicesRef = ref(this.db, 'devices');
    const snapshot = await get(devicesRef);
    if (!snapshot.exists()) return [];
    return Object.keys(snapshot.val());
  }

  async checkRoomNameExists(roomName: string): Promise<boolean> {
    const roomsRef = ref(this.db, 'rooms');
    const snapshot = await get(roomsRef);
    if (!snapshot.exists()) return false;
    
    const rooms = snapshot.val();
    const normalizedName = roomName.toLowerCase().trim();
    
    return Object.values(rooms).some((room: any) => 
      room.roomName.toLowerCase().trim() === normalizedName
    );
  }

  async createRoom(room: Omit<Room, 'uid'>): Promise<Room> {
    const roomsRef = ref(this.db, 'rooms');
    const newRef = push(roomsRef);
    const newRoom: Room = { ...room, uid: newRef.key! };
    await set(newRef, newRoom);
    return newRoom;
  }
}