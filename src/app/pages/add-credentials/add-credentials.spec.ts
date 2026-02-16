import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AddCredentials } from './add-credentials';

describe('AddCredentials', () => {
  let component: AddCredentials;
  let fixture: ComponentFixture<AddCredentials>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AddCredentials]
    })
    .compileComponents();

    fixture = TestBed.createComponent(AddCredentials);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
