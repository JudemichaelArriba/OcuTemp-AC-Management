import { Device } from '../models/esp.model';
import { Room } from '../models/room.model';
import { MlSuggestionService } from './ml-suggestion.service';

describe('MlSuggestionService', () => {
  const service = new MlSuggestionService();
  const now = new Date('2026-05-10T12:00:00+08:00');
  const room: Room = {
    uid: 'room-1',
    roomName: 'Room 1',
    status: 'active',
    device: 'ESP32-1',
  };

  function device(overrides: Partial<Device> = {}): Device {
    return {
      uid: 'ESP32-1',
      temperature: 30,
      humidity: 80,
      control: {
        aiAutoApply: false,
        targetTemp: 17,
      },
      mlSuggestion: {
        applied: false,
        roomUid: room.uid,
        suggestedTemp: 18,
        updatedAt: '2026-05-10T09:30:00',
      },
      ...overrides,
    };
  }

  it('shows today pending suggestions when AI auto-apply is off', () => {
    const result = service.getPendingRoomSuggestion(room, device(), now);

    expect(result).toEqual(expect.objectContaining({
      deviceId: 'ESP32-1',
      roomUid: 'room-1',
      suggestedTemp: 18,
      currentRoomTemp: 30,
      targetTemp: 17,
      humidity: 80,
    }));
  });

  it('hides yesterday suggestions', () => {
    const result = service.getPendingRoomSuggestion(
      room,
      device({ mlSuggestion: { roomUid: room.uid, suggestedTemp: 18, updatedAt: '2026-05-09T23:59:00' } }),
      now
    );

    expect(result).toBeUndefined();
  });

  it('hides suggestions when AI auto-apply is enabled', () => {
    const result = service.getPendingRoomSuggestion(
      room,
      device({ control: { aiAutoApply: true } }),
      now
    );

    expect(result).toBeUndefined();
  });

  it('hides applied suggestions', () => {
    const result = service.getPendingRoomSuggestion(
      room,
      device({ mlSuggestion: { applied: true, roomUid: room.uid, suggestedTemp: 18, updatedAt: '2026-05-10T09:30:00' } }),
      now
    );

    expect(result).toBeUndefined();
  });

  it('hides suggestions for another room', () => {
    const result = service.getPendingRoomSuggestion(
      room,
      device({ mlSuggestion: { roomUid: 'room-2', suggestedTemp: 18, updatedAt: '2026-05-10T09:30:00' } }),
      now
    );

    expect(result).toBeUndefined();
  });
});
