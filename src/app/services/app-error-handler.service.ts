import { ErrorHandler, Injectable } from '@angular/core';
import { LoggerService } from './logger.service';

@Injectable()
export class AppErrorHandler implements ErrorHandler {
  constructor(private logger: LoggerService) {}

  handleError(error: unknown): void {
    this.logger.error('Unhandled Angular error', error, {
      area: 'angular',
      action: 'global-error-handler',
    });
  }
}
