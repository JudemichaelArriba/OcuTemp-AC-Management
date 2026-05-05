import { ApplicationConfig, provideBrowserGlobalErrorListeners, ErrorHandler, APP_INITIALIZER } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { routes } from './app.routes';
import { provideFirebaseApp, initializeApp } from '@angular/fire/app';
import { provideDatabase, getDatabase } from '@angular/fire/database';
import { environment } from '../environments/environment';
import { provideAuth, getAuth } from '@angular/fire/auth';
import { FormsModule } from '@angular/forms';
import { importProvidersFrom } from '@angular/core';


import * as Sentry from "@sentry/angular";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideFirebaseApp(() => initializeApp(environment.firebase)),
    provideDatabase(() => getDatabase()),
    provideAuth(() => getAuth()),
    importProvidersFrom(FormsModule),
    {
      provide: ErrorHandler,
      useValue: Sentry.createErrorHandler({
        showDialog: false, 
      }),
    },
    {
      provide: Sentry.TraceService,
      deps: [Router],
    },
    {
      provide: APP_INITIALIZER,
      useFactory: () => () => {},
      deps: [Sentry.TraceService],
      multi: true,
    },
  ]
};