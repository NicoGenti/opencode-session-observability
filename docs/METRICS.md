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
