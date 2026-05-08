import { getFloorPlanRoomState, getHeatIndexCondition } from './floor-plan-state';
import { Room } from '../models/room.model';

describe('floor-plan-state', () => {
  it('maps heat index thresholds to the configured conditions', () => {
    expect(getHeatIndexCondition(25.9)).toBe('COMFORTABLE');
    expect(getHeatIndexCondition(26)).toBe('SLIGHTLY WARM');
    expect(getHeatIndexCondition(30)).toBe('WARM');
    expect(getHeatIndexCondition(34)).toBe('HOT');
    expect(getHeatIndexCondition(38)).toBe('VERY HOT / HIGH HUMIDITY');
  });

  it('prioritizes off state over heat state', () => {
    const room: Room = {
      uid: 'room-1',
      roomName: 'Room 1',
      status: 'active',
      device: 'device-1',
      power: false,
      temperature: 39,
      humidity: 70,
    };

    expect(getFloorPlanRoomState(room).visualState).toBe('off');
    expect(getFloorPlanRoomState(room).condition).toBe('OFF');
  });
});
