# Architecture

The implementation separates storage, normalization, projection, metrics, diagnostics, presentation and export. The UI never reads OpenCode's raw schema.

## Data flow

```mermaid
flowchart LR
  DB[(OpenCode 2 SQLite<br/>session_v2 / session_message)] -->|read-only| SQL[SQLite adapter]
  API[OpenCode 2 plugin client<br/>ctx.session.*] --> APIA[API adapter]
  FIX[Fixtures / Memory source] --> MEM[Memory adapter]

  SQL --> RAW[RawMessage[] + SessionMeta]
  APIA --> RAW
  MEM --> RAW

  RAW --> NORM[Normalize<br/>NormalizedEvent[]]
  NORM --> PROJ[Project<br/>turns / steps / tools / compactions / unattached]
  PROJ --> MET[Metrics<br/>tokens / cache / durations / speed / context]
  PROJ --> IDX[Event index]
  MET --> TOT[Totals + capabilities + coverage]
  PROJ --> DIAG[Diagnostics<br/>evaluateDiagnostics → incidents]

  PROJ --> SVC[ObservabilityService]
  IDX --> SVC
  TOT --> SVC
  DIAG --> SVC
  SVC -->|redact / filter / page| HTTP[Local HTTP API]
  SVC -->|redact / filter / page| RPC[Plugin RPC]
  SVC -->|redact unless reveal| EXP[Export JSON / MD / HTML]

  HTTP --> WEB[Browser UI<br/>Trajectory + Statistics]
  RPC --> TUI[TUI commands]
  RPC --> EXT[Other clients]
```

## Layers

| Layer | Files | Responsibility |
|---|---|---|
| Adapter | `core/adapters/sqlite.ts`, `api.ts`, `memory.ts`, `paths.ts` | Own the storage/API shape. Produce `RawMessage` and `SessionMeta`. No metrics. |
| Data model | `core/types.ts` | Normalized event, step, turn, compaction, totals, capabilities, DTOs. |
| Normalization | `core/normalize.ts` | One ordered `NormalizedEvent` per message/content block. No turn assignment. |
| Projection | `core/project.ts` | Group events into turns/steps, attach non-step events, identify unattached events, build compaction transactions and capabilities. |
| Metrics | `core/metrics.ts` | Pure formulas for prompt tokens, cache hit rate, durations, residual, speed, context delta. |
| Diagnostics | `core/diagnostics.ts` | Pure, deterministic recovery rules over the recorded event order; incident anchors and contextual footprint metrics. No I/O and no writes. |
| Episodes | `core/episodes.ts` | Pure enumeration of addressable diagnostic episodes: one per incident, with a stable id plus the turn/tool identity and every diagnostic verdict copied verbatim. Never re-sorts and never compares. |
| Episode comparison | `core/episodeCompare.ts` | Pure, descriptive alignment of two episodes by recorded ordinal (`left - right`); a missing attempt becomes a one-sided row and no DTO field names a winner, an optimum or a recommendation. |
| Delegation recovery | `core/delegation.ts` | Pure assessment of a parent session and its direct children: recorded delegation links, child failure evidence, parent reaction classification and labelled recovery patterns. No I/O and no writes. |
| Service | `core/service.ts` | Load a dataset, cache briefly, compute diagnostics once, redact, filter, keyset-page, detail, export. |
| Presentation | `server/http.ts`, `server/auth.ts`, `server/token-file.ts`, `ui/*` | Local HTTP API, access token, static UI, view state. |
| Integration | `plugin/index.ts`, `rpc.ts`, `service.ts`, `tui.ts`, `tui.tsx` | OpenCode 2 server RPC + TUI commands; `tui.tsx` is a typechecked-only OpenTUI scaffold (`NativeObservabilityView`), not bundled. |
| TUI statistics | `plugin/tui/statistics/{StatisticsView.tsx,columns.ts,status.ts,stepRows.ts,state.ts}` | Native fullscreen panel: summary banner, dense turn table, step accordion, selection state and panel-scoped keys. `columns.ts`, `status.ts` and `stepRows.ts` are pure helpers with no SDK import. Built by `vite build --config vite.tui.config.ts` into `dist-tui/tui.mjs`. |
| Export | `core/export.ts` | Self-contained reports. |

## Adapter isolation

The adapter interface is intentionally small:

```ts
interface ObservabilitySource {
  kind: "sqlite" | "api" | "jsonl";
  listSessions(options?): Promise<SessionSummary[]>;
  getSession(id): Promise<SessionMeta | null>;
  listMessages(id, range?): Promise<RawMessage[]>;
  getFamily(id): Promise<SessionFamily>;
  messageBounds(id): Promise<{ minSeq; maxSeq; count }>;
  close?(): void;
}
```

- **SQLite** reads `session_v2` and `session_message` with parameterized `SELECT`s.
- **API** calls `ctx.session.list/get/context` and synthesizes sequence numbers from the ordered array.
- **Memory** backs tests and fixtures.

The normalizer sees the same `RawMessage` shape from all three. A storage change should be contained in one adapter.

## Ordering and grouping invariants

1. **Recorded order wins.** Messages are sorted by `seq`, then `time_created`, then `id`. A timestamp regression is flagged (`timestamp-regression`) but never re-sorted.
2. **User opens a turn.** Each `user` message starts a new turn. In a subagent session the trigger label is “Delegated prompt”.
3. **Assistant is one step.** Each `assistant` message is one step. Its `reasoning`, `text` and `tool` blocks share the step's `stepID`.
4. **A new user message closes the previous turn.** No event is moved to a later turn.
5. **Idle closes the open turn.** `idle.outcome` drives completed/error/interrupted status.
6. **Synthetic messages** start a turn only when no turn is open; otherwise they are non-step events in the current turn.
7. **System, switches, compactions, skill/shell/unknown** attach to the open turn; with no open turn they become unattached and are shown separately.
8. **Assistant without a user** starts an “orphan” turn with an uncertainty label; it is not silently attached to an earlier turn.
9. **Compactions are transactions**, not steps. They are recorded once and never added to step/turn token totals.

This is a projection, not a reconstruction of the conversation from prose. Identifiers and `seq` are used; no global app state is consulted.

## Metrics layer

All formulas live in `core/metrics.ts` and return a `Metric`:

```ts
interface Metric {
  value: number | null;
  basis: "measured" | "derived" | "estimated" | "unavailable";
  note?: string;
}
```

- `measured` — a recorded value (timestamps, token counters).
- `derived` — arithmetic over recorded values.
- `estimated` — a documented fallback (e.g. model time from `completed` when `streamed` is absent and no tools ran).
- `unavailable` — the data is not present; no hidden inference.

See [METRICS.md](METRICS.md).

## Service layer

`ObservabilityService` is the only place that:

- loads a session dataset (session + family + messages + bounds);
- normalizes and projects;
- mirrors turn ids onto the full event stream used by detail/list endpoints;
- computes diagnostics once over that same event stream and attaches them to the analysis payload;
- computes the delegation recovery family view on demand (`familyRecovery`): the parent and each direct child are loaded full-range, the direct children are assessed (cap 8) and the result is returned as its own DTO — it is part of neither `Analysis` nor the dataset payload — and served only by `GET /api/sessions/{id}/family-recovery`;
- redacts (unless reveal is explicitly allowed);
- applies filters and keyset pagination;
- trims the analysis payload (tool input/output and unbounded prose stay in the detail endpoint);
- exports.

It caches a dataset for ~4 seconds, keyed by `session.time.updated`, message count, sequence range and window flag. This avoids repeating the projection for the analysis + event page + detail requests while keeping live sessions fresh.

### Event paging

- Keyset pagination on `orderKey` (`seq:order:messageID`), not offsets.
- Backward pages return the newest matching rows; the UI prepends older pages and adjusts `scrollTop` by the height delta.
- Forward pages return rows after the newest loaded `orderKey`.
- `around=<eventID|orderKey>` centers a page on a jump target; the UI uses it for Statistics → Trajectory jumps and deep links.
- Duplicate ids are dropped when merging pages.
- `totalMatched` and `totalInSession` are included so the UI can label “Window total” vs “Session total”.

### Sanitization

- Default: `redactValue` recursively replaces credential-shaped keys/strings.
- Token counts (`tokens.input`, `cache.read`, …) are preserved.
- The analysis endpoint strips full tool input/output and caps step prose; the full payload is available only via the event detail endpoint.
- List DTOs contain previews only.
- Reveal is a separate request parameter and is gated by the server/plugin option.
- API data routes require a per-run access token by default. The token is compared in constant time, checked before the reveal policy, and never reflected in errors or logs.
- The token travels in the URL fragment, is stored in `sessionStorage`, and is sent as an `Authorization` header. A per-port token file lets the TUI reuse it; `--no-auth` is loopback-only.

### Diagnostics

`core/diagnostics.ts` is the diagnostics layer: pure, deterministic and local, with no I/O and no writes. `evaluateDiagnostics(events, analysis)` runs the repeated-tool-failure rule over the recorded event order and returns `Diagnostics` (`incidents`, `summary`); the UI never computes incidents itself.

`ObservabilityService.loadDataset` computes diagnostics exactly once per cached dataset, after the turn ids are mirrored onto the full event stream, and attaches them to `analysis.diagnostics`. `Analysis.diagnostics` is optional and stays absent when no incident exists, so analysis payloads produced before diagnostics existed remain valid and the UI can render its empty state.

The compute is eager: it runs on every dataset load, including calls that never read diagnostics, and the result is cached with the dataset. That is an accepted tradeoff (finding M2, deferred): a single compute site in `loadDataset` keeps one code path for analysis, export and the UI, and the engine work is small next to the database reads around it.

Windowed loads are scoped to their window. `fromSeq`/`toSeq` (the `/api/sessions/:id/analysis` query parameters and the plugin RPC `analysis` input) bound the messages the service loads, so incident anchors, attempt counts and recovery verdicts describe only that window. A turn that continues past `toSeq` can look finished inside the window and report `no-recovery-evidence` even though a later success exists beyond the window edge. Read windowed diagnostics as "what this window proves", never as a session-level verdict.

Each `DiagnosticIncident` carries only projected metadata: the tool name, 1-based turn index and turn id, attempt count, recovery state, `why`, the first failure's key names (`inputKeyShape`, no values), event anchors (`firstFailureEventID`, `lastFailureEventID`, `failureEventIDs`, `successEventID`), the projected turn trigger, and two contextual footprint metrics (`elapsed` from `Turn.totalTime`, `stepCostSum` over `Step.cost`). The footprint values are context, not a recovery signal.

Redaction parity: diagnostics are plain DTO fields, so `redactValue(analysis).diagnostics` deep-equals the unredacted diagnostics; `why` and `inputKeyShape` survive, and no raw tool input/output, error text or turn prose is embedded. `/api/sessions/:id/analysis` and the plugin RPC `analysis` handler need no schema or route change because the diagnostics travel inside the existing `analysis` payload.

## UI layer

- Vanilla ES modules, no build step, no external assets.
- `ui/app.js` owns state, routing (`#/s/<id>/<view>?event=…`), filters, views, drawer, export, theme, shortcuts.
- `ui/settings.js` is the typed per-browser preference store (theme, view mode, grouping, statistics defaults). It tolerates unavailable storage.
- `server/opencode-theme.ts` reads OpenCode 2's CLI-selected theme (`cli.json`) so a direct page open matches the TUI; the UI applies it unless the user picked a theme or arrived through a palette deep link.
- `ui/auth.js` consumes the fragment token, stores it per tab and adds the request header.
- `ui/virtual.js` is a variable-height virtual list. Only visible rows (plus overscan) are in the DOM.
- Statistics uses one `<tbody>` per turn with `content-visibility: auto` and an expandable step detail row.
- `ui/markdown.js` renders a safe Markdown subset (raw HTML is escaped first).
- Scroll preservation is a pure helper (`core/paging.ts`, mirrored in `ui/paging.js`) and is tested.

## Plugin surfaces

```text
OpenCode 2 server ── loads ./exports["."] ──► Plugin.define → ctx.rpc.register
OpenCode 2 TUI    ── loads ./exports["./tui"] ──► keymap slash commands + native session panel
                     (prebuilt dist-tui/tui.mjs; types from the src/plugin/tui.ts sidecar)
Browser           ── HTTP ──► local server ──► SQLite adapter
Other clients     ── HTTP/RPC ──► service
```

The `./tui` entry resolves to the prebuilt `dist-tui/tui.mjs` bundle, built by `vite build --config vite.tui.config.ts` from the `src/plugin/tui.ts` entry, so the host loads plain ESM. Loading the raw `.tsx` sources is a Bun-only alternative that this package does not rely on. `src/plugin/tui.tsx` is a typechecked-only scaffold: it exposes `NativeObservabilityView` without mounting or registering it, and it is not part of the bundle. The browser UI remains the primary surface.

The TUI commands are intentionally non-mutating: they resolve the current session from `context.ui.router.current()` and either open the browser URL or, for the native panels (`/statistics`, `/trajectory`), the fullscreen panel. They never enqueue a prompt.

### Native statistics panel

`/statistics` (alias `/stats`) does not open a browser by default. It opens a fullscreen `session.panel`, and the host renders it through the plugin's `session.panel` slot:

```text
/statistics ──► ui.panel.open("statistics", fullscreen)
             ──► slot render (StatisticsView, only when name = statistics)
             ──► createStatisticsState(context.client)
             ──► rpc.analysis({ sessionID }) ──► ObservabilityService
             ──► banner + dense table (columns.ts / stepRows.ts / status.ts)
```

- `state.ts` binds `context.client.rpc(Observability)` once, then issues one `analysis` request per panel open or session change: the effect reacts only to the panel input because the fetch reads no signal in its synchronous window. It keeps loading/error/empty states and drops stale responses with a request ticket.
- `columns.ts` owns breakpoints and ordered column sets; `status.ts` owns the symbol/label/palette table; `stepRows.ts` owns accordion rows. All three are pure and SDK-free, so they are unit-tested directly.
- A keyboard layer gated on the open panel name maps `j`/`Down`, `k`/`Up`, `Enter` and `Esc` to the bridge the mounted panel installs and clears (see the trajectory section for the shared layer). Keys are inert when the panel is closed and also when the host reports the panel as unfocused (`input.focused === false`, F-m3); a host that does not publish `focused` keeps the panel-name gate as the floor. Manual check on a host: open a panel, give focus to another surface and press `j`/`Enter` — rows must not move; return focus and the keys respond. `Esc` closes the panel rather than leaking to the host.
- The view resolves colours only through `themePalette` keys; a status symbol always accompanies the colour.

### Native trajectory panel

`/trajectory` and `/observability` open a second fullscreen `session.panel` claim, with id `trajectory` (issue #6, decision D2):

```text
/trajectory ──► ui.panel.open("trajectory", fullscreen)
            ──► slot render (TrajectoryView, only when name = trajectory)
            ──► createTrajectoryState(context.client)
            ──► rpc.analysis({ sessionID }) ──► ObservabilityService
            ──► turn ledger + per-turn step accordion
```

- `trajectory/state.ts` mirrors the statistics state (same request ticket, reconcile rules and error strings) and reuses `analysisResponse.ts` — the response parser factored out for both panels — plus `clampIndex` and `moveSelection`. `TrajectoryView.tsx` reuses `columns.ts`, `stepRows.ts` and `status.ts`, so both panels stay aligned.
- Each `session.panel` claim renders only for its own panel id and returns `null` otherwise, so the host picks by name and the claims do not collide.
- Without a selected session the panel opener returns `false`: the command shows one toast and falls back to the browser, and `--web` (also on `/observability`) always takes the browser path.
- The keyboard layer is gated on `ui.panel.current()?.name` being either native panel and dispatches to that panel's bridge; it also closes when the host reports the open panel as unfocused, with the name gate as the floor on hosts that do not expose `focused` (F-m3).

## Toolchain notes

`@opentui/core` and `solid-js` are type-only at build time: `vite.tui.config.ts` keeps them (and `@opencode/plugin|theme`) as host-provided externals, and `tsconfig.json` keeps `skipLibCheck` on. The optional `web-tree-sitter@0.25.10` devDependency is deliberately **not** added (F6 deferral): add it only if `skipLibCheck` is dropped or `@opentui/core` types become consumed by value, and pin it at `0.25.10` if that happens.

## Read-only guarantees

- SQLite opened with `readOnly: true`.
- `PRAGMA query_only = ON`.
- Adapter interface contains no mutation method.
- Server routes are GET/HEAD only.
- Plugin handlers only call `listSessions`, `getSession`, `listMessages`, `getFamily`, `analyze`, `events`, `eventDetail`, `export`.
- Tests hash the database file before/after analysis and test that a read-only connection rejects `CREATE TABLE`.

## Error handling

- Missing session/event → 404 with a stable error code.
- Locked database → 503 with a retry hint.
- OpenCode 1 / unknown schema → explicit error; no partial reads.
- Malformed JSON in an individual message → preserved as an `unknown` event with an `_parseError` payload; the rest of the session still loads.
- Unknown message types/content blocks → `unknown` events with uncertainty labels.
- Out-of-order timestamps → flagged; order preserved.
- No start/end timestamps → `unavailable` metrics, not estimates.

## Extension points

- Add a new storage adapter by implementing `ObservabilitySource`.
- Add a new message/content type in `normalize.ts`; unknown types are already preserved.
- Add a metric in `metrics.ts` and surface it in `project.ts`/UI.
- Add a live capture plugin using `session.hook("http.request")`/`"http.response"`; keep it separate from the read-only historical analysis.
- Add a native OpenTUI view by extending `NativeObservabilityView` in the `./tui` `.tsx` sidecar; the scaffold is exposed but not auto-mounted, so wiring it into a TUI slot is a separate step.
- Add a Desktop GUI panel by implementing `./gui-experimental`; the RPC contract is already available.
