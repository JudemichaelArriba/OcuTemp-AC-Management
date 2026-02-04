import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RoomManagement } from './room-management';

describe('RoomManagement', () => {
  let component: RoomManagement;
  let fixture: ComponentFixture<RoomManagement>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RoomManagement]
    })
    .compileComponents();

    fixture = TestBed.createComponent(RoomManagement);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
