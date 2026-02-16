import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { LoginComponent } from './pages/login/login';
import { ForgotPasswordComponent } from './pages/forgot-password/forgot-password';
import { Dashboard } from './pages/dashboard/dashboard';
import { LayoutComponent } from './layout/layout/layout';
import { AuthGuard } from './guards/auth.guard';
import { RoomManagement } from './pages/room-management/room-management';
import { EnergyReports } from './pages/energy-reports/energy-reports';
import { UserManagement } from './pages/user-management/user-management';
import {  } from './pages/room-management/room-management';
import { AddCredentialsComponent } from './pages/add-credentials/add-credentials';



export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'forgot-password', component: ForgotPasswordComponent },
  { path: 'add-credentials', component: AddCredentialsComponent, canActivate: [AuthGuard] },


  { 
    path: 'app', 
    component: LayoutComponent, 
    canActivate: [AuthGuard],
    children: [
        { path: 'dashboard', component: Dashboard },
        { path: 'room-management', component: RoomManagement },
          { path: 'energy-reports', component: EnergyReports },
            { path: 'user-management', component: UserManagement },
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' }
      
    ]
  },

  { path: '', redirectTo: 'login', pathMatch: 'full' },
];