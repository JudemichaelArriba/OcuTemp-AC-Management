# TODO: OcuGuide Flexible System Assistant

## Status and scope

Planning only. Every implementation item is intentionally unchecked.

- This pass changes only `TODO.md`.
- Do not change the database, RTDB rules, environment files, packages, routes, or add another API/Firebase Function.
- Do not hardcode values from the supplied RTDB export; all answers must use the authenticated live snapshot.
- Keep OcuGuide read-only and limited to OcuTemp questions the signed-in role is authorized to access.

## Verified diagnosis

- Occupancy readings exist at `devices/{deviceId}/occupancy`. In the supplied snapshot each device has a stored boolean value, but every `lastSeen` is old; therefore there are stored readings but no verified **current** occupancy readings.
- The executor already carries occupancy in telemetry rows, but the planner has no `current_occupancy` or `last_known_occupancy` focus/metric. Strict semantic validation can reject both providers before any Firebase read.
- `both providers unavailable` is also used when both model outputs are schema-valid but rejected by semantic validation. It does not necessarily mean both vendors are offline.
- The fixed `questionFocus` list cannot represent ordinary system questions such as total rooms, active overrides, assignment counts, floor-plan coverage, or many dashboard summaries.
- “Those rooms” is unsafe today because encrypted state stores the previous requested scope, not the bounded room set established by the previous answer. A model that resolves the pronoun to answer-mentioned rooms can be rejected for changing scope.
- “What are your jobs?” is routed to the static `ocu-guide` help topic, so it returns navigation steps instead of a professional capability explanation.
- The RTDB rules are not the schedule failure: approved staff/admin users may read `rooms`, and valid schedules are present under each room. Null schedule slots are safely ignorable.

## 1. Replace the brittle focus list with a bounded system-query contract

- [ ] Add a compact `SystemQueryPlan` with allowlisted `domain`, `operation`, `fields`, `scope`, `timeRange`, `outputPreference`, and `followUpReference`.
- [ ] Support domains: rooms, devices, occupancy, AC/control state, overrides, AI auto-apply, schedules, energy, decision events, floor plan, own account, admin user aggregates, app help, and assistant capabilities.
- [ ] Support operations: count, list, status, detail, compare, summarize, explain, and how-to.
- [ ] Keep specialized energy range/ranking semantics, but stop requiring a new rigid enum value for every safe system wording.
- [ ] Build a server-owned capability registry mapping domain + field + operation to role, required read, response shape, and visual compatibility.
- [ ] Give the planner only the relevant capability-registry slice; never send a full database schema or raw snapshot.
- [ ] Treat an in-system but unsupported request as a concise limitation or clarification, not generic `unsupported` or a fabricated answer.
- [ ] Keep outside knowledge, repair advice, writes, and control execution out of scope.

## 2. Use deterministic routing for simple questions

- [ ] Resolve common count/list/status/capability questions deterministically before calling a model.
- [ ] Use Gemini primarily for ambiguous semantic planning and Groq primarily for natural-language composition, with the existing reciprocal fallbacks.
- [ ] Do not require an answer model for room counts, occupancy availability, override counts, yes/no configuration, schedules, or terminal unavailable/not-found answers.
- [ ] Distinguish provider transport failure, timeout/rate limit, invalid schema, and semantic-plan rejection in sanitized logs.
- [ ] If both plans are invalid for a simple system question, return a deterministic answer or one useful clarification instead of a misleading provider-outage 503.
- [ ] Keep logs limited to request ID, stage, provider, safe category, domain, and operation; never log prompts, tokens, user text, or raw data.

## 3. Expand only the necessary read-only tools

- [ ] Extend `get_room_telemetry` with allowlisted projected fields instead of creating one tool per question.
- [ ] Support room catalog totals: total, active, inactive, assigned-device, unassigned-device, and bounded room-name lists.
- [ ] Support device summaries: assigned, available, online, stale, offline, and unavailable counts without exposing device IDs.
- [ ] Support current and explicit last-known occupancy, temperature, humidity, condition, and AC power with the existing freshness thresholds.
- [ ] Support stored control facts: `overrideActive`, safe target/expiry state, and `control/aiAutoApply`; distinguish stored configuration from confirmed device application.
- [ ] Support schedule count/list and per-room grouping from `rooms/{roomId}/schedules` without reading devices.
- [ ] Add one projected facility-summary tool only if it materially reduces reads/tokens; it must accept allowlisted sections and return aggregates, not raw roots.
- [ ] Add a bounded floor-plan summary read only if requested; if `mapLayout` is absent, answer “not configured” rather than failing.
- [ ] Add an admin-only user aggregate tool only if required for approved/pending counts; never return the users root, emails, names, or records to the model/browser.
- [ ] Reuse existing energy and recent-event tools; do not create duplicate ranking, schedule, occupancy, or override tools.
- [ ] Keep every tool GET-only, maximum four unique tools, bounded rows/bytes/ranges, and one shared deadline.

## 4. Enforce freshness and truthful system semantics

- [ ] Add first-class `current_occupancy` and `last_known_occupancy` query targets.
- [ ] A current occupancy answer may use a value only when its device is online; stale/offline `false` must not be presented as currently unoccupied.
- [ ] “Are there occupancy readings?” must distinguish field availability, current readings, and stored last-known readings.
- [ ] Last-known values require a valid timestamp and must be labeled historical with device freshness.
- [ ] Active override answers must distinguish stored active configuration, expiry, device connectivity, and confirmed application.
- [ ] Missing fields remain unknown; never coerce missing occupancy, override, power, AI state, or counts to false/zero.
- [ ] Preserve missing room, inactive room, no device, unavailable device, offline, no records, recorded zero, and read failure as distinct outcomes.

## 5. Make follow-ups refer to the answer, not only the prior request

- [ ] Extend encrypted state with a bounded `referent` containing type, sanitized room names, source turn, and whether it represents all rooms or a result subset.
- [ ] Populate the referent only from server-verified results, never from model prose.
- [ ] Resolve “those rooms,” “them,” “the first one,” “the offline rooms,” and similar references only when one verified referent is unambiguous.
- [ ] Preserve the previous requested scope separately from the previous result subset.
- [ ] If a referent is missing, expired, or ambiguous, ask one concise clarification instead of guessing or returning 503.
- [ ] Keep state UID-bound, encrypted, five-turn/two-hour/12-KiB bounded, and free of IDs, raw tool results, user records, or database paths.

## 6. Produce professional, human answers

- [ ] Answer the exact question in the first sentence; avoid repeating “OcuGuide” and generic report headings on every turn.
- [ ] Use natural wording and varied sentence structure without changing verified facts.
- [ ] Use concise prose for counts, yes/no, availability, one-room status, capabilities, and errors.
- [ ] Use bullets for short readable lists, a table for useful multi-field comparisons, and a chart only for meaningful recorded trends/rankings.
- [ ] Never show a table/chart merely because a tool ran; keep tools and safe inspection data behind the disclosure control.
- [ ] Add a dedicated assistant-capabilities response derived from the role-aware capability registry.
- [ ] “What are your jobs?” should explain that OcuGuide is a read-only OcuTemp assistant and summarize the caller’s available system domains; it must not return the “Use OcuGuide” tutorial unless the user asks how to use it.
- [ ] Do not use a fixed capability sentence as the semantic boundary; generate the summary from the current registry and role.
- [ ] Keep answers brief by default and expand only for explicit list, comparison, explanation, or report requests.

## 7. Role and RTDB-rule alignment

- [ ] Derive role/approval from the verified server-side Firebase identity profile on every request.
- [ ] Approved staff/admin may receive permitted room, device, decision-log, and floor-plan facts according to the supplied rules.
- [ ] Staff must never receive other-user information, admin-only counts, approval guidance/actions, or hidden admin routes.
- [ ] Admin user questions must return only bounded aggregates unless an existing authorized UI workflow explicitly requires more.
- [ ] Device accounts, pending staff, and unauthenticated users must not gain chat access through planner/tool selection.
- [ ] The writer must receive only minimal sanitized facts allowed for that role; authorization is never delegated to either model.
- [ ] Do not change RTDB rules or database nodes unless a later separately approved requirement proves a read is impossible.

## 8. Grounding, efficiency, and failure behavior

- [ ] Build a small typed fact packet for the requested fields only; do not send complete room/device objects to a provider.
- [ ] Validate names, values, units, timestamps, state qualifiers, counts, and room-to-value associations.
- [ ] Use deterministic formatters for simple facts and as the fallback for rejected writer output.
- [ ] Require every model-written system claim to be entailed by supplied facts; reject invented causes or capabilities.
- [ ] Cap planner prompt, facts, answer blocks, visual directives, tool disclosure, and response bytes.
- [ ] Cache per-request snapshots and derived aggregates; do not re-read the same root within one turn.
- [ ] Keep at most one main visual and no visual for missing/unavailable/permission-denied results.
- [ ] Return generic public errors while preserving a sanitized diagnostic category in server logs.

## 9. Connected file map

- [ ] Server contracts/planning: `server/chat/types/chat.types.ts`, `server/chat/tools/schema.ts`, planner prompt, and orchestrator.
- [ ] Read-only data layer: executor, energy helper, and Firebase REST client.
- [ ] Provider/error behavior: retry/provider modules and `api/chat/index.ts`.
- [ ] Conversation state: `server/chat/state.ts` and the API state handoff.
- [ ] Client contract/rendering: chat models/service, OcuGuide conversation, and report TS/HTML/CSS.
- [ ] Review-only sources: app routes; room/device/schedule/energy/user models and services; auth guards; dashboard; room details; reports; settings; user management; supplied RTDB rules/data.
- [ ] Do not modify environment/package files, RTDB rules/data, routes/sidebar, or unrelated pages unless separately approved.

## 10. Required manual acceptance

- [ ] “How many rooms are configured?” returns live total/active/inactive counts without a table or hardcoded names.
- [ ] Adding a future Room 55 automatically changes count/list/status answers without code changes.
- [ ] “Are there occupancy readings?” reports whether current readings exist and does not call stale `false` values currently unoccupied.
- [ ] “Show last-known occupancy” returns only timestamped stored values labeled historical.
- [ ] “How many active overrides are there?” returns a direct verified count; “list them” shows only authorized room-level details.
- [ ] “List the configured schedules for those rooms” uses the previous verified result subset; ambiguous context asks which rooms.
- [ ] “What are your jobs?” returns a professional role-aware capability explanation, not a help tutorial.
- [ ] Room/device/schedule/control/energy/event/floor-plan questions use the smallest necessary tool and presentation.
- [ ] Staff questions about other users are denied safely; authorized admin aggregate questions expose no identities.
- [ ] Absent `mapLayout`, missing fields, denied reads, provider failure, invalid plans, and expired context produce honest responses.

## 11. Validation restrictions

- [ ] Never add, edit, generate, or run test/spec files, fixtures, snapshots, mocks, or automated test runners.
- [ ] Validate only through static review, strict compilation, and `npm run build`; use `ng serve` only for optional manual checking.
- [ ] Confirm the final diff contains no environment, package, database, RTDB-rule, Firebase Function, extra endpoint, or unrelated change.
- [ ] Perform authenticated feature-branch Preview checks for admin and approved staff before marking behavioral items complete.

## Definition of done

- [ ] OcuGuide answers nearly all authorized OcuTemp questions representable by the capability registry, without relying on a tiny fixed sentence or help-topic list.
- [ ] Occupancy, room counts, overrides, schedules, AI configuration, energy, events, floor plan, and role-safe account questions are grounded and freshness-aware.
- [ ] Follow-ups resolve verified answer referents naturally and never fail merely because a pronoun changed the scope.
- [ ] Answers are concise, professional, question-specific, and use visuals only when materially useful.
- [ ] No unauthorized data, unsupported capability, outside knowledge, or fabricated state is presented.
- [ ] The production build passes with no automated tests run or test files created.
