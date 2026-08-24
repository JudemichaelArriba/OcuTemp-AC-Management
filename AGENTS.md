<!-- BEGIN:angular-agent-rules -->

# This is Angular 21 — Read Before Coding

Angular 21 uses standalone components, signals, and modern patterns. Check official documentation before assuming behavior from training data.

<!-- END:angular-agent-rules -->

# AGENTS.md — OcuTemp AC Management

## Project Identity

OcuTemp is an Angular IoT dashboard for real-time monitoring and management of air-conditioning units across rooms. Connects rooms, ESP-based IoT devices, and users (staff/admin) for facility management.

**Core features:** Real-time telemetry, floor-plan mapping, AI temperature recommendations, manual AC overrides, energy analytics, operational logging.

---

## Core Principles

1. Visualize room environmental conditions in real-time
2. Enable efficient AC control across multiple rooms
3. Reduce energy waste through intelligent automation
4. Provide actionable operational insights
5. Map rooms to physical floor-plan locations
6. Alert staff to device/environmental anomalies

---

## Tech Stack

Angular 21 • TypeScript (strict) • Firebase Auth + Realtime Database • AngularFire • Chart.js • Tailwind CSS • Sentry • jsPDF • Vercel

---

## Folder Structure

- `components/` - UI components, modals (room cards, floor-plan, logs, energy widgets, etc.)
- `guards/` - Route guards (auth, admin, approved, login)
- `helpers/` - Pure utilities (validation, telemetry merging, floor-plan state, rate limiting)
- `models/` - TypeScript interfaces (Room, Device, User, Schedule, LogEntry, MlSuggestion, EnergyRecord)
- `pages/` - Application pages (dashboard, room-management, energy-reports, settings, user-management)
- `services/` - Business logic and Firebase interactions
- `environments/` - Generated environment config (never commit)

---

## System Architecture

### User Roles

- **Admin**: Full access, manage users, approve staff, bypass email verification
- **Staff (Approved)**: Manage rooms, control AC, view reports, edit floor-plan
- **Staff (Pending)**: Authenticated but awaiting approval
- **Unauthenticated**: Login, signup, forgot-password only

### Firebase Database Structure

```
users/{userId} - role, approved, email, fullName
rooms/{roomUid} - roomName, status, device, schedules, floorPlanCellId
devices/{deviceId} - temperature, humidity, occupancy, acState, control, mlSuggestion, status
logs/{logId} - deviceId, roomName, event, timestamp
energy/{deviceId}/daily/{YYYY-MM-DD} - kwh
```

**Key Paths:**
- `devices/{deviceId}/control` - Manual overrides (overrideActive, targetTemp, overrideUntil, aiAutoApply)
- `devices/{deviceId}/mlSuggestion` - AI temperature suggestions
- `devices/{deviceId}/status/lastSeen` - Device online state (ISO timestamp)

---

## Key Services

**All services are `providedIn: 'root'`**

- `RoomService` - Room CRUD, floor-plan assignments, name uniqueness checks
- `DeviceService` - Device telemetry streams, control commands, online state
- `AuthService` / `AuthStateService` - Firebase auth, signup with email verification, user state
- `EnergyReportService` - Aggregate daily/weekly/monthly/yearly energy data
- `LoggerService` - Centralized error logging with Sentry (sanitizes sensitive data)
- `DeviceOfflineMonitorService` - Background monitoring for offline devices and hot rooms
- `DialogService` / `SnackBarService` - UI notifications
- `PdfExportService` - Generate PDF energy reports
- `ChatService` - Chat state, turn orchestration, message validation
- `ChatToolsService` - Read-only tool execution (telemetry, energy, help)

---

## Guards

- `AuthGuard` - Requires verified email (admin bypasses verification)
- `ApprovedGuard` - Requires admin approval
- `AdminGuard` - Requires admin role
- `LoginGuard` - Redirects authenticated users away from auth pages

---

## Real-Time Data Flow

Firebase streams using `onValue`. All stream methods return unsubscribe function. **Always unsubscribe in `ngOnDestroy`** to prevent memory leaks.

Rooms reference devices by ID but don't store telemetry. Use `mergeRoomsWithTelemetry` helper to combine room metadata with live device data.

---

## Floor-Plan System

SVG with predefined cells (e.g., `room-101`). Rooms assign to cells for visual mapping.

**Rules:**
- One room per cell (enforced by `RoomService.assertFloorPlanCellAvailable`)
- Track assignment via `floorPlanAssignedAt`

**Visual States** (use `getFloorPlanRoomState` helper):
- `normal` - Normal conditions
- `hot` - High heat index (temp + humidity)
- `offline` - Device offline
- `inactive` - Room inactive

---

## Manual AC Control

User sets temp/duration → writes to `devices/{deviceId}/control` → device polls Firebase → applies override → expires at `overrideUntil`.

**Forced-Off:** Special override that immediately turns off AC power.

---

## AI Auto-Apply System

External ML service writes suggestions to `devices/{deviceId}/mlSuggestion`. If `aiAutoApply` enabled in `devices/{deviceId}/control/aiAutoApply`, device applies automatically. Otherwise, user must approve. Suggestions include reasoning text.

---

## Energy Reporting

Data at `energy/{deviceId}/daily/{YYYY-MM-DD}/kwh`. `EnergyReportService` aggregates into daily (7 days), weekly (8 weeks), monthly (12 months), yearly (5 years) totals. `PdfExportService` generates PDF with charts and breakdowns.

---

## AI Chatbot

**Architecture:** Vercel Edge Function (`/api/chat`) + two-phase planner-answerer orchestration + tool execution + response validation.

**Flow:** User message → context check → planner (decide tool or direct answer) → tool executor (read-only) → answerer (natural language) → validation → UI.

**Providers:** Gemini (primary), Groq (fallback). Auto-fallback on provider failure.

**Tools (read-only):**
- `get_room_telemetry` - Current temp, humidity, occupancy, AC state, schedules
- `get_energy_rankings` - Top consumers by AC status
- `get_energy_usage` - Facility or room energy series (daily/weekly/monthly/yearly)
- `get_climate_prediction_logs` - ML suggestions for a room
- `get_system_help` - Static help topics (admin/staff filtered)

**Validation Pipeline:**
- Context relevance (`chat-context-checker.ts`) - rejects off-topic before API call
- Response validation (`chat-response-validator.ts`) - detects hallucinations, number invention, control claims
- Response sanitization (`chat-response-sanitizer.ts`) - removes Firebase paths, sensitive data
- Fallback to raw data table if validation fails

**Helpers:**
- `chat-history-trimmer.ts` - Window trimming for API (preserves full history for UI)
- `chat-response-cleaner.ts` - Round numbers, format timestamps
- `system-help-content.ts` - Static help entries (route paths must match `app.routes.ts`)

**Safety:**
- Tool validation prevents write operations
- Admin-only help entries filtered by role
- Rate limiting via edge middleware
- All tool operations are snapshots (no live streams exposed to LLM)

**UI:** `ChatSidebarComponent` with role-aware suggestions, loading states, fallback tables. Messages rendered via `ChatMessageComponent`.

---

## Logging

`LoggerService` with Sentry integration. Sanitizes sensitive data, prevents duplicates. Use `logger.error(message, error, context)` and `logger.warn(message, context)`.

Operational logs in `logs/` shown in dashboard, room details, and logs modal (paginated).

---

## Authentication Flow

**Signup:** Email/password → Firebase account → verification email → poll verification → complete profile → admin approves → access granted.

**Login:** Credentials → Firebase auth → guards check verification/approval → redirect.

**Password Reset:** Firebase email link flow.

---

## Device Online State

Use `getDeviceOnlineState()` helper based on `lastSeen`:
- **Online**: < 2 min
- **Stale**: 2–5 min
- **Offline**: > 5 min or missing

---

## Schedule System

Rooms have weekly schedules (day, startTime, endTime, subject). Use `ScheduleBuilder` component for CRUD.

**Validation:** No overlaps on same day, startTime < endTime, all fields required. Use `room-validation.ts` helpers.

---

## Chart.js Lifecycle

Store Chart.js instance, destroy before creating new one, always destroy in `ngOnDestroy`.

---

## Environment Configuration

**Never hardcode credentials.** Create `.env` with Firebase/Sentry vars. `node set-env.js` generates Angular environment files (auto-runs before `npm start` and `npm run build`).

**Required:** `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_DATABASE_URL`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_ID`, `FIREBASE_APP_ID`, `SENTRY_DSN`.

---

## Do

**Performance:**
- Unsubscribe from Firebase streams in `ngOnDestroy`
- Use `trackBy` in `*ngFor` loops
- Destroy Chart.js instances on cleanup
- Debounce search inputs

**Code Quality:**
- Use TypeScript strict mode
- Prefer interfaces over classes for data models
- Keep service methods focused and single-purpose
- Follow existing patterns before creating new ones

**User Experience:**
- Show loading states and error messages (snack-bar)
- Confirm destructive actions (delete room, force-off AC)
- Provide meaningful empty states

**Security:**
- Validate all inputs
- Use Firebase Security Rules
- Never trust client-side data
- Log security events

**Real-Time:**
- Provide `onError` callbacks to stream methods
- Show device online/offline/stale states
- Handle connection loss gracefully

---

## Do NOT

- Hardcode credentials or store sensitive data in localStorage
- Mutate service state from components
- Create duplicate services
- Use jQuery or direct DOM manipulation
- Ignore TypeScript errors or skip guards
- Trust device timestamps without validation
- Expose admin functionality to staff
- Log sensitive data (passwords, tokens)
- Forget to unsubscribe (memory leaks)
- Use `any` type without reason

---

## Angular Patterns

**Standalone Components:** All components are standalone. Import dependencies in decorator.

**Routing:** Routes in `app.routes.ts`. Use lazy loading for heavy pages.

**Dependency Injection:** Use `inject()` function or constructor injection.

---

## AI Agent Behavior

Before implementing:
1. Read existing code in relevant service/component
2. Reuse existing patterns and utilities
3. Check models for existing interfaces
4. Search for similar functionality
5. Modify minimal files
6. Follow existing naming conventions

When adding features: Read related services, check helpers, ensure strict types, add error logging.

When fixing bugs: Read full file, check similar patterns, test success/error paths, add logging if missing.

When refactoring: Never change behavior, resolve all TypeScript errors, verify Firebase stream cleanup.

---

## Common Pitfalls

**Memory Leaks:** Always unsubscribe from Firebase streams in `ngOnDestroy`.

**Type Safety:** Never use `any` for Firebase data. Cast to proper interfaces.

**Error Handling:** Always provide `onError` callbacks to streaming methods, log via `LoggerService`.

**Device ID Normalization:** Use `DeviceService.normalizeDeviceId()` for comparisons.

**Floor-Plan Conflicts:** Use `RoomService.assertFloorPlanCellAvailable()` before assignment.

**Time Zones:** Store timestamps in ISO format, display in user's local timezone.

**Schedule Overlaps:** Use `validateSchedulesList()` helper before saving.

---

## Deployment

**Vercel Build:** `node set-env.js && ng build`

**Environment Variables:** Configure in Vercel dashboard (same keys as `.env`).

**SPA Routing:** All routes rewrite to `index.html` via `vercel.json`.

---

## Testing

Test: Service methods with complex logic, helpers with edge cases, guard authorization, data transformations.

Skip: Simple getters/setters, pure UI components, Firebase SDK behavior.

---

## Before Finishing

Ensure: TypeScript compiles, no console errors, Firebase streams unsubscribed, error logging in place, guards applied, no hardcoded credentials, Chart.js destroyed, no memory leaks, clean imports, correct Tailwind classes.
