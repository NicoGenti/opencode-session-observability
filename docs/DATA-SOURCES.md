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
