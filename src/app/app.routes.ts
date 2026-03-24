import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { LoginComponent } from './pages/login/login';
import { ForgotPasswordComponent } from './pages/forgot-password/forgot-password';
import { Dashboard } from './pages/dashboard/dashboard';
import { LayoutComponent } from './layout/layout/layout';
import { AuthGuard } from './guards/auth.guard';
import { ApprovedGuard } from './guards/approved.guard';
import { RoomManagement } from './pages/room-management/room-management';
import { EnergyReports } from './pages/energy-reports/energy-reports';
import { UserManagement } from './pages/user-management/user-management';
import {  } from './pages/room-management/room-management';
import { AddCredentialsComponent } from './pages/add-credentials/add-credentials';
import { AdminGuard } from './guards/admin.guard';
import { SignupComponent } from './pages/signup/signup';
import { RoomDetails } from './pages/room-details/room-details';
import { SettingsPage } from './pages/settings-page/settings-page';
import { LoginGuard } from './guards/login.guard';
export const routes: Routes = [
  { path: 'login', component: LoginComponent, canActivate: [LoginGuard]},
  { path: 'forgot-password', component: ForgotPasswordComponent , canActivate: [LoginGuard]},
  { path: 'signup', component: SignupComponent, canActivate: [LoginGuard]},
  { path: 'add-credentials', component: AddCredentialsComponent, canActivate: [AuthGuard] },

  { 
    path: 'app', 
    component: LayoutComponent, 
    canActivate: [AuthGuard, ApprovedGuard],
    children: [
        { path: 'dashboard', component: Dashboard },
        { path: 'room-management', component: RoomManagement },
        { path: 'room-details/:uid', component: RoomDetails},
        { path: 'energy-reports', component: EnergyReports },
        { path: 'settings', component: SettingsPage },
        { 
          path: 'user-management', 
          component: UserManagement, 
          canActivate: [AdminGuard]
        },
        { path: '', redirectTo: 'dashboard', pathMatch: 'full' }
    ]
  },

  { path: '', redirectTo: 'login', pathMatch: 'full' },
];
