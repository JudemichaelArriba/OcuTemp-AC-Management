import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FloorPlanComponent } from './floor-plan';
import { Room } from '../../models/room.model';
import { MAIN_FLOOR_PLAN_ID } from '../../services/floor-plan.service';

describe('FloorPlanComponent', () => {
  let fixture: ComponentFixture<FloorPlanComponent>;
  let component: FloorPlanComponent;

  const assignedRoom: Room = {
    uid: 'room-1',
    roomName: 'Room 1',
    status: 'active',
    device: 'device-1',
    power: true,
    temperature: 24,
    humidity: 50,
    floorPlanId: MAIN_FLOOR_PLAN_ID,
    floorPlanCellId: 'Room-1',
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FloorPlanComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(FloorPlanComponent);
    component = fixture.componentInstance;
  });

  it('does not emit edit requests when edit mode is off', () => {
    const editSpy = vi.fn();
    component.floorPlanCellEditRequested.subscribe(editSpy);

    fixture.componentRef.setInput('rooms', [assignedRoom]);
    fixture.componentRef.setInput('editMode', false);
    fixture.detectChanges();

    clickCell('Room-1');

    expect(component.activeRoom?.uid).toBe('room-1');
    expect(editSpy).not.toHaveBeenCalled();
  });

  it('emits edit requests for assignable cells when edit mode is on', () => {
    const editSpy = vi.fn();
    component.floorPlanCellEditRequested.subscribe(editSpy);

    fixture.componentRef.setInput('rooms', [assignedRoom]);
    fixture.componentRef.setInput('editMode', true);
    fixture.detectChanges();

    clickCell('Room-1');

    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(editSpy.mock.calls[0][0].cellId).toBe('Room-1');
    expect(editSpy.mock.calls[0][0].room?.uid).toBe('room-1');
  });

  it('removes stale state classes when room telemetry changes', () => {
    fixture.componentRef.setInput('rooms', [assignedRoom]);
    fixture.detectChanges();

    const cell = getCell('Room-1');
    expect(cell.classList.contains('floorplan-state-comfortable')).toBe(true);

    fixture.componentRef.setInput('rooms', [{ ...assignedRoom, power: false }]);
    fixture.detectChanges();

    expect(cell.classList.contains('floorplan-state-comfortable')).toBe(false);
    expect(cell.classList.contains('floorplan-state-off')).toBe(true);
  });

  function clickCell(cellId: string): void {
    const rect = getCell(cellId).querySelector('rect');
    if (!rect) throw new Error(`Missing rect for ${cellId}`);
    rect.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
  }

  function getCell(cellId: string): SVGGElement {
    const cell = fixture.nativeElement.querySelector(`g[data-cell-id="${cellId}"]`) as SVGGElement | null;
    if (!cell) throw new Error(`Missing cell ${cellId}`);
    return cell;
  }
});
