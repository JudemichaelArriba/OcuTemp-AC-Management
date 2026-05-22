import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EnergyRoomWidget } from './energy-room-widget';

describe('EnergyRoomWidget', () => {
  let component: EnergyRoomWidget;
  let fixture: ComponentFixture<EnergyRoomWidget>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EnergyRoomWidget]
    })
    .compileComponents();

    fixture = TestBed.createComponent(EnergyRoomWidget);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
