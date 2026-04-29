import { Injectable } from '@angular/core';

export interface FloorPlanDefinition {
  id: string;
  name: string;
  description: string;
}

export const MAIN_FLOOR_PLAN_ID = 'main-building';

@Injectable({
  providedIn: 'root',
})
export class FloorPlanService {
  private readonly floorPlans: FloorPlanDefinition[] = [
    {
      id: MAIN_FLOOR_PLAN_ID,
      name: 'Main Building',
      description: 'Existing static building floorplan',
    },
  ];

  getFloorPlans(): FloorPlanDefinition[] {
    return [...this.floorPlans];
  }

  getDefaultFloorPlanId(): string {
    return MAIN_FLOOR_PLAN_ID;
  }

  getFloorPlanById(id: string): FloorPlanDefinition | undefined {
    return this.floorPlans.find((floorPlan) => floorPlan.id === id);
  }

  isAssignableCellId(cellId: string): boolean {
    const ignored = new Set(['0', '1', '3-Story-Building']);
    if (ignored.has(cellId)) return false;
    return /^[A-Z][A-Za-z0-9-]*$/.test(cellId);
  }
}
