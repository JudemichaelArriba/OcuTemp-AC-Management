import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import * as Sentry from "@sentry/angular";
import { environment } from './environments/environment';



if (environment.production) {
  Sentry.init({
    dsn: "https://cd8dd1a3ffb7021bb5a368b02e27f5f3@o4511336061075456.ingest.us.sentry.io/4511336142340096",
    sendDefaultPii: true,
    integrations: [
      Sentry.browserTracingIntegration()
    ],
    tracesSampleRate: 1.0,
    tracePropagationTargets: []
  });
}



bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
