import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class FloorPlanService {
  isAssignableCellId(cellId: string): boolean {
    const ignored = new Set(['0', '1', '3-Story-Building']);
    if (ignored.has(cellId)) return false;
    return /^[A-Z][A-Za-z0-9-]*$/.test(cellId);
  }
}