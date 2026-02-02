import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { provideFirebaseApp, initializeApp } from '@angular/fire/app';
import { provideDatabase, getDatabase } from '@angular/fire/database';
import { environment } from '../environments/environment';
import { provideAuth, getAuth } from '@angular/fire/auth';
import { FormsModule } from '@angular/forms';
import { importProvidersFrom } from '@angular/core';



export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
  
    provideFirebaseApp(() => initializeApp(environment .firebase)),
    provideDatabase(() => getDatabase()),
    provideAuth(() => getAuth()),
      importProvidersFrom(FormsModule)
  ]
};
