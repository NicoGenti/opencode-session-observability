# Session health

Session health is a **derived signal** computed in `src/core/health.ts` from the `Analysis` that `ObservabilityService.analyze` already produces (totals, turns, compactions, diagnostics, capabilities, coverage). It is **not a quality judgment** of the session and never a numeric score: its state is one of three words — **healthy**, **watch**, **degraded** — and every rule that produced it is returned alongside it in `analysis.health`. The UI renders the DTO; it never re-derives and never re-fetches.

Standing disclaimer (carried on the badge, the breakdown header and footer, and `analysis.health` consumers):

> Derived signal from recorded observability data — not a quality judgment.

No new metric, storage, endpoint or query parameter is added; the health DTO rides inside the existing `Analysis` payload, so `/api/sessions/:id/analysis`, the plugin RPC `analysis`, and JSON export pick it up without code changes.

## States and mapping

| State | Meaning |
|---|---|
| `healthy` | No rule triggered and the session data is sufficient. |
| `watch` | Exactly one watch-level rule triggered, or the session data is insufficient. |
| `degraded` | Any strong trigger, or at least two watch triggers. |

Mapping rule (single documented rule, in `evaluateSessionHealth`):

1. Run all seven rules → collect watch/strong triggers.
2. Compute the sufficiency gate (below).
3. `strong > 0` or `watch >= 2` → `degraded`.
4. Otherwise `insufficient || watch === 1` → `watch`.
5. Otherwise → `healthy`.

Insufficiency forces `watch`, never `healthy` or `degraded` on its own: a thin or windowed session may not claim a healthy state. Real triggered evidence (a strong trigger, or two or more watch triggers) may still escalate an insufficient session to `degraded` — **only the `healthy` claim is blocked**. Insufficient sessions render as `watch` with an explicit **insufficient data** sub-label in the UI.

## Sufficiency gate

The gate lives in `insufficiencyReasons()` in `src/core/health.ts`. `insufficient` is `true` when at least one of these holds:

| Reason string | Condition |
|---|---|
| `no turns were recorded` | `analysis.totals.turns === 0` |
| `the analysis covers a window, not the full session` | `analysis.coverage.complete === false` |
| `neither token usage nor cost was recorded` | `analysis.capabilities.tokenUsage === false && analysis.capabilities.cost === false` |

Token usage alone, or cost alone, keeps a session evaluable; only the absence of **both** blocks sufficiency. Windowed analyses (where the web client sends `fromSeq`/`toSeq`) are scoped and therefore report insufficient rather than claiming session health.

No rule can by itself create insufficiency: the gate is session-global, taken from `totals.turns`, `coverage.complete` and the `tokenUsage`/`cost` capabilities.

## Rule set

Seven rules, exported as `HEALTH_RULES` (frozen) in `src/core/health.ts`. Each returns a `HealthRuleResult { id, label, triggered, level, evaluable, note, eventIDs[], turnIDs[] }`. `triggered` is `level !== null`. `level` is `"watch" | "strong" | null`.

Link caps apply to every rule: `MAX_EVENT_LINKS = 10` events and `MAX_TURN_LINKS = 6` turns, de-duplicated, empty ids dropped, in recorded order. These caps are mirrored in the UI (`src/web/lib/health.ts`) so they also hold on a hostile payload.

### `error-rate`

- **Label:** Error rate
- **Inputs:** `analysis.totals.errors.total` (`ErrorCounts`), `analysis.totals.steps` (work denominator); drill events from `analysis.events` where `flags.error`.
- **Formula:** `rate = totals.errors.total / totals.steps`
- **Thresholds:** watch when `rate >= 0.25` **and** `errors >= 4`; strong when `rate >= 0.60` **and** `errors >= 6`.
- **Not evaluable:** when `totals.steps === 0` → note `no steps were recorded`.
- **Drill targets:** first 10 event ids with `flags.error` (`eventIDs`).
- **Contributes to insufficient:** no.

### `retry-count`

- **Label:** Retry count
- **Inputs:** `analysis.totals.retries`; drill events from `analysis.events` with `kind === "retry"`.
- **Formula:** `totals.retries`
- **Thresholds:** watch when `retries >= 8`; strong when `retries >= 15`.
- **Not evaluable:** never (the count is always available; zero is a count, not missing data).
- **Drill targets:** first 10 `kind === "retry"` event ids (`eventIDs`).
- **Contributes to insufficient:** no.

### `tool-failure-recurrence`

- **Label:** Tool-failure recurrence
- **Inputs:** `analysis.diagnostics?.incidents ?? []` (absent diagnostics yield no incidents, `src/core/service.ts`). Per incident: `attempts` and `firstFailureEventID` (`src/core/diagnostics.ts`).
- **Formula:** `incidents = incidents.length`; `maxAttempts = max(incident.attempts)` (0 when none).
- **Thresholds:** watch when `incidents >= 4` **or** `maxAttempts >= 5`; strong when `incidents >= 7` **or** `maxAttempts >= 9`.
- **Not evaluable:** never (absent diagnostics is a valid empty incident set).
- **Drill targets:** each incident's `firstFailureEventID` (`eventIDs`). Jumping also lights the incident highlight via `applyIncidentHighlight` in the UI.
- **Contributes to insufficient:** no (diagnostic absence is not an insufficiency reason).

### `context-growth`

- **Label:** Context growth
- **Inputs:** `turn.contextDelta.value` (`src/core/project.ts`), `analysis.compactions` (`turnID`/`timestamp`), `analysis.totals.finalContext.value`.
- **Formula:** longest run of consecutive turns where `contextDelta.value > 0`. An unavailable (`null`) or non-positive delta ends the run; a compaction whose `turnID` equals the previous or next turn, or whose `timestamp` falls strictly after the previous turn's end and up to the next turn's end, ends the run at the preceding turn; a compaction owned by a turn ends the run that includes that turn.
- **Thresholds:** watch when `run >= 5` **and** `finalContext >= 150_000`; strong when `run >= 8` **and** `finalContext >= 250_000`.
- **Not evaluable:** when fewer than 2 turns have an available delta (`note: "<n> turn(s) recorded a context delta; at least 2 are required"`), or when `totals.finalContext.value === null` (`note: "final context size was not recorded"`).
- **Drill targets:** first and last turn of the run, as turn ids (`turnIDs` → resolved by the UI to each turn's `trigger.eventID ?? eventIDs[0]`).
- **Contributes to insufficient:** no.

Note: the first turn has no context delta by construction, so a session must have at least 2 turns with recorded deltas before this rule can fire.

### `cost-per-turn`

- **Label:** Cost per turn
- **Inputs:** `analysis.totals.cost.value` (sums steps + compactions), `analysis.totals.turns`, plus per-turn `cost.value` for drill targets.
- **Formula:** `perTurn = totals.cost.value / totals.turns`
- **Thresholds:** watch when `perTurn >= 2.00` USD/turn; strong when `perTurn >= 10.00` USD/turn.
- **Not evaluable:** when `totals.cost.value` is `null` (`note: "cost was not recorded"`) or `totals.turns < 2` (`note: "<n> turn(s) recorded; at least 2 are required"`).
- **Drill targets:** the 3 costliest turns with a recorded cost, descending, ties resolved by recorded turn order (`turnIDs` → resolved by the UI to event ids).
- **Contributes to insufficient:** no.

### `low-cache-hit`

- **Label:** Low cache hit rate
- **Inputs:** per-turn `cacheHitRate.value` (`src/core/metrics.ts`).
- **Formula:** `available` = turns with a non-null `cacheHitRate.value`; `low` = those where the value is `< 0.20`; `share = low / available`.
- **Thresholds:** watch when `low >= 5` **and** `share >= 0.60`; strong when `low >= 9` **and** `share >= 0.80`.
- **Not evaluable:** when no turn has an available cache hit rate (`note: "no turn recorded a cache hit rate"`).
- **Drill targets:** the first 6 low-hit turns (`turnIDs` → resolved by the UI to event ids).
- **Contributes to insufficient:** no.

### `unfinished-outcome`

- **Label:** Unfinished outcome
- **Inputs:** `analysis.session.outcome` (defaulted to `null`), last turn's `status` (`turnStatus`, `src/core/project.ts`), plus `analysis.events` with `kind === "idle"` and status `failed`/`interrupted`.
- **Formula:** watch when `outcome === "interrupted"` **or** `lastStatus ∈ {interrupted, incomplete}`; strong when `outcome === "failed"` **or** `lastStatus === "error"`. `running` never triggers — an in-flight session is not unhealthy.
- **Not evaluable:** never (missing outcome/last turn renders as `null`/`"no turns"`, not unavailable).
- **Drill targets:** the last turn's anchor (`last.trigger.eventID ?? last.eventIDs[0]`), followed by failed/interrupted `idle` event ids, capped at `MAX_EVENT_LINKS` (`eventIDs`).
- **Contributes to insufficient:** no.

## Drill targets and caps

- Event links carry `data-event-id` and are routed by the shared event-drill handler (`openEvent` in `src/web/App.tsx`), opening the Trajectory view centered on the event. No new wiring.
- Turn links carry `turnIDs`; the UI (`src/web/lib/health.ts`, `ruleLinksHtml`) resolves each turn to `turn.trigger.eventID ?? turn.eventIDs[0]` and renders **only** when an anchor exists. An anchor-less id is never rendered.
- Caps: `MAX_EVENT_LINKS = 10`, `MAX_TURN_LINKS = 6`, enforced in core and re-enforced in the UI.
- `tool-failure-recurrence` links open the failing event and, via `applyIncidentHighlight`, highlight every event in the incident's `failureEventIDs`.

## Insufficient-data rendering

When `insufficient` is `true`, `state` is still `watch` and the UI shows the badge as **Session health: Watch** with an **insufficient data** sub-label and the dashed uncertain treatment (`.health-badge-insufficient`). The breakdown lists the sufficiency reasons on top, then every rule with its level, status, observed value and drill links. Missing `analysis.health` (older payloads) renders via `missingHealth()` as `watch` + `insufficient data`, never `healthy`.

## Error-rate denominator

The `error-rate` rule divides by `totals.steps` — **all recorded steps**, not completed-only. A completed-only denominator would double-count errored steps in the denominator, and `totals.steps` is the already-exposed work denominator. This is a deliberate deviation from the issue phrasing "relative to completed steps" and is documented here rather than hidden.

## Naming distinction

`analysis.health` (session health) must not be confused with:

- `/api/health` (`src/server/http.ts`) — server liveness probe;
- the plugin RPC `health` (`test/plugin.test.ts`).

UI copy always says **Session health**, so the two are never visually confused. The badge never uses the word "score".

## Recommendations are not health

`analysis.recommendations` ([RECOMMENDATIONS.md](RECOMMENDATIONS.md)) is a separate rider. It may restate a triggered health rule as a fact row, but it never changes the health verdict, never adds a rule to `HEALTH_RULES`, and health never reads it. Recommendations carry no state, no level and no score — only `severity: "info" | "advisory"` — and they are attached after health in `loadDataset`. Tuning a health threshold does not tune a recommendation bound, and vice versa.

## Guardrails

Guardrails are a **separate, advisory layer**: a budget the user chooses to track, evaluated from the same `Analysis` by the pure `evaluateGuardrails(analysis, thresholds)` in `src/core/guardrails.ts`. They are never health rules and never change `analysis.health`.

- **Ownership** — thresholds live in the browser's per-user settings store (`src/web/lib/settings.ts`, key `observability-guardrails`); the server keeps no configuration and no mutable state. The browser appends six bounded GET parameters to the analysis request and the server validates them: `gr.tokensTotal`, `gr.costTotal`, `gr.contextRun`, `gr.retries`, `gr.toolFailures`, `gr.elapsedMinutes`. A present value must be finite and `>= 0`; `gr.elapsedMinutes` is capped at `100000` and the others at `1e12`. A malformed, negative, overflowing or unknown `gr.*` key answers `400 invalid_guardrails` (closed vocabulary). Absent keys fall back to `DEFAULT_GUARDRAILS`.
- **Response shape** — `guardrails` is a **route-level sibling** of `analysis` (`{ analysis, guardrails, revealAllowed }`), never an `Analysis` field, so exports and the plugin RPC keep their shape. A request without any `gr.*` parameter answers exactly as before and carries no `guardrails` key.
- **Budgets and defaults** — `tokensTotal` 2,000,000 total recorded tokens; `costTotal` $5.00 recorded cost; `contextRun` 6 consecutive context-increase turns; `retries` 10 retry events; `toolFailures` 5 diagnostics incidents; `elapsedMinutes` 60 minutes from the first to the last recorded event. A budget triggers at `observed >= threshold`.
- **Observations and basis** — every warning carries `basis: "derived"`, a deterministic phrase with the measured numbers, the threshold it crossed and capped `eventIDs`/`turnIDs` (`MAX_EVENT_LINKS` / `MAX_TURN_LINKS`, the same caps as health).
- **Skipped, never guessed** — `elapsed-minutes` is evaluable only when `coverage.complete` is true, because a windowed analysis does not bound the whole session; the token budget needs recorded usage, the cost budget a recorded cost, and the context budget at least two recorded context deltas. A budget that cannot be evaluated is returned in `skipped` with a note instead of a warning.
- **Advisory only** — every row carries `advisory: true`; nothing in this layer blocks a request, interrupts a session or prompts the user, and the server stays GET/HEAD-only.
- **TUI** — the native statistics panel evaluates its own copy of the defaults (`DEFAULT_GUARDRAILS`) because browser thresholds are localStorage state that never crosses the RPC; it shows only the count, labelled `Guardrails (defaults): N advisory`.

The frozen `HEALTH_RULES` object and its values are unchanged. `evaluateSessionHealth` now takes an optional `HealthThresholds` object whose default **is** `HEALTH_RULES`, so `loadDataset` and every existing verdict stay byte-identical at the defaults; no per-user health threshold exists.

## Tuning policy

Thresholds are documented heuristics (user-approved 2026-11-17). A threshold change is a **code + docs change in the same commit**: update the exported constant in `HEALTH_RULES` (`src/core/health.ts`) and the matching number in this file together. Tests assert against the exported constants, so changing a constant without its doc (or vice versa) breaks the test gate. There is no per-user health threshold and no auto-tuning; user-owned advisory budgets live in the separate guardrail layer above.
