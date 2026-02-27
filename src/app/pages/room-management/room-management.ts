import { Component } from '@angular/core';
import { AddRoomModal } from '../../components/add-room-modal/add-room-modal'; 
import { CommonModule } from '@angular/common';
import { Room } from '../../models/room.model'; 

@Component({
  selector: 'app-room-management',
  standalone: true,
  imports: [CommonModule, AddRoomModal],
  templateUrl: './room-management.html',
})
export class RoomManagement {
  showAddModal = false;

  onRoomAdded(room: Room): void {

    console.log('New room added:', room);
  }
}