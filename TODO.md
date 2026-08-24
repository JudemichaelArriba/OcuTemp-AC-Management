# TODO: OcuGuide System-Grounded Agent Remediation

## Status of this document

This remediation is implemented on the feature branch and validated by the permitted production build. An [x] marks code-complete or statically verified work; authenticated Preview and other manual acceptance items remain unchecked until they are performed.

- Implementation changed only the bounded OcuGuide client/server files listed below; no main-branch, environment, database, rules, package, test, or extra-endpoint change is included.
- The attached RTDB export is untrusted reference data used only to understand the existing shape and define manual acceptance examples.
- Do not copy, commit, seed, or hardcode values from the export.
- Environment files were excluded from remediation; the normal build script generated only the existing ignored Angular environment outputs.
- The optional one-pass refinement capability remains intentionally unchecked: the shipped pipeline uses one bounded plan and no autonomous/refinement loop.

## Product outcome

OcuGuide must behave as a constrained facility-data agent, not a general-purpose HVAC chatbot and not a report template.

It must:

- answer the exact question first;
- use only verified OcuTemp data or verified static OcuTemp help;
- say clearly when a room does not exist, a device is offline, or evidence is insufficient;
- preserve the subject, room scope, metric, and time range across short follow-ups;
- retrieve data independently from deciding whether the user needs text, a list, a table, or a chart;
- show no table or chart when a direct sentence answers the question better;
- use a table or chart only when it materially improves understanding;
- remain read-only, bounded, authenticated, and production-safe.

## Verified diagnosis of the current behavior

The implementation must address these specific causes rather than only changing prompt wording:

1. The current general intent deliberately allows broad AC and efficiency guidance without facility tools. That permits an answer such as generic energy-saving advice even when the user expects analysis based only on OcuTemp.
2. A requested room that does not exactly match an active room becomes a notice/fact, but it is not a first-class terminal outcome. The answer writer or generic fallback can bury or ignore the fact that the room is absent.
3. Current condition values can be calculated from stored temperature and humidity even when lastSeen makes the device stale or offline. An old hot value can therefore be described alongside an offline status as though it were current.
4. Tool retrieval and visual rendering are coupled. If a tool returns a presentation, the conversation renders the presentation, so a simple yes/no, count, winner, or unavailable answer can still show a full table or graph.
5. Encrypted conversation state stores only user text and a generic assistant summary. It does not preserve a typed prior query focus, room scope, energy period, or reusable tool plan. A follow-up such as “Who ranked first?” can therefore repeat the previous full report.
6. The deterministic fallback loops over presentation types and emits report summaries. It does not have a question-specific fallback for existence, current temperature, AI toggle, schedule count, schedule list, or ranking winner.
7. The answer writer receives a broad fact registry but no strict answer target requiring it to answer only the requested fact. It can restate the whole report instead of answering the follow-up naturally.

## RTDB shape that the implementation must support

The attached export confirms the existing production-shaped fields below. These are examples, not seed data and not constants.

- rooms/{roomUid}
  - roomName
  - status
  - device
  - schedules[] with day, startTime, endTime, and subject
- devices/{deviceId}
  - temperature, humidity, and occupancy
  - status/lastSeen
  - acState/power and related state
  - control/aiAutoApply
  - control/overrideActive and related control fields
  - mlSuggestion
  - energyDaily/{YYYY-MM-DD} with estimatedKwh, runtimeSeconds, sessionCount, and updatedAt
- decisionLogs/{logId}
  - roomUid, deviceId, eventType, mode, reason, applied, aiAutoApply, power, targetTemp, and updatedAt
- users/{uid}
  - must not be read for chat analysis except the already-required authenticated user's own authorization profile

The supplied snapshot currently demonstrates:

- only Room 1, Room 2, and Room 3 are configured and active;
- Room 101 is not configured;
- each configured room has schedules;
- control/aiAutoApply is available independently from current sensor freshness;
- all shown device lastSeen timestamps are old relative to the current date;
- historical estimated energy is nested under each device's energyDaily records;
- the sample 2026 coverage is temporally incomplete, with records in April, May, and July rather than continuous data for every month.

Never bake those current values into code. The application must compute every answer from the authenticated request's live bounded snapshot.

---

## 1. Replace the loose chatbot flow with a bounded facility agent

### 1.1 Use a production-safe agent pipeline

- [x] Implement one explicit bounded pipeline:

      user request
        -> semantic query planner
        -> exact entity resolution
        -> minimum read-only tool execution
        -> deterministic evidence and freshness assessment
        -> question-specific fact selection
        -> deterministic visual policy
        -> grounded natural-language writer
        -> semantic response validation
        -> typed client response

- [x] Do not implement an open-ended autonomous loop.
- [ ] Permit at most one initial plan and, only if essential evidence is missing and time remains, one bounded read-only refinement using the remaining tool budget.
- [x] Keep the existing maximum of four unique tools for the entire turn, including any refinement.
- [x] Never repeat the same tool in one turn.
- [x] Keep all writes and control actions impossible.
- [x] Stop early on terminal outcomes such as room_not_found, room_inactive, no_online_reading, no_energy_records, and source_unavailable.
- [x] Do not call the answer model when a short deterministic terminal answer is safer and more useful.

### 1.2 Give the two models distinct, narrow responsibilities

- [x] Keep Gemini as the primary semantic planner and Groq as its fallback.
- [x] Keep Groq as the primary natural-language writer and Gemini as its fallback.
- [x] Do not let either model decide whether a room exists, whether a timestamp is current, whether a rank is first, or whether records are missing; compute those facts on the server.
- [x] Require schema and semantic validation inside each provider attempt so an invalid primary response invokes the fallback.
- [x] Give the writer only the question target and a minimal curated evidence packet, not the full presentation or unrelated facts.
- [x] Use low temperature and bounded output tokens.
- [x] Preserve a targeted deterministic fallback for each question focus rather than one generic report fallback.
- [x] If both writers fail, return the targeted deterministic answer from verified facts.
- [x] If planning fails for both providers, return a safe 503 or a narrow deterministic clarification; never guess a tool plan.

---

## 2. Introduce a typed semantic query plan

### 2.1 Replace broad intent-only planning with an answer target

- [x] Add a bounded questionFocus enum covering at least:
  - room_existence
  - current_temperature
  - current_humidity
  - current_condition
  - device_status
  - ac_power_status
  - ai_auto_apply_status
  - schedule_count
  - schedule_list
  - energy_total
  - energy_rank_winner
  - energy_ranking
  - energy_trend
  - energy_report
  - facility_efficiency_analysis
  - climate_suggestion
  - recent_events
  - system_help
  - greeting
  - control_request
  - unsupported
- [x] Add structured fields for requested room names, all-rooms scope, metric, exact energy range, comparison target, requested output form, and whether the request is a follow-up.
- [x] Make the latest explicit user text override inherited context.
- [x] Reject internally contradictory plans, such as energy_rank_winner without an energy range or current_temperature with a help tool.
- [x] Require one direct answer target per turn; secondary details may support it but must not replace it.
- [x] Distinguish “give me the whole report” from “what is the total?”, “who ranked first?”, “show the ranking”, and “show the trend.”

### 2.2 Remove the outside-system advice path

- [x] Remove general as a free-world-knowledge response path.
- [x] Route generic facility questions into one of:
  - system-grounded analysis using the minimum relevant tools;
  - verified static OcuTemp help;
  - a concise scope limitation when OcuTemp has insufficient evidence.
- [x] For “How can we reduce AC energy waste?”, inspect only relevant verified system evidence such as recorded energy, runtime, schedules, occupancy, AI auto-apply configuration, device availability, and recent operational events.
- [x] Do not provide generic tips about filters, insulation, servicing, setpoints, or maintenance unless a trusted server-owned OcuTemp rule explicitly connects that advice to verified system evidence.
- [x] Do not use web search, external reference content, or unrestricted provider knowledge as a substantive answer source.
- [x] Require each recommendation to cite an internal evidence fact and an approved recommendation category.
- [x] Allow only bounded recommendation categories such as review_schedule, inspect_high_runtime_room, investigate_offline_device, review_ai_auto_apply_configuration, and collect_missing_energy_data.
- [x] Strip internal evidence IDs before returning the public response.
- [x] When evidence is insufficient, say so directly instead of filling the answer with general advice.
- [x] Keep medical, legal, dangerous electrical, refrigerant, and repair guidance outside scope.

---

## 3. Make room existence and scope resolution authoritative

### 3.1 Resolve entities before reading device or energy data

- [x] Load a bounded room catalog first and preserve active, inactive, and absent distinctions.
- [x] Normalize requested names with NFKC, trimmed whitespace, and case-insensitive exact matching.
- [x] Do not silently fuzzy-match Room 101 to Room 1 or another room.
- [x] Treat duplicate normalized room names as ambiguous and fail safely; never silently select one record.
- [x] Do not expose room UIDs or device IDs in the public answer.
- [x] Return a typed scope resolution containing requested names, matched rooms, inactive matches, and missing names.
- [x] If a single requested room is absent, stop and answer that it is not configured in OcuTemp.
- [x] If a room exists but is inactive, say that it exists but is inactive and do not describe it as missing.
- [x] If multiple requested rooms contain both matches and misses, identify the missing names briefly and answer only for verified matches.
- [x] If no requested room matches, do not read devices, energy, suggestions, or logs for that request.
- [x] For a bounded facility, optionally mention the valid active room names in a short sentence after a not-found answer; never show a table for this outcome.
- [x] Preserve the existing facility-size failure instead of returning an unbounded catalog.

### 3.2 Required Room 101 behavior

- [x] “Why is Room 101 hot?” must first resolve Room 101.
- [x] With the supplied snapshot shape, answer substantially: “Room 101 is not configured in OcuTemp. The active rooms are Room 1, Room 2, and Room 3.”
- [x] Do not discuss heat, temperature, causes, tables, charts, or suggestions after the entity-not-found outcome.
- [x] Do not hardcode that sentence or those room names; derive them from the current bounded room catalog.

---

## 4. Separate current readings from stored or stale values

### 4.1 Enforce freshness before temperature or heat-condition reasoning

- [x] Reuse the application's established device freshness thresholds consistently:
  - online: lastSeen less than 2 minutes ago;
  - stale: 2 to 5 minutes ago;
  - offline: more than 5 minutes ago or missing.
- [x] Add an explicit measurement status such as current, stale, offline, or unavailable.
- [x] Treat temperature, humidity, occupancy, AC power, and derived heat condition as current only when the device is online.
- [x] Do not compute or expose a current warm, hot, or critical condition from a stale/offline reading.
- [x] Preserve old values only as clearly labeled last-known values with their timestamp when the user explicitly asks for last-known data.
- [x] Do not mix last-known sensor values into a “current” answer or current comparison table.
- [x] Keep stored room configuration, schedules, and control/aiAutoApply separately answerable even when the device is offline.
- [x] When control/aiAutoApply is stored as enabled but the device is offline, say it is configured as enabled in OcuTemp and that current device application cannot be confirmed.

### 4.2 Required all-room current-temperature behavior

- [x] For “What is the current temperature in every room?”, include only online rooms as current readings.
- [x] If no active room has an online device, answer directly that no current temperature can be reported because no room is online.
- [x] Do not say “0 of N are online” followed by a stale heat-condition count.
- [x] Do not show a telemetry table or graph when every selected room lacks a current reading.
- [x] Offer last-known readings only as a short follow-up option, not automatically.
- [x] If some rooms are online and some are not, answer for online rooms, briefly name the unavailable count, and never display stale temperatures as current.

### 4.3 “Why is this room hot?” behavior

- [x] Apply outcome precedence in this order: room absent -> room inactive -> device not online -> current condition not hot -> current hot observation -> supported contributing evidence.
- [x] If the room is offline, say OcuGuide cannot determine whether it is currently hot.
- [x] If the room is online and hot, report the verified temperature/humidity observation first.
- [x] Never invent a cause from temperature alone.
- [x] Use schedules or recent decision events only when they provide directly relevant evidence.
- [x] Phrase unproven causes as unknown and, where useful, state what additional system evidence is missing.

---

## 5. Make tool retrieval independent from visible output

### 5.1 Add a server-validated display plan

- [x] Keep all safe typed tool results available for grounding and the existing hidden tool disclosure.
- [x] Add a separate bounded display plan to the public response rather than rendering every returned presentation.
- [x] Let the semantic planner identify the question focus, but derive and validate display mode deterministically on the server.
- [x] Support only allowlisted display modes such as:
  - none
  - compact_metrics
  - key_value
  - bullet_list
  - table
  - ranking_chart
  - trend_chart
  - full_report
- [x] Associate each visible display directive with an existing sanitized presentation ID and an allowlisted view.
- [x] Reject unknown modes, extra fields, duplicate IDs, incompatible views, and more visuals than allowed.
- [x] Default to no visual for a direct fact, yes/no state, existence result, count, winner, clarification, unavailable result, or evidence-insufficient answer.
- [x] Never render a chart with zero recorded points.
- [x] Never render an empty table merely because a tool ran.
- [x] Keep technical tool names and safe inspection data hidden behind “Show tools used,” even when the main answer has no visual.
- [x] Do not add another API endpoint to lazily fetch tool results.

### 5.2 Deterministic visual-selection matrix

| User's actual question | Default main response | Visual rule |
|---|---|---|
| Does this room exist? | One direct sentence | None |
| Is the device online? | One direct sentence | None |
| What is Room 1's temperature? | One value plus freshness | None |
| Is AI auto-apply on for Room 1? | Yes/no configuration sentence | None |
| How many schedules does Room 2 have? | Count sentence | None |
| List Room 2's schedules | Short bullets | No table |
| List schedules for every room | Summary plus compact schedule table | Table |
| What is the yearly total? | Total, coverage, and period | Compact metrics; no chart by default |
| Who ranked first? | Winner, estimated value, period | None |
| Show the room ranking | Ranked comparison | Table or ranking chart when multiple recorded rooms |
| Show the trend over the year | Trend conclusion | Trend chart when recorded points exist |
| Give me the full yearly energy report | Summary and useful report view | One default chart; detailed table available when useful |
| Compare current temperatures in every room | Brief comparison | Table only when at least two current online readings exist |
| No room is online / no records / room missing | Honest unavailable/not-found sentence | None |
| Analyze system energy waste | Evidence-backed findings and actions | Visual only when a comparison/trend materially supports a finding |

- [x] Honor an explicit “text only,” “no table,” “show table,” or “show graph” request when the requested view is compatible with available data.
- [x] Cap the default answer to one main visual; do not automatically show both ranking and trend charts.
- [x] Keep accessible tabular fallback data for a chart without duplicating a large visible table.

---

## 6. Answer the requested fact instead of restating a report

### 6.1 Build a minimal question-specific evidence packet

- [x] After tool execution, create a typed AnswerPacket containing:
  - questionFocus;
  - resolved room scope;
  - resolved time range;
  - answerability outcome;
  - freshness outcome;
  - only the facts needed for the requested answer;
  - partial/unavailable notices;
  - the validated display plan.
- [x] Do not send unrelated room rows, schedules, events, or report facts to the writer.
- [x] For energy_rank_winner, select only the rank-one fact, relevant tie facts, range, coverage, and estimation caveat.
- [x] For ai_auto_apply_status, select only matched room configuration state and device freshness qualifier.
- [x] For schedule_count, select only counts and matched scope.
- [x] For schedule_list, select only the requested schedules.
- [x] For current_temperature, select only current online readings and unavailable-room count.
- [x] For facility_efficiency_analysis, select only evidence that supports a finding or explains why no recommendation is possible.

### 6.2 Require focus-specific answer validation

- [x] Validate that the direct answer satisfies the question focus before accepting it.
- [x] Require a room-not-found answer to explicitly say the requested room is not configured or not found.
- [x] Require a current-temperature answer to avoid stale values and state when no current readings exist.
- [x] Require a ranking-winner answer to identify rank one, handle ties, include the inherited period, and avoid summarizing the whole report.
- [x] Require schedule counts to match parsed valid schedules.
- [x] Require AI auto-apply answers to distinguish configured state from confirmed device behavior.
- [x] Require every facility recommendation and comparison claim to be entailed by cited evidence.
- [x] Reject generic filler, repeated report summaries, unsupported causes, irrelevant caveats, and references to a table/chart that is not displayed.
- [x] Normalize prose without forcing every answer into the same headline/summary template.
- [x] Keep answers concise by default, expanding only when the question asks for a report, explanation, list, or comparison.

### 6.3 Use targeted deterministic fallbacks

- [x] Replace the presentation-loop fallback with focus-specific safe formatters.
- [x] Provide dedicated fallback formatters for not found, inactive room, no online readings, one current value, toggle state, schedule count, schedule list, energy total, ranking winner/tie, ranking list, trend, no records, and insufficient evidence.
- [x] Ensure a fallback for “Who ranked first?” cannot return the same full-report summary.
- [x] Preserve natural grammar, singular/plural forms, dates, units, and Manila time.

---

## 7. Preserve structured context for natural follow-ups

### 7.1 Upgrade bounded encrypted conversation state

- [x] Keep the state JWE encrypted, UID-bound, capped at 12 KiB, limited to five turns, and limited to two hours.
- [x] Store a compact sanitized structured context instead of relying only on the assistant summary.
- [x] Include only these structured context fields (in addition to the bounded sanitized turn text):
  - prior questionFocus;
  - resolved room names or all-room scope;
  - prior metric;
  - resolved energy preset/custom dates and bucket;
  - prior tool names;
  - answerability outcome;
  - whether a visual was shown.
- [x] Do not store full tool results, room/device IDs, database paths, raw logs, full presentations, provider output, or credentials.
- [x] Version the state contract and handle old/expired state safely.
- [x] Re-run the necessary read-only tool for fresh truth rather than trusting an old result value.
- [x] Resolve pronouns and ellipsis only when the stored typed context is unambiguous.
- [x] Ask one concise clarification when multiple prior scopes could match.

### 7.2 Required ranking follow-up behavior

- [x] After “Give me the whole-year energy report,” store the resolved year, bucket, and room scope.
- [x] For the follow-up “Who ranked first?”, inherit that exact energy scope and change questionFocus to energy_rank_winner.
- [x] Re-run one bounded energy report for that inherited scope.
- [x] Answer only the winner/tie, estimated kWh, and period.
- [x] Do not repeat the previous graph, table, total summary, or generic report wording.
- [x] If the inherited report has no recorded rooms, say no ranking can be determined.
- [x] If context has expired or there are multiple possible reports, ask which period rather than guessing.

---

## 8. Fully support AI toggle and schedule questions

### 8.1 AI auto-apply state

- [x] Route “Is the AI toggle on?”, “Which rooms have AI enabled?”, and equivalent wording to get_room_telemetry.
- [x] Read only devices/{deviceId}/control/aiAutoApply through the existing bounded device snapshot.
- [x] Treat control/aiAutoApply as the authoritative toggle value; never replace it with the older mlSuggestion/autoApplyEnabled field.
- [x] For one room, answer in one sentence with no table.
- [x] For all rooms when every state is the same, summarize that shared state in text.
- [x] Use a compact table only when the user asks for a per-room list or when states differ and comparison is useful.
- [x] Return unknown when the field is missing; never coerce missing to false.
- [x] If the device is offline, label the value as OcuTemp's stored configuration and do not claim the device is currently applying it.

### 8.2 Schedule count and schedule list

- [x] Route schedule count/list questions to get_room_telemetry; do not add a duplicate schedule tool.
- [x] Parse only valid schedules with recognized day, HH:mm times, start before end, and bounded sanitized subject.
- [x] “How many schedules does Room 2 have?” returns only the verified count unless details were requested.
- [x] “What schedules does Room 2 have?” returns a readable ordered bullet list with day, time range, and subject.
- [x] “List every room's schedules” may use one compact table grouped by room.
- [x] Sort schedules by weekday, start time, end time, and then sanitized subject for deterministic human-readable output.
- [x] Distinguish no configured schedules from unavailable room data.
- [x] Never call configured schedules “currently active” unless current Manila day/time is evaluated and the device state confirms applicability.
- [x] Treat schedule subjects as untrusted text and never as model instructions.
- [x] Keep the existing maximum schedule and room caps.

---

## 9. System-bound energy analysis

### 9.1 Evidence requirements

- [x] Never infer consumption from AC power, temperature, schedules, or device uptime when energy records are absent.
- [x] Never display a zero total or zero chart when the selected device/range has no energyDaily records.
- [x] Use recorded energy totals, runtime, sessions, coverage, and valid decision events only for the requested exact range.
- [x] Do not correlate a current occupancy reading, a weekly schedule, or an old decision event with historical energy unless their time ranges actually overlap and the relationship is explicitly supported.
- [x] Separate recorded zero, no records, no assigned device, offline device, and read failure.
- [x] Require meaningful coverage before making a facility-wide comparison or recommendation and state partial coverage plainly.
- [x] Handle equal top values as a tie rather than arbitrarily naming one winner.
- [x] Do not calculate cost unless a trusted bounded tariff exists in the current server contract; none should be assumed.
- [x] Keep energy values labeled estimated and not billing-grade.
- [x] Track per-bucket record availability so a month/day/week with no records is a gap, not a measured zero.
- [x] Render chart gaps for missing intervals and keep recorded zero as a separate explicit state.
- [x] Report temporal coverage for a long range instead of implying that sparse records cover the full period continuously.

### 9.2 Advice behavior with partial or insufficient evidence

- [x] With the supplied snapshot shape, “How can we reduce AC energy waste?” must use the partial stored 2026 energyDaily evidence and must not generate generic outside-system recommendations.
- [x] A valid focused answer may identify Room 1 as the first place to review because it has the largest recorded share, while clearly stating that the devices are currently offline and the year has incomplete temporal coverage.
- [x] It may correlate verified energy, runtime, schedules, AI auto-apply configuration, and decision events only when the time/scope relationship is supported; it must not claim those configurations caused waste without evidence.
- [x] If the requested range has no usable records, say that OcuGuide lacks recorded evidence for a facility-specific waste analysis.
- [x] It may offer to summarize verified schedules or AI auto-apply configuration as configuration facts, but must not claim those configurations are wasting energy.
- [x] Do not show a chart or table for an evidence-insufficient answer.
- [x] Do not hardcode this outcome; recompute it from the live authenticated snapshot.

---

## 10. Client response and presentation behavior

### 10.1 Keep text primary

- [x] Render the direct answer before any supporting visual.
- [x] Render only presentations selected by the validated display plan.
- [x] Keep all technical tool names and safe result inspection behind the existing per-turn disclosure.
- [x] Preserve a tool-disclosure control even for a text-only answer that used a tool.
- [x] Do not render a report placeholder, chart canvas, table header, pagination, or evidence skeleton when display mode is none.
- [x] Do not show “Facility data” wording on a pure help/scope response.
- [x] Keep unavailable/not-found messages visually simple and prominent.
- [x] Avoid duplicate answer text in summary, block, highlight, metric, and report title.
- [x] Keep follow-up suggestions tied to the actual answerability outcome and question focus.
- [x] Do not suggest comparing, ranking, or graphing unavailable data.
- [x] Replace general-knowledge starter prompts with system-grounded examples for room status, energy, AI auto-apply, schedules, and verified OcuTemp help.

### 10.2 Keep visuals accessible and efficient

- [x] Preserve semantic tables, captions, keyboard scrolling, chart fallback data, and turn-scoped DOM IDs.
- [x] Create Chart.js instances only for display-plan-selected charts near the viewport.
- [x] Destroy charts when deselected, out of view, or the component is destroyed.
- [x] Keep null/unavailable rows last when sorting.
- [x] Keep text wrapping safe for untrusted room names, subjects, event details, and stored reasons.
- [x] Preserve OnPush, signals, stable tracking keys, scroll pinning, focus restoration, reduced motion, and component style budgets.
- [x] Do not add a markdown, table, chart, or agent framework dependency.

---

## 11. Security, reliability, and production bounds

- [x] Keep the single POST /api/chat endpoint and one Vercel Serverless Function.
- [x] Do not add Firebase Functions, another API, database writes, database fields, database migrations, or Security Rule changes.
- [x] Keep Firebase identity, approval, and role derived on the server.
- [x] Keep exact origin validation, JSON-only requests, 500-code-point input cap, body cap, response cap, state cap, room cap, range cap, and read cap.
- [x] Keep pre-auth IP, UID, facility, and concurrency limits on every path.
- [x] Keep the shared abort signal and 20-second internal deadline across state, planning, reads, writing, and any bounded refinement.
- [x] Because optional refinement is not implemented, no refinement path can consume the remaining deadline.
- [x] Keep Firebase REST GET-only with root/path/query allowlists.
- [x] Never send or expose the users root, credentials, provider keys, bearer tokens, Firebase URLs/paths, internal IDs, prompts, stack traces, or raw snapshots.
- [x] Redact user/stored text before provider transmission and sanitize it again before rendering.
- [x] Treat user content, state content, room names, schedules, decision logs, and model output as untrusted.
- [x] Keep public errors generic while logging only sanitized request ID, stage, focus, provider category, and failure category.
- [x] Bound the AnswerPacket, display plan, structured state, model facts, output blocks, tool disclosure, and response bytes.
- [x] Preserve provider fallback and deadline failures as safe 503 responses.
- [x] Do not add new packages.

---

## 12. Exact implementation file map

### 12.1 Server files expected to change

- [x] server/chat/types/chat.types.ts
  - Add question focus, scope resolution, answerability, freshness, display plan, AnswerPacket, and structured-state types.
  - Keep internal grounding types separate from the public response.
- [x] server/chat/tools/schema.ts
  - Replace broad intent-only output with the bounded semantic query plan.
  - Add closed schemas for display-compatible answer targets and system-grounded recommendations.
- [x] server/chat/prompts/planner.prompt.ts
  - Teach exact question focuses, entity-first behavior, inherited range/scope, system-only advice, and visual-request semantics.
- [x] server/chat/prompts/answerer.prompt.ts
  - Require direct focus-specific answers from the minimal AnswerPacket.
  - Prohibit generic advice, report repetition, unsupported causes, and irrelevant visuals.
- [x] server/chat/prompts/general-answer.prompt.ts
  - Remove it from the free-world-knowledge path or retire it entirely; do not leave a bypass that can generate outside-system advice.
- [x] server/chat/orchestrator.ts
  - Implement the bounded agent pipeline, outcome precedence, fact selection, display policy, targeted writer validation, and targeted fallbacks.
- [x] server/chat/tools/executor.ts
  - Preserve full room catalog status for entity resolution.
  - Separate current sensor fields from stored configuration.
  - Return typed matched/missing scope, freshness, toggle, and valid schedule facts.
  - Stop unnecessary reads after a terminal scope outcome.
- [x] server/chat/tools/energy.ts
  - Preserve exact ranges, ties, rank-one selection, no-record semantics, and question-focused energy facts.
- [x] server/chat/state.ts
  - Version and validate compact structured follow-up context within the existing JWE bounds.
- [x] api/chat/index.ts
  - Store the new compact context and return the validated display plan without adding an endpoint.

### 12.2 Client files expected to change

- [x] src/app/models/chat.models.ts
  - Mirror the new public answer, display-plan, freshness, and state-independent presentation contract.
- [x] src/app/services/chat.service.ts
  - Deeply validate the closed response, compatible display modes, presentation references, and question-specific null semantics.
- [x] src/app/pages/ocu-guide/ocu-guide-conversation.ts
  - Add display-plan helpers and focus-aware follow-up suggestions while preserving abort, scroll, focus, and disclosure state.
- [x] src/app/pages/ocu-guide/ocu-guide-conversation.html
  - Render only selected visuals and preserve text-only tool-backed turns.
- [x] src/app/components/ocu-guide-report/ocu-guide-report.ts
  - Accept the validated selected view instead of exposing every report view automatically.
- [x] src/app/components/ocu-guide-report/ocu-guide-report.html
  - Add compact AI-toggle and schedule-specific views where needed and suppress irrelevant columns/views.
- [x] src/app/pages/ocu-guide/ocu-guide-conversation.css and src/app/components/ocu-guide-report/ocu-guide-report.css
  - Change only if required for the selective views; keep Tailwind primary and each component below 8 kB.

### 12.3 Existing files to review and change only if required

- [x] server/chat/firebase-rest.ts
  - Verify existing bounded reads can support entity-first room catalog resolution; do not broaden allowed roots.
- [x] server/chat/retry.ts and server/chat/providers/provider.interface.ts
  - Verify semantic validation still occurs inside each provider attempt.
- [x] server/chat/providers/gemini.provider.ts and server/chat/providers/groq.provider.ts
  - Reuse the configured models and bounded options; no model/provider expansion.
- [x] src/app/services/device.service.ts
  - Reuse its online/stale/offline thresholds as the client behavior reference; avoid divergent semantics.
- [x] src/app/helpers/room-validation.ts and src/app/models/room.model.ts
  - Reuse schedule validation and shape semantics; do not create a conflicting format.
- [x] server/chat/config.ts, server/chat/middleware/auth.ts, server/chat/middleware/rate-limit.ts, and server/chat/middleware/validate-request.ts
  - Regression-review only; preserve the current security boundary.
- [x] vercel.json, tsconfig.api.json, package.json, app routes, and sidebar navigation
  - Verify no change is necessary.

### 12.4 Files explicitly outside this remediation

- [x] Do not change any environment file or .env file.
- [x] Do not add or modify Firebase rules.
- [x] Do not add or modify database data.
- [x] Do not add Firebase Functions.
- [x] Do not create another API route.
- [x] Do not add dependencies.
- [x] Do not commit the attached RTDB export.

---

## 13. Implementation sequence

- [x] Phase 1: Lock the semantic query, scope resolution, freshness, AnswerPacket, display-plan, and compact-state contracts.
- [x] Phase 2: Implement entity-first resolution and terminal outcomes.
- [x] Phase 3: Enforce current-versus-stale telemetry and configuration-versus-device behavior.
- [x] Phase 4: Replace outside-system general advice with evidence-bound facility analysis.
- [x] Phase 5: Add focus-specific evidence selection, writer validation, and deterministic fallbacks.
- [x] Phase 6: Add structured follow-up inheritance for range, room scope, metric, and answer focus.
- [x] Phase 7: Decouple tool results from visible tables/charts and implement deterministic display policy.
- [x] Phase 8: Add concise AI-toggle and schedule answers/views.
- [x] Phase 9: Deeply align client validation, rendering, disclosure, accessibility, and chart lifecycle.
- [x] Phase 10: Perform full static review and the permitted production build without tests.

---

## 14. Manual acceptance checklist

The attached snapshot is a reference fixture for these expectations only. Do not install it, seed it, or hardcode it.

### 14.1 Entity and freshness cases

- [ ] “Why is Room 101 hot?” says Room 101 is not configured, optionally names the bounded valid rooms, and shows no visual.
- [ ] “Why is Room 3 hot?” while Room 3 is offline says its current condition cannot be determined; an old stored value is not called current.
- [ ] “What is the current temperature in every room?” with all three devices offline says no current readings are available and shows no table/chart.
- [ ] The same all-room question with two online rooms and one offline room shows only the two current readings and identifies one unavailable room.
- [ ] “Show last-known temperatures” clearly labels every value and timestamp as last known.

### 14.2 AI toggle and schedules

- [ ] “Is AI auto-apply on in Room 1?” gives a direct configured-state answer with no table.
- [ ] If Room 1 is offline, the answer does not claim the setting is currently being applied by the device.
- [ ] A conflicting older mlSuggestion/autoApplyEnabled value never overrides control/aiAutoApply.
- [ ] “Which rooms have AI auto-apply on?” summarizes a common state in text and uses a table only when a per-room comparison is useful or requested.
- [ ] “How many schedules does Room 2 have?” returns 2 for the supplied snapshot shape and no table.
- [ ] “How many schedules are configured?” returns 4 across the 3 active rooms for the supplied snapshot shape and no full telemetry table.
- [ ] “List Room 2's schedules” returns two readable schedule items with day/time/subject and no telemetry columns.
- [ ] “List every room's schedules” uses one compact schedule table, not the full telemetry table.

### 14.3 Energy and follow-ups

- [ ] “How can we reduce AC energy waste?” uses only the snapshot's partial stored energy/configuration evidence, prioritizes the highest recorded consumer when useful, states the offline/incomplete-data limitations, and gives no generic outside-system advice.
- [ ] A facility-specific recommendation appears only when each recommendation is backed by current/stored OcuTemp evidence.
- [ ] “Give me the whole-year energy report” may show one useful chart when recorded data exists.
- [ ] With the supplied snapshot, the 2026 report treats April, May, and July as recorded periods and the unrecorded months as gaps rather than zero-consumption months.
- [ ] The immediate follow-up “Who ranked first?” inherits that year and room scope, returns only the winner/tie and value, and does not repeat the report visual.
- [ ] With the supplied snapshot, that follow-up identifies Room 1 at approximately 11.451 estimated kWh and 63.7% of the recorded total, while retaining the partial-coverage qualifier.
- [ ] “Show the full ranking” uses a table or bar chart when multiple recorded rooms exist.
- [ ] “Show the yearly trend” uses a line chart only when recorded points exist.
- [ ] No energyDaily records in the selected range produces no zero-total chart and no ranking claim.
- [ ] Equal first-place values produce a tie answer.

### 14.4 Natural answer and visual behavior

- [ ] Existence, yes/no, single-value, count, winner, unavailable, and insufficient-evidence questions default to text only.
- [ ] List questions use bullets for one room and a table only for useful multi-room structure.
- [ ] Comparison questions use the smallest useful table or chart.
- [ ] Explicit “text only,” “no table,” “show table,” and “show graph” requests are honored when compatible with evidence.
- [ ] Different questions over the same tool result produce different focused answers.
- [ ] No answer repeats the same generic report paragraph solely because the same tool ran.
- [ ] Technical tools/results remain hidden until “Show tools used” is activated.
- [ ] Tool-backed text-only turns still expose the hidden disclosure control.
- [ ] No empty chart, table, pagination, or report shell is rendered.

### 14.5 Security and resilience

- [ ] Missing, inactive, offline, no-record, zero-recorded, and read-failure states remain distinct.
- [ ] Prompt injection in user text, stored names, schedule subjects, or decision-log fields cannot alter permissions or instructions.
- [ ] The browser and providers never receive credentials, internal paths, raw snapshots, user records, or unneeded facts.
- [ ] State tampering, expiry, cross-user reuse, malformed plans, incompatible display modes, and oversized responses fail closed.
- [ ] Both provider fallback directions preserve the same semantic and grounding rules.
- [ ] Dual provider failure returns a safe targeted fallback or 503 without fabricated data.
- [ ] Rate, concurrency, facility, read, deadline, and response bounds still apply to every question focus.

---

## 15. Validation rules: unchanged

- [x] Never create, add, modify, generate, or rename a test/spec file.
- [x] Never run npm test, ng test, Vitest, Jest, Karma, or any automated test runner.
- [x] Do not add fixtures, snapshots, mocks, or test-only utilities.
- [x] Validate implementation through careful code review, strict existing compilation, and npm run build.
- [x] Use ng serve only for optional manual browser checking.
- [x] Do not change application code merely to make a test harness possible.
- [x] Confirm git diff contains no test-file, environment-file, database-rule, database-data, dependency, or extra-endpoint change.
- [ ] Perform the manual acceptance cases above in the authenticated feature-branch Preview when deployment configuration is available.

---

## Definition of done

- [ ] A nonexistent room is identified before any climate reasoning.
- [ ] Offline/stale readings are never presented as current or used for a current hot-condition claim.
- [ ] Efficiency advice is based only on verified OcuTemp evidence, or the assistant says evidence is insufficient.
- [ ] A short follow-up inherits the correct room/range/metric and answers the new question rather than repeating the prior report.
- [ ] AI auto-apply and schedule count/list questions receive concise, correct, configuration-aware answers.
- [ ] Tables and charts appear only when the validated question focus and available data justify them.
- [ ] Every facility claim remains grounded, every tool remains read-only, and all current security/boundary limits remain intact.
- [x] The production build passes with no test files created and no automated tests run.
