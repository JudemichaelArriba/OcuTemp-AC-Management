import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EnergyReports } from './energy-reports';

describe('EnergyReports', () => {
  let component: EnergyReports;
  let fixture: ComponentFixture<EnergyReports>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EnergyReports]
    })
    .compileComponents();

    fixture = TestBed.createComponent(EnergyReports);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
