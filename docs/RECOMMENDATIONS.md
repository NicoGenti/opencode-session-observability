# Recommendations

Recommendations are a **derived signal** computed in `src/core/recommendations.ts` from the `Analysis` the service already produces. They are attached once in `ObservabilityService.loadDataset` — after diagnostics, health and attribution — as the optional rider `analysis.recommendations`, and are absent when no rule triggers.

Standing contract:

> Local and deterministic — derived from recorded data, never ranked.

- **Local and deterministic.** The evaluator is a pure function of the analysis. It never reads the clock, never performs I/O, and makes **no model or network call**. There is no LLM involvement anywhere in this layer.
- **Explainable.** Every row carries its `ruleID`, a fixed `label`, a deterministic `note` (phrases plus counts only) and capped evidence ids that already exist in `analysis.events` / `analysis.turns`.
- **Facts first, hypotheses second, never ranked.** Rows are listed in the fixed declaration order of the rule set, fact before its hypothesis. There is no score, no priority, no weight, and no numeric ordering artifact in the DTO or the UI.

Recommendations are not session health. Health is a separately documented evaluator over the same analysis ([HEALTH.md](HEALTH.md)); a recommendation can restate a triggered health rule, but it never changes the health verdict and health never reads this layer.

## DTO contract

```ts
interface Recommendation {
  id: string;              // `<ruleID>:<kind>` — one row per rule and kind
  kind: "fact" | "hypothesis";
  severity: "info" | "advisory";
  ruleID: RecommendationRuleId;
  label: string;           // short fixed headline
  note: string;            // deterministic template plus counts
  eventIDs: string[];      // capped evidence, existing ids only
  turnIDs: string[];       // capped evidence, existing ids only
}

interface Recommendations {
  rows: Recommendation[];
  basisNotes: string[];
}
```

**Severity vocabulary is exactly `info | advisory`.** `severity` is structural, not a judgement: every `fact` row is `info`, every `hypothesis` row is `advisory`. Nothing else exists, and no code path derives a severity from a magnitude.

**Fact / hypothesis contract**

| Kind | Meaning | Ships with |
|---|---|---|
| `fact` | A restatement of a finding that already exists in the analysis: a triggered health rule, an incident aggregate, a recorded count, an attribution aggregate. | Its own evidence ids. |
| `hypothesis` | An if-then suggestion derived from that finding. It is **not a diagnosis**. | A companion `fact` row for the same `ruleID`, listed before it. |

A test asserts the pairing for every hypothesis row (`test/recommendations.test.ts`). One rule (`concentrated-file-cost`) emits a fact only, because concentration is an observation, not an action.

**Caps.** `MAX_EVENT_LINKS = 10` (shared with health), `MAX_RECOMMENDATION_TURN_LINKS = 6`, `MAX_RECOMMENDATION_ROWS = 16` (the closed rule set cannot exceed it). Ids are de-duplicated, empty ids dropped, and recorded order kept. The UI re-enforces the same caps.

**Privacy.** Notes never embed prompt text, tool output, file content, patch text or a shell command line — the same payload boundary as diagnostics and attribution. The rider passes through `redactValue` with the rest of the analysis, and since it carries no payload text, redacted and revealed copies are identical.

## Rule set

Each rule is evidence-gated: it emits nothing when its source does not exist, is not evaluable, or does not cross its documented bound. Constants below are exported from `src/core/recommendations.ts`.

### `reduce-context`

- **Trigger:** the already-computed health rule `context-growth` is `triggered`.
- **Evidence:** that health rule's capped `eventIDs` and `turnIDs`.
- **Fact template:** `Health rule "Context growth" is triggered (<level>): <n> turn(s) added context[; final context <n>].`
- **Hypothesis:** `Trim or summarize in-turn context` — `Hypothesis: trimming or summarizing in-turn context before the next prompt may keep the growth run shorter across the <n> recorded turn(s).`
- **Source layer:** health.

### `retry-failed-tool`

- **Trigger:** at least one diagnostics incident whose `recovery` is `no-recovery-evidence`. `recovered` and `possible-recovery` are resolved or ambiguous, and `insufficient-data` proves nothing either way, so none of them trigger this rule.
- **Evidence:** each unrecovered incident's `firstFailureEventID` and `turnID`.
- **Fact template:** `<n> incident(s) across <m> tool(s) have no recovery evidence; <tool> failed <n> time(s) in one run.` The named tool is the unrecovered incident with the most attempts (first recorded wins a tie).
- **Hypothesis:** `Verify the tool precondition before retrying` — `Hypothesis: retrying <tool> immediately may repeat the same failure; checking its precondition or configuration first may end the run sooner.`
- **Source layer:** diagnostics.

### `split-task`

- **Trigger:** the first turn, in recorded order, that records at least `SPLIT_TASK_MIN_STEPS = 12` steps **or** at least `SPLIT_TASK_MIN_DURATION_MS = 900_000` ms (15 minutes) of `turn.totalTime`.
- **Evidence:** that turn's capped `eventIDs` plus its `id`.
- **Fact template:** `Turn <index> recorded <steps> step(s) and <minutes> min of recorded turn time.`
- **Hypothesis:** `Split the task` — `Hypothesis: splitting this turn into smaller prompts may keep each turn's context, step count and cost per turn lower.`
- **Source layer:** turns.

### `reuse-subagent`

- **Trigger:** `analysis.totals.subagentCalls >= REUSE_SUBAGENT_MIN_CALLS = 3`.
- **Evidence:** the attributed turns that recorded a delegated subtask (`analysis.attribution.turns[].subtasks`), capped.
- **Fact template:** `<n> subagent call(s) were recorded in this analysis.`
- **Hypothesis:** `Reuse a subagent for the repeated workload` — `Hypothesis: <n> delegated calls may be served by one reusable subagent instead of starting a fresh delegate each time.`
- **Source layer:** totals (with attribution as the drill source).

### `avoid-unnecessary-compaction`

- **Trigger:** at least one compaction whose `contextBefore` is recorded (non-null) and below `COMPACTION_CONTEXT_FLOOR = 20_000`. An unavailable `contextBefore` never triggers it.
- **Evidence:** each matching compaction's `eventID` (and `turnID` when recorded).
- **Fact template:** `<n> of <total> compaction(s) were recorded with less than 20000 of context before them.`
- **Hypothesis:** `Check whether the compaction was needed` — `Hypothesis: a compaction recorded below 20000 of context may not have been necessary; checking its trigger may avoid the summary cost next time.`
- **Source layer:** compactions.

### `concentrated-file-cost`

- **Trigger:** at least `CONCENTRATED_FILE_MIN_FILES = 2` distinct attributed file paths with a positive derived cost share, **and** the top path carries at least `CONCENTRATED_FILE_SHARE = 0.5` of the summed shares. Shares are aggregated per path across turns.
- **Evidence:** that path's capped tool-event ids and the turns that touched it.
- **Fact template:** `<path> carries <n>% of the attributed file cost (<$amount> across <n> turn(s)).`
- **Fact only** — concentration is an observation, not an action. The cost base is the attribution layer's derived per-file share (step cost divided evenly across the step's tool calls and the files each call touched); the session row's auxiliary-inclusive cost is never used.
- **Source layer:** attribution.

## Surfaces

- **Web (Advanced Statistics only).** A `Recommendations` section below task attribution and above the basis legend, rendered by `src/ui/recommendations.js`. Fact rows are plain cards; hypothesis rows carry the dashed uncertain treatment, a `Hypothesis` kind chip and the copy `hypothesis — not a diagnosis`. Every row shows its source layer and drills through the existing `data-event-id` binding. The section header carries the fact/hypothesis counts and the provenance rail (`Sources — health · attribution · …`); the footer repeats the standing line and lists the DTO's basis notes. Basic mode renders nothing, and an absent rider renders no section.
- **Native TUI.** The Statistics panel's banner adds one line — `Recommendations: <n> advisory` (or `0 advisory`) — counted from the validated `analysis.recommendations` rider. There is no recommendation detail surface in the TUI; the browser is the primary one.

See [UI.md](UI.md) for the rendered section and [ARCHITECTURE.md](ARCHITECTURE.md) for the module's place in the pipeline.
