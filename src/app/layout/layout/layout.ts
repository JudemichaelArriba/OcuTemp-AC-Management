import { Component, ViewEncapsulation } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from '../../components/sidebar/sidebar';

@Component({
  selector: 'app-layout',
  templateUrl: './layout.html',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent],
  
})
export class LayoutComponent {}