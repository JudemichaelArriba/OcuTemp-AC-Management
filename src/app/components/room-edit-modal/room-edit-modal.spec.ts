import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RoomEditModal } from './room-edit-modal';

describe('RoomEditModal', () => {
  let component: RoomEditModal;
  let fixture: ComponentFixture<RoomEditModal>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RoomEditModal]
    })
    .compileComponents();

    fixture = TestBed.createComponent(RoomEditModal);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
