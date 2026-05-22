# OcuTemp AC Management

OcuTemp is an Angular-based IoT dashboard for monitoring and managing air-conditioning units across rooms. It combines live device telemetry, room assignment, floor-plan visualization, energy reporting, manual AC overrides, and role-based administration in one web application.

## Features

- Live dashboard for room temperature, occupancy, AC status, energy usage, active overrides, and recent decision logs.
- Room management with device assignment, room status tracking, search, schedule data, and active/inactive states.
- Interactive floor-plan view for mapping rooms to physical locations and checking room conditions visually.
- Energy reports with daily, weekly, monthly, and room-level consumption summaries.
- Firebase Authentication with staff signup, login, approval checks, and protected application routes.
- Role-based access for admin-only user management and staff-level operations.
- Manual AC controls, forced-off commands, AI auto-apply toggles, and pending ML temperature suggestions.
- Centralized logging with Sentry support for production error reporting.

## Tech Stack

- Angular 21
- TypeScript
- Firebase Authentication
- Firebase Realtime Database
- AngularFire
- Chart.js
- Tailwind CSS
- Sentry for production error monitoring
- Vercel deployment configuration

## Requirements

- Node.js 20.x
- npm
- A Firebase project with Authentication and Realtime Database enabled
- Optional: a Sentry project for production error monitoring

## Getting Started

Install dependencies:

```bash
npm install
```

Create a `.env` file in the project root. Use your own Firebase and optional Sentry values:

```env
FIREBASE_API_KEY=your-firebase-api-key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_STORAGE_BUCKET=your-project.appspot.com
FIREBASE_MESSAGING_ID=your-messaging-sender-id
FIREBASE_APP_ID=your-firebase-app-id
SENTRY_DSN=your-sentry-dsn
```

Do not commit real environment values. The `.env` file is already ignored by git.

Start the local development server:

```bash
npm start
```

Open the app at:

```text
http://localhost:4200
```

The `npm start` script runs `set-env.js` before Angular starts. This generates Angular environment files from `.env` so Firebase and Sentry configuration can be injected without hardcoding values in the README.

## Available Scripts

```bash
npm start
```

Runs environment generation and starts the Angular development server.

```bash
npm run build
```

Generates environment files, clears the Angular cache, and creates a production build in `dist/Ocutemp`.

```bash
npm run watch
```

Builds the app in development mode and watches for changes.

```bash
npm test
```

Runs the Angular unit test setup.

## Project Structure

```text
public/                     Static assets, logo, favicon, and floor-plan SVG
src/app/components/         Reusable UI components and shared controls
src/app/guards/             Route guards for auth, approval, admin, and login flows
src/app/helpers/            Validation, telemetry, floor-plan, and display helpers
src/app/models/             TypeScript interfaces for rooms, users, devices, logs, and energy data
src/app/pages/              Application pages such as dashboard, rooms, reports, settings, and users
src/app/services/           Firebase data access, auth state, logging, dialogs, and domain services
src/environments/           Generated Angular environment configuration
set-env.js                  Environment file generator for local and production builds
vercel.json                 Vercel build, routing, and header configuration
```

## Main Data Areas

The application expects Firebase Realtime Database data around these main areas:

- `users`: user profiles, roles, approval status, and account metadata.
- `rooms`: room names, assigned devices, status, floor-plan cell assignments, and schedules.
- `devices`: telemetry, AC state, control commands, ML suggestions, and daily energy records.
- `logs`: decision or system activity shown in dashboard log widgets and modals.

Keep database rules aligned with the admin and staff access model used by the Angular route guards and services.

## Deployment

The project includes a Vercel configuration. For deployment, configure the same environment variables in the hosting provider instead of committing them to the repository.

The Vercel build command is:

```bash
node set-env.js && ng build
```

The app is configured as a single-page application, so Vercel rewrites all routes to `index.html`.

