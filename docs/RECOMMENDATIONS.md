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

**Caps.** `MAX_EVENT_LINKS = 10` (shared with health), `MAX_RECOMMENDATION_TURN_LINKS = 6`, `MAX_RECOMMENDATION_ROWS = 11` (the closed rule set's true ceiling: six facts plus five paired hypotheses; `concentrated-file-cost` is fact-only, so `2 + 2 + 2 + 2 + 2 + 1 = 11`). Ids are de-duplicated, empty ids dropped, and recorded order kept. The UI re-enforces the same caps with literals, and `test/recommendations-ui.test.ts` asserts those literals equal the core constants.

**Evidence links.** Every emitted row carries at least one event id that exists in `analysis.events`, because the UI only renders `data-event-id` buttons. A rule whose source yields turn ids but no event ids (health's `context-growth`) resolves its links through `turnAnchors(analysis, turnIDs)`, the single helper in `src/core/recommendations.ts` that maps a turn to `turn.trigger.eventID`, falling back to the turn's first recorded event id. If health ever gains another turn-only rule, that helper is the only place that needs to know.

**Privacy.** Notes never embed prompt text, tool output, file content, patch text or a shell command line — the same payload boundary as diagnostics and attribution. The rider passes through `redactValue` with the rest of the analysis, and since it carries no payload text, redacted and revealed copies are identical.

## Rule set

Each rule is evidence-gated: it emits nothing when its source does not exist, is not evaluable, or does not cross its documented bound. Constants below are exported from `src/core/recommendations.ts`.

### `reduce-context`

- **Trigger:** the already-computed health rule `context-growth` is `triggered`.
- **Evidence:** turn anchors resolved from that health rule's capped `turnIDs` (`turnAnchors`). `context-growth` records no event ids, so the helper supplies the drill links; the rule never restates the health event list.
- **Fact template:** `Health rule "context-growth" is triggered (<level>): <health rule note>.` The health rule's deterministic `note` is restated verbatim; this rule does not recount growth turns.
- **Hypothesis:** `Trim or summarize in-turn context` — `Hypothesis: trimming or summarizing in-turn context before the next prompt may keep the growth run shorter.`
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

- **Trigger:** `analysis.totals.subagentCalls >= REUSE_SUBAGENT_MIN_CALLS = 3` **and** at least one attributed turn recorded a delegated subtask. The count alone is not evidence: without an attributed subtask the row would have nowhere to drill, so the rule emits nothing.
- **Evidence:** turn anchors resolved from the attributed turns that recorded a delegated subtask (`analysis.attribution.turns[].subtasks`), capped.
- **Fact template:** `<n> subagent call(s) were recorded in this analysis.`
- **Hypothesis:** `Reuse a subagent for the repeated workload` — `Hypothesis: <n> delegated calls may be served by one reusable subagent instead of starting a fresh delegate each time.`
- **Source layer:** totals (with attribution as the drill source).

### `avoid-unnecessary-compaction`

- **Trigger:** at least one compaction whose `contextBefore` is recorded (non-null) and below `COMPACTION_CONTEXT_CEILING = 20_000` prompt tokens. An unavailable `contextBefore` never triggers it.
- **Evidence:** each matching compaction's `eventID` (and `turnID` when recorded).
- **Fact template:** `<n> of <total> compaction(s) were recorded with less than 20000 prompt tokens of context before them.`
- **Hypothesis:** `Check whether the compaction was needed` — `Hypothesis: a compaction recorded below 20000 prompt tokens of context may not have been necessary; checking its trigger may avoid the summary cost next time.`
- **Source layer:** compactions.

### `concentrated-file-cost`

- **Trigger:** at least `CONCENTRATED_FILE_MIN_FILES = 2` distinct attributed file identities with a positive derived cost share, **and** the top identity carries at least `CONCENTRATED_FILE_SHARE = 0.5` of the summed shares. Shares are aggregated per identity across turns.
- **Identity:** entries are keyed on `pathIdentity` from `src/core/attribution.ts` (separators unified, leading `./` dropped, case-folded on a case-insensitive filesystem). `src\hot.ts` and `src/hot.ts` are one entry; the first-seen spelling is displayed.
- **Evidence:** that identity's capped tool-event ids (turn anchors when a file row recorded none) and the turns that touched it.
- **Fact template:** `<path> carries <n>% of the attributed file cost (<cost> across <n> turn(s)).`
- **Fact only** — concentration is an observation, not an action. The cost base is the attribution layer's derived per-file share (step cost divided evenly across the step's tool calls and the files each call touched); the session row's auxiliary-inclusive cost is never used.
- **Source layer:** attribution.

## Windowed analyses

When `analysis.coverage.complete === false`, every aggregate describes the analysed window, not the session. The aggregating rules (`concentrated-file-cost`, `avoid-unnecessary-compaction`, `reuse-subagent`, `split-task`) append the qualifier ` (in the analysed window)` to their notes, and the rider adds one basis note: `The analysis covers a window, not the full session: every aggregate describes that window only.` This mirrors health's insufficiency wording (`the analysis covers a window, not the full session`) instead of stating a window total as a session fact.

## Surfaces

- **Web (Advanced Statistics only).** A `Recommendations` section below task attribution and above the basis legend, rendered by `src/web/lib/recommendations.ts`. Fact rows are plain cards; hypothesis rows carry the dashed uncertain treatment, a `Hypothesis` kind chip and the copy `hypothesis — not a diagnosis`. Every row shows its source layer and drills through the existing `data-event-id` binding. The section header carries the fact/hypothesis counts and the provenance rail (`Sources — health · attribution · …`); the footer repeats the standing line and lists the DTO's basis notes. Basic mode renders nothing, and an absent rider renders no section.
- **Native TUI.** The Statistics panel's banner adds one line — `Recommendations: <n> advisory` (or `0 advisory`) — counted from the validated `analysis.recommendations` rider. There is no recommendation detail surface in the TUI; the browser is the primary one.

See [UI.md](UI.md) for the rendered section and [ARCHITECTURE.md](ARCHITECTURE.md) for the module's place in the pipeline.
