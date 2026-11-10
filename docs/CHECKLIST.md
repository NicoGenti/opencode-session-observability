# Acceptance checklist

This checklist separates what is implemented, what is available from OpenCode 2, what is unavailable, and what is estimated.

## Implemented

### Data and projection

- [x] Read-only OpenCode 2 SQLite adapter (`session_v2`, `session_message`) with schema detection.
- [x] OpenCode 2 server API adapter (`ctx.session.list/get/context`).
- [x] In-memory source for fixtures/tests.
- [x] Defensive normalization for all observed message types: `assistant`, `user`, `synthetic`, `system`, `skill`, `shell`, `compaction`, `agent-switched`, `model-switched`, `location-switched`, `idle`.
- [x] Assistant content blocks: `reasoning`, `text`, `tool`.
- [x] Tool states: streaming, running, completed, error; input/output, error, metadata, timings.
- [x] Subagent child-session extraction from `<subagent sessionID="…">` and metadata.
- [x] Turn/step/tool/compaction grouping by recorded `seq`.
- [x] Idle outcomes, retries, step errors, interrupted sessions.
- [x] Session family (parent/children) and provenance markers (parent, fork, revert, resume, suspend).
- [x] Unattached events preserved with uncertainty labels.
- [x] Out-of-order timestamps flagged, never re-sorted.
- [x] Unknown message/content types preserved as `unknown` events.

### Metrics

- [x] Prompt/context tokens (`input + cache.read + cache.write`).
- [x] Token-weighted cache hit rate.
- [x] Model time (`created → streamed`).
- [x] Step total (`created → completed`).
- [x] Tool time (sum of `ran → completed`).
- [x] Residual time with negative-overlap note.
- [x] Turn total (last step end − first step start).
- [x] Active turn time and wall-clock.
- [x] Output speed (output tokens / model seconds).
- [x] Context latest, cumulative, delta.
- [x] Cost (steps + compactions, partial handling).
- [x] Error counts by tool/step/session, retries, tool calls, subagent calls.
- [x] Compaction before/after/removed/summary size/output tokens/cost.
- [x] `Session total` vs `Window total`.
- [x] Measured/derived/estimated/unavailable basis labels.

### UI

- [x] Trajectory timeline grouped by turn and step.
- [x] Filters: kind, agent, model, provider, tool, status, errors, retries, compactions, subagents, context, time range, prompt-token range.
- [x] Full-text search over prompts, outputs, reasoning, tool names and serialized payloads.
- [x] Event detail drawer with formatted JSON, text/reasoning, tool input/output/error/metadata, diff, subagent links.
- [x] Copy JSON/text/metrics/turn chain.
- [x] Parent/child session navigation.
- [x] Badges: error, retry, compaction, context, subagent, uncertain.
- [x] Statistics table with turn rows and expandable step details.
- [x] Configurable Markdown response limit (4k–80k characters, persisted per browser).
- [x] Context basis selector (Latest/Cumulative) with selection-independent session totals.
- [x] Show event rows toggle (non-step rows, excluded from totals).
- [x] Compaction transaction cards.
- [x] Jump from a step/compaction to the exact Trajectory event.
- [x] Session/Window totals row.
- [x] Recorded-by-OpenCode totals comparison.
- [x] Keyboard shortcuts.
- [x] Deep links (`#/s/<id>/<view>?event=…`).
- [x] Export JSON/Markdown/HTML (redacted by default).
- [x] Secret redaction with explicit reveal.
- [x] Responsive layout, dark/light, reduced-motion support.
- [x] Virtualized event ledger, incremental paging, scroll preservation.
- [x] `content-visibility` per turn block for the Statistics table.

### Integration and quality

- [x] OpenCode 2 server plugin with read-only RPC.
- [x] OpenCode 2 TUI commands `/observability`, `/trajectory`, `/statistics`.
- [x] Local HTTP API + static UI; GET/HEAD only; strict CSP; loopback bind.
- [x] Default-on access token with constant-time comparison and a per-port token file for the TUI.
- [x] `--no-auth` loopback opt-out; non-loopback binds always require authentication.
- [x] 201 automated tests (pinned at v0.1.0).
- [x] Read-only file hash test and write-rejection test.
- [x] OpenCode SDK kept as a type-only devDependency; production and full audits clean (overrides pin patched `glob` and `minimatch`). Optional `@opentui/core`, `@opentui/solid` and `solid-js` are peer + dev only (no production deps), so `npm run audit:prod` stays at zero.
- [x] Fixtures: simple, tools, subagents, retry/error, compaction, long paging, incomplete, out-of-order, secrets, empty.
- [x] README, data-source analysis, architecture, metrics reference, UI guide.

## Available metrics

| Metric | Source |
|---|---|
| Input/output/reasoning/cache read/cache write tokens | assistant `tokens` and compaction `tokens` |
| Prompt/context size | derived from token fields |
| Cache hit rate | derived |
| Model time | `time.created`/`time.streamed` |
| Step total | `time.created`/`time.completed` |
| Tool time | tool `time.ran`/`time.completed` |
| Turn total | step timestamps |
| Active/wall-clock time | event timestamps |
| Output speed | output tokens / model time |
| Context delta | step prompt sizes |
| Cost | assistant/compaction `cost` |
| Tool calls/errors/retries | content blocks and records |
| Subagent calls/links | `subagent` tool blocks and child sessions |
| Compaction before/after | compaction request tokens + next step tokens |
| Status | finish/error/idle outcome/active session |
| Session family/provenance | `session_v2` fields |

## Not available in OpenCode 2.2.x

| Metric / feature | Why |
|---|---|
| TTFT | no first-token timestamp |
| Approval/permission decisions and pending approvals | not persisted historically |
| Request headers / route headers | only live hooks |
| Tool-set additions/removals | not persisted |
| Exact compaction duration | only completion timestamp |
| Per-call title/generate cost attribution | not in the message stream |
| Live streaming updates inside the analysis | the app refreshes on demand (optional 10s live mode); it does not tail SSE |
| Desktop GUI panel | not shipped; browser UI is primary |

## Estimated metrics and assumptions

| Metric | Assumption |
|---|---|
| Model time when `streamed` is absent and there are no tools | `completed - created`, marked `E`; unavailable if tools exist |
| Tool duration when `ran` is absent | `created → completed`, marked `D` with a note |
| Turn total when there are no steps | first/last event span, marked `D` with a note |
| Compaction context before | compaction request prompt if recorded, else previous step prompt |
| Compaction removed tokens | `before - after`; signed, not a direct ledger |
| Subagent association | from the tool result marker/metadata; marked derived |
| Step trigger | first step → turn trigger; later steps → “After tool results” or “Assistant continuation” |
| Recorded session totals | OpenCode's own row; may include auxiliary calls |

## Test matrix

| Area | Test file |
|---|---|
| Metrics formulas | `test/metrics.test.ts` |
| Normalization (tags, blocks, tools, retries, compaction, ordering, provenance) | `test/normalize.test.ts` |
| Projection (turns, steps, subagents, retry, compaction, incomplete, out-of-order, secrecy, windows, empty) | `test/project.test.ts` |
| Paging and scroll preservation | `test/paging.test.ts` |
| SQLite adapter, schema detection, read-only hash and write rejection | `test/adapter.test.ts` |
| API source, filters, search, detail, list DTO, windows | `test/service.test.ts` |
| Export formats and escaping | `test/export.test.ts` |
| RPC contract and handlers | `test/plugin.test.ts` |
| HTTP server endpoints/headers/redaction/export/errors | `test/server.test.ts` |
| Access token, non-loopback guard, constant-time comparison | `test/auth.test.ts` |
| Per-port token file lifecycle and permissions | `test/token-file.test.ts` |
| UI fragment token, sessionStorage and headers | `test/ui-auth.test.ts` |
| TUI deep-link token placement | `test/plugin-tui.test.ts` |
| Plugin sources keep the SDK type-only | `test/plugin-deps.test.ts` |
| Delegation recovery rules (links, child failure evidence, parent reactions, pattern labels, basis invariant) | `test/diagnostics-multiagent.test.ts` |
| Family recovery service (full-range children, cap of 8, cycle note, redaction parity, unloadable child) | `test/delegation-service.test.ts` |
| Family recovery endpoint (`/family-recovery`, reveal gate, 404, GET/HEAD, `?refresh`) | `test/server.test.ts` |

The `/family-recovery` endpoint itself is covered in `test/server.test.ts`; a plugin RPC method and a UI surface are deferred in v1 (see Known gaps).

## Known gaps / next steps

1. **Desktop GUI panel.** The experimental `./gui-experimental` export is not shipped. The RPC contract is ready for a Solid panel if desired. The typed `./tui` sidecar exports `NativeObservabilityView` as a scaffold only: it is not auto-mounted, and the precompiled rendering/build lane is owned by issue #8.
2. **Live streaming.** The web UI refreshes on demand and has an optional 10s live mode. It does not consume the OpenCode SSE event stream. A live tap using `session.hook("http.request")`/`"http.response"` could add headers/retries/approvals, but it would be a separate, explicit capture surface.
3. **Approval history.** Without a persisted permission event, this remains unavailable. The UI does not fake it.
4. **Compaction duration and removed-token exactness.** The current values are the best derivable values; a future schema could record start/end and a direct ledger.
5. **Very large single sessions.** The analysis endpoint trims step prose and tool bodies; the event detail endpoint remains the source for full payloads. If sessions grow to hundreds of thousands of messages, server-side SQL aggregation and a streaming projection would be the next optimization.
6. **Stale token files.** A hard kill can leave a per-port token file behind. The next run on that port overwrites or clears it; the file is user-scoped and contains a token that is no longer valid after the server exits.
7. **Redaction coverage.** Redaction is heuristic: known prefixes, credential-shaped keys and assignments are covered, but unknown formats and very short values are not. Reveal remains opt-in and disabled by default.
8. **Delegation recovery surfaces.** `familyRecovery` is reachable only over HTTP (`GET /api/sessions/{id}/family-recovery`). A plugin RPC method and a UI view are deferred; the DTO already carries `basis`, `redacted`, `patternCounts` and uncertainty notes, so an RPC view and a UI panel can render it without new analysis.
