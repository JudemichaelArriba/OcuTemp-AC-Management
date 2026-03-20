import { Injectable } from "@angular/core";
import { environment } from "../../environments/environment.prod";


@Injectable({ providedIn: 'root' })
export class LoggerService {
    error(...args: unknown[]): void {
        if (!environment.production) {
            console.error(...args);
        }
    }



    warn(...args: unknown[]): void {
        if (!environment.production) {
            console.warn(...args);
        }
    }
}