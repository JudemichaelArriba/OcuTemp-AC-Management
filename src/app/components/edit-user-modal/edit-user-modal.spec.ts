import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EditUserModal } from './edit-user-modal';

describe('EditUserModal', () => {
  let component: EditUserModal;
  let fixture: ComponentFixture<EditUserModal>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EditUserModal]
    })
    .compileComponents();

    fixture = TestBed.createComponent(EditUserModal);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
