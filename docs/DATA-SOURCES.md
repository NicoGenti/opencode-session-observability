# Data sources and limitations

This document records what the implementation actually reads, with evidence from the installed OpenCode 2.2.x packages and a real local session database. It is intentionally conservative: if a field is not persisted, the UI says so.

## Environment inspected

| Component | Version / location |
|---|---|
| OpenCode 2 CLI | `@opencode/cli` **2.2.5** (`~/.opencode2/node_modules/@opencode/cli/bin/opencode.exe`) |
| OpenCode 2 plugin types | `@opencode/plugin` **2.2.6** |
| OpenCode 2 client/schema types | `@opencode/client` **2.2.6**, `@opencode/schema` **2.2.6** |
| Session database | `%USERPROFILE%\.opencode2\data\opencode\opencode.db` (XDG layout) |
| Isolated launcher | `opencode2.cmd` sets `XDG_DATA_HOME=%USERPROFILE%\.opencode2\data`, `XDG_CONFIG_HOME=...\config`, `XDG_STATE_HOME=...\state` |
| Legacy OpenCode 1 | `opencode` 1.18.35 at `%USERPROFILE%\.local\share\opencode\opencode.db` (not supported) |

The OpenCode 2 store is SQLite with WAL (`opencode.db`, `opencode.db-wal`, `opencode.db-shm`). The app opens it read-only and can read while OpenCode is running.

The default discovery is priority-ordered: environment overrides, `XDG_DATA_HOME`, the isolated `~/.opencode2` profile, then standard locations. A path passed with `--db` always wins.

## Schema used

Only two tables are read.

### `session_v2`

One row per session. Fields used:

```sql
id, project_id, parent_id, fork_session_id, fork_boundary,
slug, directory, title, version, cost,
tokens_input, tokens_output, tokens_reasoning,
tokens_cache_read, tokens_cache_write,
revert, idle_outcome, time_created, time_updated,
time_busy, time_idle, time_archived, resume_attempts,
time_suspended, agent, model
```

- `parent_id` links subagent sessions to their parent.
- `fork_session_id` / `fork_boundary` record forked sessions.
- `revert` records a staged revert.
- `idle_outcome` is `succeeded`, `failed` or `interrupted`.
- `time_busy` / `time_idle` distinguish the current execution from the last completed one.
- `resume_attempts` / `time_suspended` record resume/suspend attempts.
- `model` is a JSON object `{ providerID, id, variant? }`.
- The `tokens_*` and `cost` columns are OpenCode's own session totals. They can include auxiliary model calls (title, generation, compaction), so they are shown separately from computed totals.

### `session_message`

One row per message or non-step event.

```sql
id, session_id, type, seq, time_created, time_updated, data
```

- `seq` is the recorded per-session sequence (with gaps). It is authoritative for order.
- `data` is JSON with the type-specific payload.
- `type` values observed in the inspected database:

| `type` | Count (sample) | Meaning |
|---|---:|---|
| `assistant` | 32,072 | one model step |
| `idle` | 2,486 | end of an execution; `outcome` |
| `user` | 2,460 | user prompt |
| `agent-switched` | 378 | agent change |
| `synthetic` | 162 | synthetic/automatic message (e.g. shell result) |
| `system` | 83 | system/instruction/context update |
| `model-switched` | 27 | model/provider change |
| `compaction` | 11 | context compaction transaction |
| `location-switched` | 1 | route/location change |

The schema also defines `skill`, `shell` and an `unknown` fallback. `session_part` exists but was empty in the inspected store; assistant content lives inside `session_message.data.content`.

## Payload semantics

### User

```json
{
  "time": { "created": 1794082875861 },
  "text": "…",
  "files": [],
  "agents": [],
  "skills": [],
  "metadata": {}
}
```

### Assistant

```json
{
  "time": { "created": 1794082886400, "streamed": 1794082890845, "completed": 1794082891536 },
  "agent": "orchestrator",
  "model": { "id": "…", "providerID": "…", "variant": "default" },
  "content": [ … ],
  "finish": "stop",
  "rawFinish": "stop",
  "tokens": {
    "input": 71,
    "output": 991,
    "reasoning": 0,
    "cache": { "read": 30336, "write": 0 }
  },
  "cost": 0,
  "error": { "type": "…", "message": "…", "status": 200 },
  "retry": { "attempt": 2, "at": 1794082894766, "error": { … } }
}
```

`@opencode/schema/session-message` documents the timestamps precisely:

- `time.created` — start of the model request.
- `time.streamed` — **when the provider response body ended, before tool settlement**.
- `time.completed` — when the step completed, after tool settlement.

That distinction is why model time uses `created → streamed`, while step total uses `created → completed`.

Assistant content is an array of tagged blocks:

```json
[
  { "type": "reasoning", "text": "…", "time": { "created": 1794082892115, "completed": 1794082894497 } },
  { "type": "text", "text": "…" },
  {
    "type": "tool",
    "id": "call_…",
    "name": "write",
    "executed": false,
    "state": {
      "status": "completed",
      "input": { "path": "…", "content": "…" },
      "content": [{ "type": "text", "text": "Created file successfully: …" }],
      "metadata": { "truncated": false, "files": [{ "file": "…", "patch": "…" }] }
    },
    "time": { "created": 1794082888590, "ran": 1794082890839, "completed": 1794082890857 }
  }
]
```

Tool states: `streaming`, `running`, `completed`, `error`. The error state carries `error.type`, `error.message`, `error.status`, `error.response.body`, `error.retryAfterMs` and optional content/metadata.

### Synthetic

```json
{
  "time": { "created": … },
  "text": "<shell …>…",
  "metadata": { "source": "shell", "shellID": "…", "state": "completed", "truncated": false, "exit": 0 }
}
```

### System

```json
{
  "time": { "created": … },
  "text": "The instructions from … changed. Here's the diff: …",
  "description": "Instructions updated: core/instructions",
  "metadata": { "notice": "instructions", "instructionSources": ["core/instructions"] }
}
```

### Compaction

```json
{
  "time": { "created": 1793653024569 },
  "status": "completed",
  "reason": "manual",
  "model": { … },
  "summary": "## Objective …",
  "recent": "[User]: … [Assistant]: …",
  "tokens": { "input": 401851, "output": 454, "reasoning": 905, "cache": { "read": 0, "write": 0 } },
  "cost": 0.0125,
  "metadata": { "keepID": "msg_…" }
}
```

Only a timestamp is recorded; there is no compaction start/end pair. The `tokens` are the compaction model call's usage, not a direct “tokens removed” measurement. The UI therefore labels before/after as derived and duration as unavailable.

### Switches and idle

```json
{ "type": "agent-switched", "data": { "time": …, "agent": "…", "previous": "…" } }
{ "type": "model-switched", "data": { "time": …, "model": { … }, "previous": { … } } }
{ "type": "location-switched", "data": { "time": …, "location": { "directory": "…" }, "projectID": "…", "subpath": "…", "previous": { … } } }
{ "type": "idle", "data": { "time": …, "outcome": "succeeded|failed|interrupted", "error": { … } } }
```

## Subagents and delegation

- A subagent session has `session_v2.parent_id`.
- The `subagent` tool call's input contains `agent`, `description`, `prompt`.
- Its completed content usually contains a marker:

```text
<subagent sessionID="ses_…" state="completed">…</subagent>
```

The normalizer extracts `sessionID` from that marker and from tool metadata keys such as `childSessionID`. The UI links to the child session; the link is marked derived because it comes from the tool result text.

The two linkage sources are not interchangeable: `session_v2.parent_id` is recorded metadata on the child row, while the `<subagent sessionID="…">` marker is derived from the parent's tool result text. Delegation recovery anchors a child on the recorded parent `subagent` tool event that names it, together with that event's `delegatedAgent` stamp and input; only when no such event exists does it fall back to the child's earliest recorded timestamp, and that fallback is recorded in `uncertainty` rather than hidden.

`ObservabilityService.familyRecovery` loads the parent and every direct child full-range, never over a window: a windowed child stream cannot support a complete failure picture. At most eight direct children are assessed, ordered by child `timeCreated` and then session id; the rest are not dropped silently — `totalChildren` reports the full count and `childrenCapped`, plus a `notes` entry, says how many were skipped. A child whose dataset cannot be loaded degrades to an empty synthetic child classified `insufficient-data` plus a sanitized note. The result is its own DTO (`schemaVersion: 1`, `depth: 1`, `redacted: !reveal`) served by `GET /api/sessions/{id}/family-recovery`; it is not embedded in `Analysis`.

Recovery patterns are classification labels over recorded events, never measurements:

| Pattern | What is read | Basis |
|---|---|---|
| `no-child-failure` | child stream complete and no failure evidence recorded | `derived` |
| `child-failed-no-parent-reaction` | child failure evidence, and no delegation event after the anchor | `derived` |
| `parent-retried-same-agent` | first later delegation stamps the same agent as the anchor, and the two inputs are not comparable | `derived` |
| `parent-retried-identical-delegation-input` | same agent, and the two comparable inputs compare identical | `derived` |
| `parent-retried-with-changed-delegation-input` | same agent, and the two comparable inputs differ (the input-change proxy) | `derived` |
| `parent-fallback-to-other-agent` | first later delegation stamps a different agent | `derived` |
| `parent-reaction-unclear` | later delegation exists but no agent is stamped, or the anchor has none | `derived` |
| `insufficient-data` | child stream incomplete, no anchor, or parent stream incomplete | `unavailable` |

What stays recorded inside those assessments: the child session id, the anchoring parent event and turn ids, the stamped agents, the later delegation event ids and the child diagnostics summary are copied or measured. Only the pattern and reaction labels are `derived`. Child failure evidence is `measured` only when the child stream is complete; on a windowed stream the child's failure picture is unavailable and the pattern is `insufficient-data`.

Prompt adaptation is out of reach: adapted prompts are not observable in the data. Nothing records a rewritten or re-scoped child prompt, and delegation inputs are compared as recorded values, never interpreted. The only related signal is the delegation-input change proxy — a comparison of two recorded tool inputs — and it is labelled `derived`; it reports that the input changed, not what changed or why.

## OpenCode 2 plugin API

The installed `@opencode/plugin` 2.2.6 exposes (among others):

- **Server part**: `Plugin.define`, `ctx.session` (`list`, `get`, `context`, `prompt`, …), `ctx.command`, `ctx.tool`, `ctx.rpc`, hooks (`session.hook("http.request")`, `"http.response"`, `"retry"`, …), `ctx.event`.
- **TUI part**: `@opencode/plugin/tui`, `context.ui.router`, `context.ui.slot`, `context.keymap.layer`, `context.ui.toast`, `context.data.session.message`.
- **GUI part (experimental)**: `./gui-experimental`, Solid panels.
- **RPC**: `Rpc.define` and `ctx.rpc.register`.

The plugin uses only:

- `ctx.session.list/get/context` in the server part;
- `ctx.rpc.register` for read-only analysis methods;
- `context.keymap.layer`, `context.ui.router.current` and `context.ui.toast` in the TUI part.

It does **not** call `session.prompt`, `compact`, `interrupt`, `switchModel`, `switchAgent`, `synthetic`, or any mutation.

`session.hook("http.response")` is a live hook. It is useful for optional live capture, but it cannot reconstruct historical request headers or approvals. This app does not rely on it.

### TUI routing and status badge

The TUI part exposes a dual-mode slash surface. `/statistics` (alias `/stats`) takes an optional argument: with no argument, or anything other than the browser tokens `--web`, `-w`, `web`, it attempts the native route; the browser tokens — and the dedicated `/statistics:web` / `/stats:web` commands — open the local web UI through the unchanged `openView("statistics")` path.

Native `/statistics` is live: it opens the built-in fullscreen Statistics panel with `context.ui.panel.open("statistics", { presentation: "fullscreen" })` and renders it through the plugin's appended `session.panel` slot, so no registration step is involved. When the host has no session selected the panel cannot open, so the command shows the `"No session is selected, so there is no statistics to show."` toast and falls back to the browser. The reserved route names `statistics` and `trajectory` plus the ref-counted `registerNativeView(name)` registry (`STATISTICS_ROUTE` / `TRAJECTORY_ROUTE` in `tui-native.ts`) remain the contract for future router-page views: `openNativeStatistics` keeps its browser-fallback behaviour for that seam, and a view owner that registers a page must still call `ui.router.register(page)` themselves before the router route can be navigated.

The status badge seam is `formatStatusBadge({ cost, cacheHitRate })` plus `fetchSessionStatus(context, sessionID, options?)`. The fetcher reads the session cost from the SDK (`context.data.session.cost`) and the cache hit rate from `GET /api/sessions/{id}/analysis` (`analysis.totals.cacheHitRate.value`), adding `Authorization: Bearer <token>` only when `/api/health` reports `authRequired`. Results are cached per session for at least 15 s with one in-flight request per session, including negative results. Every failure (offline, 401, unparsable body, out-of-domain value) resolves to `cacheHitRate: null`; the module never throws and never toasts. The `prompt.footer.status` slot (#6) is the wiring target: the badge shows `"$X.XX · cache NN%"` and `n/a` for missing data.

## Deliberately unavailable data

| Wanted | Status | Why |
|---|---|---|
| TTFT | unavailable | OpenCode persists `created`, `streamed` (end of provider stream) and `completed`; no first-token timestamp. |
| Approvals / permission decisions | unavailable for history | Historical session rows do not store permission asks/replies. Live TUI has `permission.asked`, but it is not part of the persisted session. |
| Request headers | unavailable for history | Only live `http.request`/`model.request` hooks see them. |
| Tool-set changes | unavailable | Not persisted as a session message. |
| Exact compaction duration | unavailable | Only the compaction completion timestamp exists. |
| Per-call title/generate usage | unavailable in the session message stream | Session-row totals can include them, but they are not attributable to a turn/step from the stored messages. |
| System-prompt text changes | partially available | `system` messages with `description`/metadata and diffs; not every internal prompt change is persisted. |
| “Restore” marker | partially available | `fork`, `revert`, `resume_attempts`, `time_suspended` are surfaced as session provenance; a generic “restore” event is not a separate persisted type. |

The UI labels these clearly in legends and the export limitations section.

## API source

For the OpenCode 2 server plugin, the source is the plugin client:

```ts
ctx.session.list()
ctx.session.get({ sessionID })
ctx.session.context({ sessionID })
```

`session.context` returns the ordered `SessionMessageInfo[]`. It does not expose `seq`, so the adapter assigns a synthetic sequence from array position and records that fact in `capabilities.notes`. The array order is authoritative.

## Version drift

OpenCode 2 is evolving. The adapter isolates the storage/API shape:

- `src/core/adapters/sqlite.ts` owns `session_v2`/`session_message` SQL.
- `src/core/adapters/api.ts` owns `SessionInfo`/`SessionMessageInfo` mapping.
- The normalizer and projection layers only consume `RawMessage` and `SessionMeta`.

If a future OpenCode release changes the tables, only the adapter and its schema detection should need changes. Unknown message types and content blocks are kept as `unknown` events with an uncertainty label rather than dropped.

## Privacy notes

- The inspected store contains real prompts, tool outputs, file contents and, in some payloads, credentials. The app redacts credential-shaped keys and strings by default.
- `auth.json`, `service.json`, provider credentials and environment variables are never read or served.
- The local HTTP server binds `127.0.0.1` by default, sets a strict CSP and does not enable CORS.
- Reveal mode is explicit and confirmed; it is disabled unless the server starts with `--reveal`.
