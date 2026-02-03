import { Component, ViewEncapsulation  } from '@angular/core';
import { CommonModule } from '@angular/common';


@Component({
  selector: 'app-sidebar',
  templateUrl: './sidebar.html',
  standalone: true,
  imports: [CommonModule],
    encapsulation: ViewEncapsulation.None
})
export class SidebarComponent {}
