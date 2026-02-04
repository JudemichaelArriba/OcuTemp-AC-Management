import { Component, ViewEncapsulation  } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'app-sidebar',
  templateUrl: './sidebar.html',
  standalone: true,
  imports: [CommonModule, RouterModule],
    encapsulation: ViewEncapsulation.None
})
export class SidebarComponent {}
