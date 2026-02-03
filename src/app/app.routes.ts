import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { LoginComponent } from './pages/login/login';
import { ForgotPasswordComponent } from './pages/forgot-password/forgot-password';

import { LayoutComponent } from './pages/layout/layout';
import { AuthGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'forgot-password', component: ForgotPasswordComponent },
  

  { 
    path: 'app', 
    component: LayoutComponent, 
    canActivate: [AuthGuard],
    children: [
      // future child routes go here
    ]
  },

  { path: '', redirectTo: 'login', pathMatch: 'full' },
];