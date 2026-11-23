# Metrics reference

Every number in the UI carries a basis:

| Mark | Basis | Meaning |
|---|---|---|
| `M` | measured | Recorded directly by OpenCode (timestamps, token counters, cost, status). |
| `D` | derived | Arithmetic over recorded values (sums, differences, ratios). |
| `E` | estimated | A documented fallback with an explicit assumption. |
| `—` | unavailable | The data is not persisted; no hidden inference is made. |

In tables, a superscript `D`/`E` appears next to derived/estimated values. The tooltip contains the full note. Measured values have no superscript.

## Token metrics

OpenCode 2 normalizes provider usage into:

```json
{
  "input": 71,
  "output": 991,
  "reasoning": 0,
  "cache": { "read": 30336, "write": 0 }
}
```

### Prompt tokens / context size — `D`

```text
prompt = input + cache.read + cache.write
```

`input` excludes cached prompt tokens; `cache.read` and `cache.write` are separate. This is the best available proxy for the prompt size of one model call. The schema calls the fields `input`, `cache.read`, `cache.write`; it does not expose a pre-summed prompt field.

**Caveat:** if a provider or adapter were to include cached tokens inside `input`, the sum would double-count them. OpenCode 2's normalized usage in the inspected data does not: `cache.read` frequently exceeds `input` and is clearly a separate counter.

### Input / output / reasoning / cache read / cache write — `M` per row, `D` for sums

- Each assistant step's counters are recorded values.
- Turn/session totals are sums of recorded step (and, where stated, compaction) counters.
- A missing token object makes the affected metric unavailable; it is not treated as zero. The UI marks `tokens-missing`/partial totals.

### Cache hit rate — `D`

Per step:

```text
cache hit rate = cache.read / (input + cache.read + cache.write)
```

Aggregated (turn/session):

```text
sum(cache.read) / sum(input + cache.read + cache.write)
```

This is **token-weighted**, not an average of per-step percentages. It is unavailable when the prompt is zero.

## Time metrics

### Model time — `D` (or `E` fallback)

```text
model time = time.streamed - time.created
```

`time.streamed` is documented as “when the provider response body ended, before tool settlement”. It is the closest recorded boundary for provider generation.

Fallback: if `time.streamed` is missing, there are no tool calls, and `time.completed` exists, the UI uses `completed - created` and marks it **estimated**. With tools present it stays unavailable, because `completed` includes tool settlement.

### Step total — `D`

```text
step total = time.completed - time.created
```

If `completed` is missing but `streamed` exists, the UI uses `streamed` and marks the step incomplete. If neither exists, unavailable.

### Tool time — `D`

For each tool:

```text
tool duration = time.completed - time.ran
```

If `ran` is missing, `created → completed` is used and the note says so. If the tool was still running/streaming at record time, the duration is unavailable.

Step tool time is the **sum** of tool durations. Parallel tool calls can exceed wall-clock; the note says so. This is why a residual can be negative.

### Residual time — `D`

```text
residual = step total - model time - tool time
```

A negative residual is not clamped: it means the model and tool windows overlap (parallel tools) or a timestamp boundary is imperfect. The tooltip explains the sign.

### Turn total — `D`

```text
turn total = last completed step end - first step start
```

If the turn has no steps, the UI uses the turn's first/last event and notes that it has no assistant step.

### Active turn time — `D`

Sum of turn total durations. It is not wall-clock; it is the active span of each turn.

### Wall-clock time — `D`

```text
last recorded event timestamp - first recorded event timestamp
```

For a windowed analysis it is the first/last event in the window and the total is labelled `Window total`.

## Context metrics

### Context latest — `D`

The prompt size of the **last step** in the turn that has token usage. This is the turn's final prompt size.

### Context cumulative — `D`

The sum of every step prompt size in the turn. This is useful for cost/context churn but is not a context-window size.

### Context delta — `D`

```text
delta = current turn latest context - previous turn latest context
```

The first turn has no previous turn, so the delta is unavailable. The UI does not use a global app state.

### Context basis selector

`Context basis` changes only which context column is displayed for turn rows:

- `Latest` → `promptTokensLatest`;
- `Cumulative` → `promptTokensCumulative`.

The **session total row is independent**: it always shows the final context and the cumulative prompt total separately. The selector cannot change totals.

## Cost

- Per step: recorded `assistant.cost`.
- Per turn: sum of step costs. Compaction costs are excluded from turn/step totals.
- Session: sum of step + compaction costs.
- If any contributor is missing, the total is marked partial (`D` with a note); if all are missing, unavailable.
- A recorded `0` is valid and displayed as `$0`.

`recorded` totals from `session_v2` are shown separately because they can include auxiliary model calls (title generation, compaction, other internal calls) and may differ slightly from the visible steps.

## Status

| Status | Meaning |
|---|---|
| `completed` | assistant finish is `stop`, `tool-calls`, `length` or `content-filter`, and/or idle outcome succeeded |
| `error` | assistant error/failed idle, or a step error |
| `interrupted` | idle outcome interrupted or error type aborted |
| `running` | the session is active (`time.busy > time.idle`) and the turn has no closing idle |
| `incomplete` | no closing idle, no completed timestamp, or the step is still open |
| `unknown` | no status evidence |

**Awaiting approval** is not available for historical data: OpenCode 2 does not persist permission asks/replies in the session message stream. The UI never fabricates an awaiting-approval state.

Session health rules and thresholds: see [HEALTH.md](HEALTH.md).

## Errors, retries and tool calls

- `tool calls`: count of `tool` content blocks.
- `subagent calls`: count of tool calls flagged as `subagent`/`task` (or with a child session ID).
- `errors.tool`: tools with status `error` or an error object.
- `errors.step`: assistant steps with error status.
- `errors.session`: idle events with `failed`/`interrupted`.
- `errors.total`: sum of the three; derived error rows are not double-counted.
- `retries`: derived `retry` events from `assistant.retry`; they are non-step rows.

## Compaction transactions

A `compaction` message is a transaction, not a step.

| Field | Formula | Basis |
|---|---|---|
| Context before | prompt tokens of the compaction request if recorded, else previous step prompt | `D` |
| Context after | prompt tokens of the next step | `D` |
| Context delta | after − before | `D` |
| Removed tokens | before − after; positive means the context shrank, negative means it grew | `D` |
| Summary chars | length of the recorded summary text | `M` |
| Summary output tokens | `compaction.tokens.output` (the compaction call, not a direct summary-size measurement) | `M` |
| Cost | recorded compaction cost | `M` |
| Duration | unavailable: only a completion timestamp is persisted | `—` |

Compaction tokens are included in **session** totals and shown as a separate breakdown. They are excluded from turn/step totals. The transaction card labels this explicitly.

## Advanced chart series (web, Advanced mode only)

Charts are projected from the already-loaded `Analysis`: no extra fetch and no re-paging. Missing metrics stay `null` and are never zero-filled (`src/web/lib/chart-data.ts`); the series below state which are measured, derived, estimated or unavailable.

### Context growth chart — `D`

- Series: per turn, `turn.promptTokensLatest` (Context basis **Latest**) or `turn.promptTokensCumulative` (Context basis **Cumulative**). Basis mark copied from the underlying metric (`derived`), or `unavailable` when null.
- Missing context leaves a gap in the polyline (a null point), never a zero dip; the section counts the gaps as `unavailableCount`.
- `Compaction N` markers: one dashed vertical marker per compaction, placed on the turn index resolved from `compaction.turnID` (authoritative; a recorded id that does not resolve to a loaded turn makes the marker unplaceable). Only a compaction with no recorded turn id falls back to the last turn whose start time is at or before the compaction timestamp. `removedTokens` is carried as a metric point. Unplaceable compactions are counted in `unplaced` and never synthesized onto a turn.

### Token usage chart — `M` (stacked, five segments)

- Segments per turn, all taken from `turn.tokens`: input, cache read, cache write, reasoning, output. Each is a recorded counter (`M`), not a derived value; totals stay aggregations (`D`).
- Recorded counts are never padded into a measured record: a missing counter is coerced to `0` only for layout, while the turn's `basis` stays `unavailable` whenever any segment is incomplete or absent, so an incomplete or missing record is never painted as a zero bar marked measured.
- A turn with `tokensComplete === false` keeps its recorded subset with `partial: true` (dashed outline, "partial: recorded subset only"); its basis becomes `unavailable` unless every step recorded usage.
- A turn whose steps recorded no usage at all is an unavailable point (dashed "Not recorded" slot), never a zero bar marked measured. A recorded count of `0` is a valid value and is kept.

### Cost chart — `D`

- One bar per turn from `turn.cost.value` (`null` when unavailable), with the derived model key from the last step that recorded a model; the provider label is reported only when that step recorded one — no model-to-provider inference.
- Highest-cost emphasis: the maximum available cost strictly above zero, with every tied turn index listed, so colour never carries the ranking alone. An all-zero session marks nothing.

### Step duration chart — `D`

- One stacked bar per step (`<turn>.<step>`) from `step.modelTime`, `step.toolTime` and `step.residualTime`. A missing segment is omitted rather than zero-filled.
- A step with none of the three recorded is unavailable (dashed "Not recorded" slot).
- Chart values keep the same provenance marks as the table (M measured, D derived, E estimated, — unavailable).

### Availability summary

| Chart series | Basis | Unavailable handling |
|---|---|---|
| Context growth point | derived | null → gap plus dashed unavailable tick; counted |
| Token usage segment | measured (recorded counter) | incomplete turn → dashed outline, recorded subset only; no usage → "Not recorded" slot |
| Cost bar | derived | null → counted unavailable; all-zero marks nothing |
| Step duration segment | derived | missing segment omitted; none recorded → "Not recorded" slot |

## Session health

Health is a derived signal computed from the already-produced `Analysis`; it carries no numeric score. Its state is one of `healthy` / `watch` / `degraded`, with a sufficiency gate that prevents a `healthy` claim when data is missing or the analysis is windowed. All seven rules, thresholds, caps, drill targets and the tuning policy are documented in [HEALTH.md](HEALTH.md) (linked, not duplicated here).

## Live snapshot

The live endpoint re-shapes the same `Analysis`; it introduces no new metric formula. `openTurn` copies the turn's existing tokens/cost, `warnings` are the triggered health rules, and every value keeps its existing basis. The badge and warning vocabulary (states, the five rules, caps, `since`/`lastTurns`) is documented in [UI.md](UI.md#live-mode) and [ARCHITECTURE.md](ARCHITECTURE.md#live-snapshot).

## Task attribution cost share — `D`

`analysis.attribution.turns[].files[].costShare` answers "what share of this turn's recorded cost went to this file". It is always `derived`, never `measured`, and it uses step costs only:

```text
share(step, file) = step.cost / step.toolCalls.length / files touched by that call
costShare(file)   = sum of share over every step and tool call that touched the file
```

Even-allocation caveat: the split is not a measurement of where tokens were spent — the store records one cost per assistant step, not per tool call. A tool call that touches no file (a pattern-only `grep`, a `webfetch`, a subagent call) is not allocated at all, so a turn's shares can sum to less than its step costs. Allocation happens across the whole turn, so a file touched by two steps accumulates both shares. A file whose steps recorded no cost keeps `value: null` with basis `unavailable` instead of a zero.

Each share is rounded to a 1e-12 grid before it is stored, so binary floating-point noise (`0.03 / 3 = 0.009999999…`) never reaches the DTO; a recorded zero stays a measured zero and renders `$0`, while an absent cost renders `—`.

The session row's own cost (`Totals.recorded`, `session_v2.cost`) is never used as the basis: it can include auxiliary calls that are not attributable to a turn. Commands and subtasks carry no cost share for the same reason — nothing recorded can be divided for them.

## Cross-session benchmark rollups — `D`

`GET /api/benchmark` reports descriptive rollups over at most 50 sessions. Nothing here is a new per-session formula: every row copies `Analysis.totals` (plus the triggered health rule ids, the failing tool names and the recorded task trigger kinds), and the aggregator only sums and averages.

| Rollup | Basis | Definition |
|---|---|---|
| Turns, steps, retries, errors, compactions | counts | Summed over every compared session. `errors` is `totals.errors.total` (tool + step + session errors); tool-failure incidents are the diagnostic incidents, not the tool-error count. |
| Tokens (sum) | `D` | `input + output + reasoning + cacheRead + cacheWrite` summed over every compared session. A row with incomplete token usage still contributes what it recorded; the per-session `tokensComplete` flag is not aggregated. |
| Cost (sum) | `D` | Sum of the per-session `totals.cost` (steps + compactions). A session without a recorded cost is skipped and the note names how many; the session row's own `session_v2.cost` is never used. |
| Average cost per session | `D` | `sum(recorded costs) / count(sessions with a recorded cost)`, over comparable (non-windowed) sessions only. |
| Average duration per session | `D` | Mean of the per-session wall-clock span (`totals.wallClockTime`: first to last recorded event), over comparable sessions with an available span. |
| Average cache hit rate | `D` | Mean of the per-session token-weighted cache hit rate, over comparable sessions with a recorded rate. |
| Completion counts | counts | `sessions.outcome` grouped into succeeded / failed / interrupted / unrecorded (no recorded terminal outcome). |
| Windowed count | counts | Sessions in the rollup whose `coverage.complete` is false. |

Sums and averages answer different questions, so they are kept apart: a group of three sessions has one cost sum and one average, and a session that recorded nothing lowers neither the sum nor the denominator of an average. An average with no recorded value anywhere is `unavailable` (`value: null`), which the UI renders as "Not recorded" rather than zero.

Windowed exclusion: a benchmark always loads the full message range, so in practice every compared session is comparable. The rule still lives in the aggregator: a `coverage.complete === false` session keeps contributing to the sums and the completion counts but never to an average, and `windowedCount` reports how many were excluded.

Rollups are descriptive: no score, no index, no ranking. Groups are ordered by their recorded key and patterns by kind and key.

## Guardrail budgets — `D`

`evaluateGuardrails(analysis, thresholds)` compares six budgets against the same `Analysis` and reports a warning only when `observed >= threshold`. Every observation is `derived` from existing metrics; nothing is re-recorded and nothing is a score.

| Budget | Observed value | Basis | Evaluable when |
|---|---|---|---|
| `tokensTotal` | `input + output + reasoning + cacheRead + cacheWrite` from `totals.tokens` (steps + compactions) | `D` | token usage was recorded |
| `costTotal` | `totals.cost.value` (computed step + compaction cost; never `session_v2.cost`) | `D` | a cost was recorded |
| `contextRun` | longest run of consecutive turns with a positive `contextDelta`, compaction breaks included (the health rule's vocabulary) | `D` | at least two turns recorded a delta |
| `retries` | `totals.retries` (derived retry events) | `D` | always |
| `toolFailures` | diagnostics incident count | `D` | always (`0` without incidents) |
| `elapsedMinutes` | `(last event timestamp − first event timestamp) / 60_000`, floored at 0 | `D` | `coverage.complete` is true |

A budget that is not evaluable is returned in `skipped` with a note — never guessed. The default budgets are `DEFAULT_GUARDRAILS` (2,000,000 tokens, $5.00, 6 turns, 10 retries, 5 incidents, 60 minutes); the browser supplies per-user values through bounded `gr.*` GET parameters, and absent keys fall back to the defaults. The response carries `guardrails` as a sibling of `analysis`, and warnings keep the health event/turn caps. The full contract is in [HEALTH.md](HEALTH.md#guardrails).

## Session vs window totals

- `Session total` — coverage includes the full message range (`fromSeq <= minSeq && toSeq >= maxSeq`).
- `Window total` — the analysis was restricted to a sequence window.

The totals are computed from the events in the loaded window. The event ledger can page payloads independently; paging does not change the analysis window.

## Recorded vs computed session totals

Computed totals are the sum of visible steps + compactions. The session row also stores OpenCode's own totals. They can differ because OpenCode's totals may include auxiliary calls. The UI shows both:

- computed totals in the main table/stat tiles;
- `Recorded by OpenCode` under the table.

## Unavailable metrics and assumptions

| Metric | Status | Assumption / reason |
|---|---|---|
| TTFT | `—` | No first-token timestamp is persisted. |
| Awaiting approval | `—` | Permission asks/replies are not in historical session data. |
| Request headers | `—` | Live hooks only. |
| Tool-set changes | `—` | Not persisted. |
| Compaction duration | `—` | Only a completion timestamp is stored. |
| Per-call title/generate usage | `—` | Session totals may include it but it is not attributable from messages. |
| Model time when `streamed` is missing | `E` only with zero tools | `completed - created`; otherwise unavailable. |
| Tool time when `ran` is missing | `D` with note | `created - completed`. |
| Turn total without steps | `D` with note | First/last event span, not an assistant-step span. |

## Worked example (fixture)

`toolsFixture` step 1:

- created 100 ms, streamed 500 ms, completed 1400 ms;
- tools: read ran 600 → completed 800 (200 ms), grep ran 900 → completed 1400 (500 ms);
- tokens: input 1000, output 100, reasoning 10, cache read 3000, cache write 500.

```text
prompt          = 1000 + 3000 + 500 = 4500
cache hit rate  = 3000 / 4500 = 66.7%
model time      = 500 - 100 = 400 ms
step total      = 1400 - 100 = 1300 ms
tool time       = 200 + 500 = 700 ms
residual        = 1300 - 400 - 700 = 200 ms
output speed    = 100 / 0.4 = 250 tok/s
```

A real session with parallel subagent tools shows the expected negative residual because the tool-duration sum exceeds the wall-clock settlement window.

## What is never inferred

- No event is assigned to a turn using the app's “current” session/turn state.
- No missing timestamp is replaced by a neighboring event's timestamp to make a duration look complete.
- No approval row is invented from a tool name.
- No per-step context is guessed from message text length.
- No recovery pattern is measured: every `no-child-failure`, `parent-retried-*`, `parent-fallback-*` and `parent-reaction-unclear` label is a `derived` aggregate over recorded delegation events, and `insufficient-data` is `unavailable`, not a negative finding.
- No parent reaction is measured: retry, fallback and unclear are classifications of later recorded delegation events; they say nothing about what the parent model intended.
- No prompt semantics are inferred from the input-change proxy: `parent-retried-with-changed-delegation-input` reports that two recorded delegation inputs compared non-identical, never that a prompt was rewritten, re-scoped or improved.
- No child failure is claimed from a windowed child stream: an incomplete child stream yields `insufficient-data` instead of a failure or recovery verdict.
- No session total is presented as complete when a contributor is missing; it is labelled partial or unavailable.
- No commit or git linkage is inferred: the session record contains no git data, so attribution reports commit linkage as `unavailable` and never matches files to commits.
