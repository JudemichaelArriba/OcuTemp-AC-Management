import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from '../../components/sidebar/sidebar';
import { SnackBar } from '../../components/snack-bar/snack-bar';
import { DeviceOfflineMonitorService } from '../../services/device-offline-monitor.service';

@Component({
  selector: 'app-layout',
  templateUrl: './layout.html',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, SnackBar],
  
})
export class LayoutComponent implements OnInit, OnDestroy {
  constructor(private offlineMonitor: DeviceOfflineMonitorService) {}

  ngOnInit(): void {
    this.offlineMonitor.start();
  }

  ngOnDestroy(): void {
    this.offlineMonitor.stop();
  }
}
