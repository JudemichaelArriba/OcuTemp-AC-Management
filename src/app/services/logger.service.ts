import { Injectable } from "@angular/core";
import { environment } from "../../environments/environment";
import * as Sentry from "@sentry/angular";

@Injectable({ providedIn: 'root' })
export class LoggerService {
  
    error(...args: any[]): void {
        if (!environment.production) {
            console.error(...args);
        } else {
            Sentry.captureException(args[0]); 
        }
    }

    warn(...args: any[]): void {
        if (!environment.production) {
            console.warn(...args);
        } else {
            Sentry.captureMessage(args.join(' '), "warning");
        }
    }
}