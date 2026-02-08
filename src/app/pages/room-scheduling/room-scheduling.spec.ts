import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RoomScheduling } from './room-scheduling';

describe('RoomScheduling', () => {
  let component: RoomScheduling;
  let fixture: ComponentFixture<RoomScheduling>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RoomScheduling]
    })
    .compileComponents();

    fixture = TestBed.createComponent(RoomScheduling);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
