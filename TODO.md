# TODO: Production OcuGuide Assistant Upgrade

## Goal

Turn OcuGuide into a natural, production-ready facility assistant that:

- answers basic in-scope questions without requiring a tool;
- uses read-only facility tools only when live, stored, room-specific, or report data is needed;
- presents answers as clear paragraphs, lists, tables, metrics, and charts as appropriate;
- keeps technical tool names and safe tool-result details hidden until the user opens the disclosure control;
- feels as focused and easy to read as ChatGPT or Claude while retaining OcuTemp's identity;
- preserves the existing authentication, authorization, rate limits, encrypted chat state, and read-only data boundary.

## Implementation status

- [x] Feature-branch code implementation and static review are complete.
- [x] `npm run build` passes, including strict API TypeScript compilation and the Angular production build.
- [x] No automated tests were run and no test/spec files were added or modified.
- [ ] Confirm the configured Gemini and Groq models are enabled for the deployed provider accounts.
- [ ] Verify the required Vercel Preview environment variables, redeploy this feature branch, and complete the authenticated browser smoke checks in Section 10.

---

## Non-negotiable scope and safety constraints

- [x] Keep the existing `POST /api/chat` endpoint; do not add another API endpoint.
- [x] Do not add Firebase Functions.
- [x] Do not change the Firebase database structure or write data for this feature.
- [x] Do not change Firebase Security Rules as part of this work.
- [x] Keep every chat facility tool read-only; the assistant must never claim that it changed an AC, schedule, user, or database value.
- [x] Derive the authenticated user, approval state, and role on the server; never accept them from the browser.
- [x] Keep facility facts grounded in server-computed tool results and distinguish missing data from a recorded zero.
- [x] Never expose Firebase paths, internal IDs, bearer tokens, provider keys, prompts, stack traces, or raw database snapshots.
- [x] Treat room names, event details, schedule subjects, and stored AI reasons as untrusted text.
- [x] Preserve the current request, response, state-token, provider-timeout, response-size, facility-size, and rate-limit bounds unless a reviewed requirement explicitly changes one.
- [x] Use no new UI or markdown dependency unless the existing typed rendering approach is proven insufficient.
- [x] Use Tailwind CSS utilities as the primary styling approach; add native component CSS only when the requirement cannot be implemented reasonably with Tailwind.
- [x] Never create, add, modify, or generate test/spec files for this work.
- [x] Never run `npm test`, `ng test`, Vitest, or any other automated test runner.
- [x] Validate changes through careful code review, strict compilation performed by the existing build, `npm run build`, and optional manual checking with `ng serve` only.

---

## 1. Conversation behavior: tools are optional

### 1.1 Add a safe general-answer path

- [x] Add a planner intent for in-scope general guidance, such as `general`, separate from live `data`, static OcuTemp `help`, `greeting`, forbidden `control`, and `unsupported` requests.
- [x] Classify questions such as “What is humidity?”, “How can I improve AC efficiency?”, and “What temperature is generally comfortable?” as general questions with zero tools.
- [x] Keep requests about current rooms, current telemetry, stored energy, latest suggestions, recent events, rankings, or facility comparisons on the data-tool path.
- [x] Keep OcuTemp navigation and role-aware workflow questions on the static help-tool path when verified application steps are required.
- [x] Keep greetings short and tool-free.
- [x] Keep unrelated topics outside OcuGuide's scope and tool-free.
- [x] Keep requested control/write actions tool-free and return a clear read-only limitation plus safe navigation guidance when available.
- [x] Ask a clarification question only when the missing room, date range, or intended meaning materially changes the answer.
- [x] Do not ask for a room when the user clearly requests all/every active room.

### 1.2 Assign distinct jobs to the two models

- [x] Keep Gemini as the primary planner: classify intent, resolve follow-up context, decide whether tools are necessary, and return a bounded structured plan.
- [x] Keep Groq as the primary answer writer: turn either safe general knowledge or verified tool facts into a concise, human-readable answer.
- [x] Keep the opposite provider as fallback for each phase so planner and answer generation are not dependent on one provider.
- [x] Validate each provider's structured output before accepting it; an invalid primary response must trigger the fallback provider.
- [x] Keep provider temperature low and output-token limits bounded.
- [x] Never send Firebase credentials, user tokens, internal database paths, or full raw snapshots to either model.
- [x] Continue using deterministic server formatting as the safe fallback for tool-backed facility answers.

### 1.3 Define when tools are necessary

- [x] Use `get_room_telemetry` for current room temperature, humidity, occupancy, AC state, schedules, condition, or device freshness.
- [x] Use `get_energy_report` for energy totals, trends, periods, comparisons, coverage, rankings, runtime, or sessions.
- [x] Use `get_climate_prediction_logs` for stored climate recommendations, suggested temperatures, applied state, and stored reasons.
- [x] Use `get_recent_room_events` for recent operational or decision history.
- [x] Use `get_system_help` for verified OcuTemp navigation and role-filtered procedures.
- [x] Permit zero tools for general AC concepts, energy-efficiency guidance, explanations, greetings, clarifications, safety limitations, and unsupported requests.
- [x] Keep the existing maximum of four unique tool plans per turn; never call one tool separately for every room.
- [x] Request only the minimum tools needed to answer the question.
- [x] Reuse one all-active-rooms tool request when the user asks about every room.
- [x] Preserve exact date handling, Manila time, room/result caps, energy range caps, and bounded concurrent reads.

### 1.4 Conversation context and follow-ups

- [x] Let short follow-ups resolve against the encrypted recent conversation state, for example “What about last month?” or “Show those rooms now.”
- [x] Keep the server-side state window bounded to the current encrypted-state limits.
- [x] Store only compact, sanitized answer summaries in the state token.
- [x] When context expires or cannot safely resolve a reference, reset safely and ask for the missing detail.
- [x] Never treat prior user text, model text, or database text as system instructions.

---

## 2. Human-readable answer contract

### 2.1 Use typed content instead of unsafe HTML

- [x] Extend the shared answer contract so an answer can contain a concise headline plus typed content blocks.
- [x] Support only a small safe set of blocks: paragraph, bullet list, numbered steps, callout, and compact key-value summary.
- [x] Keep facility tables, metrics, and charts in the existing typed `ChatPresentation` union.
- [x] Do not render model-provided HTML with `innerHTML`.
- [x] Do not add unrestricted markdown rendering; if markdown is retained anywhere, parse only an explicit allowlist and sanitize it before rendering.
- [x] Bound the number and length of answer blocks, list items, headings, highlights, and caveats on the server.
- [x] Normalize whitespace and preserve intentional paragraph breaks.
- [x] Use plain language, short sections, descriptive labels, correct units, and clear dates.

### 2.2 General answers without facility claims

- [x] Create a dedicated general-answer prompt and structured schema that does not require facility evidence IDs.
- [x] Limit general answers to AC operation, indoor comfort, humidity, ventilation, energy efficiency, equipment care, and OcuTemp-relevant facility practices.
- [x] Make general recommendations cautious and non-diagnostic; avoid pretending generic guidance is a reading from the user's facility.
- [x] Clearly say when current facility data would be needed, then offer an appropriate follow-up instead of automatically running an unnecessary tool.
- [x] Reject or safely redirect medical, legal, dangerous electrical/HVAC repair, and unrelated requests.

### 2.3 Tool-backed answers

- [x] Keep every facility-specific number, room, time, status, ranking, and conclusion derived from typed server presentations/facts.
- [x] Use the answer model to organize and prioritize verified evidence, not to invent facility prose.
- [x] Render a useful text conclusion before any chart or table.
- [x] Choose the smallest useful visualization: table for many rooms, chart for trends/rankings, metric cards for a few totals, and plain text when a visual adds no value.
- [x] Preserve partial-data notices, coverage, unavailable-device states, no-record states, and timestamps.
- [x] Never describe missing records as zero consumption or an unavailable device as off.

---

## 3. Tool transparency without clutter

- [x] Keep charts, tables, and metrics visible as part of the assistant's answer when they are needed to answer the question.
- [x] Hide technical tool names and tool-result inspection content by default.
- [x] Add one unobtrusive “Show tools used” icon/button to an assistant turn only when that turn used at least one tool.
- [x] Give the control an accessible text label, tooltip, keyboard focus state, `aria-expanded`, and `aria-controls`.
- [x] Open a per-turn disclosure panel only after the user activates the control.
- [x] Inside the opened panel, list the exact executed tool names and a short result summary.
- [x] Keep the detailed result collapsed one level further or place it in a bounded scroll area so it never overwhelms the answer.
- [x] Show only the already-sanitized client presentation as the inspectable result; never return or label an internal Firebase snapshot as “raw data.”
- [x] Label partial status at the turn level unless the API exposes verified per-tool partial status.
- [x] Lazily serialize/display result JSON only while the disclosure is open.
- [x] Remove always-visible “Tool used” rows, terminal styling, or internal implementation wording from the main answer surface.

---

## 4. ChatGPT/Claude-inspired OcuTemp design

### 4.1 Simplify the page structure

- [x] Replace the current dashboard-like hero, large safety strip, thread header, message count, and decorative instrumentation with a quieter chat workspace.
- [x] Keep a compact top bar containing OcuGuide identity, a subtle read-only status, and New chat.
- [x] Move the longer read-only explanation into a small informational affordance or composer footer instead of a full-width banner.
- [x] Use one centered conversation column with a comfortable reading width and generous vertical rhythm.
- [x] Keep the composer visually anchored at the bottom with a subtle frosted/sticky surface.
- [x] Preserve full conversation history and the jump-to-latest control.

### 4.2 Message layout

- [x] Render user messages as compact right-aligned OcuTemp-blue bubbles.
- [x] Render assistant responses as open, wide content blocks rather than heavy nested cards.
- [x] Use a small OcuGuide avatar or blue facility-status mark only where it helps identify the speaker.
- [x] Make answer text the strongest visual element; keep metadata, evidence time, notices, and tool controls secondary.
- [x] Use at least comfortable 14–16 px body text, readable line height, and sensible paragraph width.
- [x] Style paragraphs, bullets, numbered steps, callouts, tables, code/result inspection, and links consistently.
- [x] Keep errors inline with one safe retry action only for the latest retryable request.

### 4.3 Empty, thinking, and follow-up states

- [x] Reduce the empty state to a concise welcome, a few role-aware prompt chips, and the composer.
- [x] Include both basic no-tool examples and data-backed examples so users understand both capabilities.
- [x] Replace the large four-step thinking card with a restrained typing/thinking row.
- [x] Keep loading text truthful and generic until the server actually exposes the selected tool; do not pretend a tool is running based only on elapsed time.
- [x] If tool activity is later returned by the API, display the exact safe stage rather than simulated progress.
- [x] Preserve role-aware and context-aware follow-up suggestions without crowding the composer.
- [x] Respect reduced-motion preferences for dots, transitions, scrolling, and charts.

### 4.4 Visual system

- [x] Retain OcuTemp slate/white surfaces and blue primary accent; reserve emerald, amber, and red for real status meaning.
- [x] Use the application's existing font stack instead of introducing a generic “AI product” font.
- [x] Reduce shadows, excessive pills, nested borders, decorative gradients, and tiny uppercase labels.
- [x] Use a single subtle facility-evidence signature, such as a small blue pulse/verified marker beside evidence-backed answers.
- [x] Keep visible keyboard focus, sufficient contrast, 44 px touch targets, and responsive layouts.
- [x] Remove desktop/mobile panel-switching concepts entirely; all content remains in one transcript on every viewport.

---

## 5. Tables, charts, and report presentation

- [x] Keep inline evidence attached to the assistant message that requested it, including historical turns.
- [x] Preserve room telemetry, energy, climate suggestion, recent event, and system-help presentations.
- [x] Use semantic tables with captions/accessible labels, sticky headers where useful, and horizontal scrolling on narrow screens.
- [x] Keep missing/unavailable states visible and sortable without placing null rows above valid readings.
- [x] Keep energy ranking and trend charts responsive with clear units, titles, accessible fallback tables, and no redundant legend.
- [x] Instantiate only the currently selected chart view.
- [x] Create charts only when the report is in or near the viewport.
- [x] Destroy Chart.js instances when hidden/out of view and in `ngOnDestroy`.
- [x] Cache derived chart series per immutable presentation to avoid repeated work.
- [x] Namespace every report DOM ID by turn ID to prevent duplicate IDs in chat history.
- [x] Keep raw/safe-result disclosure separate from the visible chart/table presentation.

---

## 6. Client behavior and efficiency

- [x] Preserve `OnPush` change detection and signal-based chat state.
- [x] Keep stable tracking keys for every message, presentation, table row, event, and suggestion.
- [x] Avoid duplicate-track keys for recent events that share the same timestamp/type/room.
- [x] Keep automatic scrolling pinned only while the user is already near the latest message.
- [x] Do not steal scroll position when the user is reviewing older messages.
- [x] Restore focus safely after Send, Retry, New chat, suggestion selection, and jump-to-latest actions.
- [x] Auto-grow the composer within a bounded height, then scroll inside it.
- [x] Abort the active request when starting a new conversation or when the authenticated user changes.
- [x] Clear a rejected/expired state token so Retry does not repeatedly submit an invalid token.
- [x] Consider a single forced Firebase token refresh only after a genuine authentication-expired response; do not refresh on every turn.
- [x] Use `content-visibility`/viewport deferral for long histories before adding a virtual-scroll dependency.
- [x] Keep Angular component styles below the existing 8 kB per-component hard budget.
- [x] Do not increase the initial bundle with an additional renderer or chart library.

---

## 7. Server safety, reliability, and production checks

- [x] Keep request processing in this order: method/origin/content checks, pre-auth IP limit, bounded body read, Firebase authentication, user/concurrency/facility limits, state decode, planner, tools, answer.
- [x] Keep the shared abort signal across body reading, authentication, limits, Firebase reads, planner, tools, and answer generation.
- [x] Keep the 20-second internal turn deadline below Vercel's 25-second function duration.
- [x] Keep the concurrency lease owner-checked, short-lived, and released in `finally`.
- [x] Keep exact-origin allowlisting; do not introduce wildcard origins.
- [x] Keep state encrypted and UID-bound with the existing JWE size, turn-count, and lifetime bounds.
- [x] Keep response bodies and Firebase REST reads byte-capped and abortable.
- [x] Keep Firebase REST paths and query parameters allowlisted and GET-only.
- [x] Keep provider errors, config details, keys, tokens, causes, and stack traces out of public responses.
- [x] Log only sanitized request IDs, stages, provider categories, and failure categories needed for operations.
- [ ] Verify both configured models are available to the deployed provider accounts before rollout.
- [ ] Verify all required Vercel Preview environment variables exist and redeploy after changes; do not hardcode them.
- [x] Keep only `api/chat/index.ts` under `api/` so the Vercel Hobby deployment remains one Serverless Function.

---

## 8. Exact implementation file map

### 8.1 Server files that must change

- [x] `server/chat/types/chat.types.ts`
  - Add the general intent and the bounded typed answer-block contract.
  - Keep server response types aligned with the browser models.
- [x] `server/chat/tools/schema.ts`
  - Add `general` to the planner schema.
  - Add a separate bounded schema for safe general answers, or extend the answer schema without weakening facility evidence requirements.
- [x] `server/chat/prompts/planner.prompt.ts`
  - Teach the planner the exact zero-tool versus tool-required decision boundary.
- [x] `server/chat/prompts/answerer.prompt.ts`
  - Improve organization, plain-language rules, and typed answer formatting for tool-backed answers.
- [x] `server/chat/prompts/general-answer.prompt.ts` (new)
  - Define the narrow in-scope general-knowledge, safety, and no-facility-claim policy.
- [x] `server/chat/orchestrator.ts`
  - Route `general` requests to the answer model without executing tools.
  - Validate and sanitize general answers separately from grounded facility answers.
  - Preserve deterministic formatting for tool-backed claims and safe fallbacks.
  - Keep planner/answerer model responsibilities and provider fallback explicit.

### 8.2 Client files that must change

- [x] `src/app/models/chat.models.ts`
  - Mirror the bounded answer-block and response contract exactly.
- [x] `src/app/services/chat.service.ts`
  - Validate the expanded response shape defensively.
  - Preserve abort, authentication, state reset, safe retry, and error mapping behavior.
- [x] `src/app/pages/ocu-guide/ocu-guide.ts`
  - Keep only page-level New chat/focus coordination needed by the simplified shell.
- [x] `src/app/pages/ocu-guide/ocu-guide.html`
  - Replace the heavy hero/safety-strip structure with the compact chat header and one transcript.
- [x] `src/app/pages/ocu-guide/ocu-guide.css`
  - Implement the centered responsive shell and remove obsolete decorative/page styles.
- [x] `src/app/pages/ocu-guide/ocu-guide-conversation.ts`
  - Add typed-block helpers, per-turn tool-disclosure state, composer resizing, and honest simplified loading behavior.
  - Preserve role-aware suggestions, focus, scroll pinning, latest-only retry, and accessibility announcements.
- [x] `src/app/pages/ocu-guide/ocu-guide-conversation.html`
  - Render human-readable typed answers, inline presentations, hidden tool disclosure, simplified thinking, suggestions, errors, and composer.
- [x] `src/app/pages/ocu-guide/ocu-guide-conversation.css`
  - Implement the ChatGPT/Claude-inspired message rhythm while retaining OcuTemp colors and staying below the style budget.
- [x] `src/app/components/ocu-guide-report/ocu-guide-report.ts`
  - Separate visible evidence rendering from hidden tool inspection.
  - Preserve lazy chart lifecycle, caching, unique IDs, sorting, filtering, and pagination.
- [x] `src/app/components/ocu-guide-report/ocu-guide-report.html`
  - Keep only user-facing tables/charts/help in the visible report; move technical tool/result details behind the per-turn disclosure control.
- [x] `src/app/components/ocu-guide-report/ocu-guide-report.css`
  - Flatten nested cards, improve inline readability, and retain responsive/accessible charts and tables below the style budget.

### 8.3 Existing files to review and change only if the response contract requires it

- [x] `api/chat/index.ts`
  - Verify the new answer contract serializes within the public response limit; no new route or handler style.
- [x] `server/chat/state.ts`
  - Verify the compact state summary remains within existing limits; do not store full answer blocks or tool results.
- [x] `server/chat/retry.ts`
  - Verify schema-invalid planner/general/answer output triggers the second provider.
- [x] `server/chat/providers/provider.interface.ts`
  - Change only if a distinct bounded generation option is required by the new general-answer phase.
- [ ] `server/chat/providers/gemini.provider.ts`
  - Verify the configured planner model supports the structured schema in the deployed account.
- [ ] `server/chat/providers/groq.provider.ts`
  - Verify the configured answer model supports structured output and is permitted in the deployed Groq organization.
- [x] `server/chat/tools/executor.ts`
  - Preserve the existing five read-only tools, caps, sanitization, room selection, and client-safe presentations.
  - Change only if verified per-tool status metadata is added to the public contract.
- [x] `server/chat/tools/energy.ts`
  - Preserve range validation, coverage, null-state handling, trend caps, and deterministic calculations.

### 8.4 Security/deployment files to verify, not redesign

- [ ] `server/chat/config.ts` — verify exact origins, 32-byte state secret, Firebase URLs, and Upstash configuration.
- [x] `server/chat/firebase-rest.ts` — verify GET-only bounded reads and safe error mapping.
- [x] `server/chat/middleware/auth.ts` — verify Firebase JWT, approval, role, and email-verification policy remains server-derived.
- [x] `server/chat/middleware/rate-limit.ts` — verify IP, UID, facility, and concurrency limits still protect all paths, including zero-tool answers.
- [x] `server/chat/middleware/validate-request.ts` — verify exact request keys, 500-code-point message cap, state-token cap, JSON-only POST, and origin checks.
- [x] `vercel.json` — preserve the single function, 25-second duration, API rewrite exclusion, and security headers.
- [x] `tsconfig.api.json` — keep both `api/**/*.ts` and `server/**/*.ts` in strict server type checking.
- [x] `package.json` — reuse existing AI SDK, `jose`, Upstash, Angular, Tailwind, and Chart.js dependencies; no new package expected.
- [x] `src/app/app.routes.ts` — verify lazy OcuGuide route and existing auth/approval guards; no route change expected.
- [x] `src/app/components/sidebar/sidebar.html` — verify the OcuGuide navigation link still fits the simplified page; no behavior change expected.

### 8.5 Validation without test files or test runners

- [x] Do not add or modify any `*.spec.ts`, `*.test.ts`, fixture, mock-test, snapshot, or automated test file.
- [x] Do not run `npm test`, `ng test`, Vitest, or another test command at any point.
- [x] Review every changed server and client file for strict typing, bounded inputs/outputs, sanitization, cleanup, accessibility, and existing project-pattern compliance.
- [x] Use the existing `npm run build` command as the required compilation and production-build validation.
- [x] Use `ng serve` only when a manual browser check is needed; do not treat it as authorization to create or run automated tests.
- [ ] Manually check the functional examples in Section 10 through the running application or deployed feature-branch Preview when available.

---

## 9. Implementation order

- [x] Phase 1 — Lock the intent, answer-block, presentation, and tool-disclosure contracts.
- [x] Phase 2 — Implement planner classification and safe zero-tool general answers.
- [x] Phase 3 — Update deterministic/tool-backed answer organization and shared client models.
- [x] Phase 4 — Simplify the page shell and message presentation.
- [x] Phase 5 — Move technical tool inspection behind the per-turn icon/button while retaining visible answer visuals.
- [x] Phase 6 — Complete responsive, accessibility, chart lifecycle, long-history, and focus behavior.
- [x] Phase 7 — Review the code, run the production build, and perform optional manual `ng serve` or feature-branch Preview checks without test files or test runners.

---

## 10. Verification checklist

### Functional examples

- [ ] “What is relative humidity?” returns a readable text answer with no tool disclosure.
- [ ] “How can we reduce AC energy waste?” returns practical text guidance with no fabricated facility claim.
- [ ] “What is the current temperature in every room?” uses one telemetry tool and returns a readable comparison table.
- [ ] “Give me this month's energy report for every room” uses one energy tool and returns summary text, coverage, table, and useful chart.
- [ ] “Why is Room 101 hot?” reports current verified observations and clearly avoids inventing a cause.
- [ ] “Turn off Room 101” performs no tool write and explains the read-only boundary.
- [ ] “What about last month?” resolves from valid recent context or asks a safe clarification.
- [ ] Technical tool names/results are absent until the user activates “Show tools used.”

### Security and resilience

- [ ] Unauthenticated, unapproved, wrong-origin, oversized, malformed, and rate-limited requests fail with the intended safe status/message.
- [ ] Prompt injection in the user message or stored Firebase text cannot change tool permissions or expose internals.
- [ ] Facility claims never appear without typed evidence.
- [ ] General answers never masquerade as current facility readings.
- [ ] Both provider fallback directions work and dual failure returns a safe 503.
- [ ] State tampering, cross-user reuse, and expiry fail closed.
- [ ] The browser never receives credentials, internal paths, or unsanitized database records.

### UI, accessibility, and performance

- [ ] Keyboard and screen-reader users can send, retry, start a new chat, jump to latest, switch chart views, inspect tables, and open/close tool details.
- [ ] Mobile, tablet, desktop, short landscape, zoomed, and reduced-motion layouts remain usable.
- [ ] Tables scroll safely on narrow screens and charts retain accessible tabular data.
- [ ] A long conversation does not accumulate offscreen Chart.js instances or lose scroll position.
- [x] Every component remains below the Angular 8 kB component-style error threshold.
- [ ] No new browser console errors, duplicate DOM IDs, duplicate tracking keys, or memory leaks are introduced.

### Required commands before deployment

- [x] `npm run build`
- [ ] Optionally run `ng serve` for manual browser validation when needed.
- [ ] Deploy the feature branch Preview and manually check authenticated text-only, tool-backed, error, retry, disclosure, and mobile flows.
- [x] Do not run an automated test command before, during, or after these checks.

---

## Definition of done

- [x] Basic in-scope questions receive natural answers without mandatory tools.
- [x] Live/stored facility questions use only the minimum necessary read-only tools.
- [x] Answers are human-readable and use tables/charts only when those visuals improve understanding.
- [x] Technical tool names and safe result details are hidden until explicitly opened.
- [x] The interface is calm, modern, responsive, accessible, and recognizably OcuTemp.
- [x] The same secured `/api/chat` endpoint, database structure, Firebase rules, and read-only boundary remain intact.
- [x] Careful code validation, the production build, and any requested manual `ng serve` or Preview checks pass without adding or running tests.
