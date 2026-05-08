import { Room } from '../models/room.model';
import { DeviceTelemetry } from '../services/device.service';
import { mergeRoomsWithTelemetry } from './room-telemetry';

describe('mergeRoomsWithTelemetry', () => {
  it('prefers live device telemetry over stored room telemetry', () => {
    const rooms: Room[] = [
      {
        uid: 'room-1',
        roomName: 'Room 1',
        status: 'active',
        device: 'device-1',
        power: false,
        temperature: 30,
        humidity: 80,
        occupancy: false,
      },
    ];
    const devices: Record<string, DeviceTelemetry> = {
      'device-1': {
        temperature: 24.5,
        humidity: 55,
        occupancy: true,
        acState: {
          power: true,
        },
      },
    };

    const [merged] = mergeRoomsWithTelemetry(rooms, devices);

    expect(merged.temperature).toBe(24.5);
    expect(merged.humidity).toBe(55);
    expect(merged.occupancy).toBe(true);
    expect(merged.power).toBe(true);
  });
});
