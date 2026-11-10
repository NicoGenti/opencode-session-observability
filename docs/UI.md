# UI guide

The UI is a local browser application served by the same read-only process that reads the OpenCode 2 database.

## Layout

- **Sidebar** — searchable session list grouped by project directory, with child sessions nested under their parents; the current session's family (parent/children) appears above the list.
- **Header** — session metadata and stat tiles (turns, input tokens, cache, cost, model/tool time, errors, output speed). Basic mode shows the four headline tiles.
- **Tabs** — Trajectory and Statistics.
- **Topbar** — Basic/Advanced view toggle, refresh, optional 10s live refresh, reveal secrets, export.
- **Detail drawer** — full event or step information, copy actions and links.
- **Settings** — the gear in the sidebar opens theme, view mode, grouping and statistics defaults.

## View modes

The topbar switches between two persisted modes:

| Mode | Header | Trajectory filters | Statistics |
|---|---|---|---|
| **Basic** | Turns, input tokens, cost, errors | Search, kind and the error/tool/compaction/retry/subagent/context chips | Turns with trigger, duration, in/out tokens, cost, status; expandable steps |
| **Advanced** | All eight tiles | Every filter and range control | Full 19-column turn/step table |

The mode is stored per browser and can also be changed from Settings.

## Themes

Settings lists the OpenCode 2 built-in theme names — `aura`, `ayu`, `carbonfox`, `catppuccin` (plus Frappé and Macchiato), `cobalt2`, `cursor`, `dracula`, `everforest`, `flexoki`, `github`, `gruvbox`, `kanagawa`, `lucent-orng`, `material`, `matrix`, `mercury`, `monokai`, `nightowl`, `nord`, `one-dark`, `opencode`, `orng`, `osaka-jade`, `palenight`, `rosepine`, `solarized`, `synthwave84`, `tokyonight`, `vercel`, `vesper` and `zenburn` — plus `System / Auto`, `Light`, `Dark` and `OpenCode (current)`.

`OpenCode (current)` mirrors the theme running in the TUI exactly: the TUI sends the resolved OpenCode colors in a `?palette=` fragment parameter, and the browser validates and applies them. A `?theme=<name>` parameter is kept as a fallback for older clients.

When the page is opened directly (without a TUI deep link), `/api/health` reports the `theme` selected in OpenCode 2's CLI config (`~/.opencode2/config/opencode/cli.json`, with XDG/platform fallbacks), and the UI applies that theme on load. An explicit pick in Settings wins from then on; unknown names fall back to `auto` or the closest light/dark match.

## Session grouping

Sessions are grouped by `directory` (falling back to `projectID`, then “(no project)”). Project groups start collapsed and show the session count; expanding one reveals its sessions. Child sessions are nested under their parent, and those families also start collapsed. Expanded projects and parents persist per browser; grouping and nesting can be turned off in Settings. Searching auto-expands matching branches.

## Trajectory

Rows are chronological by recorded session sequence. Turn headers and step headers are inserted as the sequence changes. Events that could not be attributed remain in place with an **Unattached** header; they are never attached to an arbitrary turn.

### Filters

| Control | Behavior |
|---|---|
| Search | Full-text over prompts, reasoning, assistant text, tool names, tool payloads and serialized event payloads. The field label names the scope; the placeholder is only a hint. Redacted text is searched by default. |
| Kind | `assistant`, `reasoning`, `text`, `tool`, `user`, `synthetic`, `system`, `skill`, `shell`, `compaction`, switches, `idle`, `retry`, `error`, `session`, `unknown` |
| Agent | Event agent, including delegated subagent agents |
| Model | `provider/id` |
| Provider | Provider ID |
| Tool | Tool name |
| Status | Tool status or event status (`completed`, `error`, `running`, …) |
| From / To | Event timestamp range (`datetime-local`) |
| Min / Max prompt tokens | Prompt-token range; events without token usage are excluded when a bound is set |
| Chips | Errors, Tools, Compactions, Retries, Subagents, Context |
| Clear | Clears all filters |

Filters are applied on the server, so search spans the whole session, not only the loaded page. Changing a filter resets to the newest matching page.

### Recovery map

A **Recovery map** strip sits between the filter bar/legend and the ledger. It reads `analysis.diagnostics.incidents` from the deterministic engine verbatim; the UI never computes an incident. With no incidents it shows “No diagnostic incidents recorded in this session.”

Each card shows the tool, a recovery badge, `Turn N`, the projected trigger, **Open in Trajectory**, three stat cells (Attempts, Elapsed (context), Step cost sum (context)), the rule's `why`, and the note that footprint values are contextual to the incident and are not a recovery signal. A value the engine could not record renders `—` with an unavailable title. Cards carry no tool input/output or error text; the `why` is the engine's own rule explanation.

| Recovery state | Badge label | Badge treatment |
|---|---|---|
| `recovered` | Recovery observed | good |
| `possible-recovery` | Possible recovery | accent |
| `no-recovery-evidence` | No recovery evidence | dashed neutral |
| `insufficient-data` | Insufficient data | dashed neutral |

**Open in Trajectory** (or a deep link) loads the event page centered on the incident's first failing event, highlights every event in its `failureEventIDs` set with the accent rule and `accent-weak` background, and opens the drawer. The highlight is rebuilt only from the stored incident whose `firstFailureEventID` matches the opened event; opening any unrelated detail event or switching sessions clears it. Closing the drawer leaves it in place.

### Ledger interactions

- Click a row to open the detail drawer.
- `j`/`k` moves the selection; `Enter` opens it.
- `Load earlier` prepends older rows and preserves the scroll anchor.
- `Load newer` appends rows after the newest loaded event.
- `Jump to latest` returns to the newest matching page.
- The gutter shows `HH:mm:ss.SSS` (UTC). A leading `~` means the block timestamp is approximate; recorded order is exact.
- The footer shows loaded/matched/session counts and the ordering note.

### Detail drawer

- Event metadata: IDs, seq/order, turn/step, agent, model/provider, status, timestamps, tokens, cost, uncertainty.
  Fields without a recorded value collapse under **Not recorded (N)**; IDs, timestamp, turn and order always stay visible.
- Text/reasoning.
- Tool call: status, duration, input JSON, output, error, metadata, diff patches, subagent links.
- Compaction transaction: before/after/removed/summary size/output tokens/cost/duration.
- Full raw payload JSON.
- Actions: Copy JSON, Copy text, Copy metrics, Copy turn chain, Show in Trajectory, open subagent session.
- `Esc` closes the drawer.

## Statistics

One row per turn. The first click expands steps; clicking a step expands its detail row. Expanded step rows use the same column meanings as turns; nested step counts and per-step context delta are unavailable and marked `—`.

### Turn columns

`#`, trigger, start → end, duration, model, provider (sublabel), steps, input/output/reasoning tokens, cache read/write, hit rate, context (latest or cumulative), Δ context, model time, tool time, residual, output speed, cost, status.

The first turn has no context delta. A negative residual is explained in the tooltip (parallel tool overlap).

### Step detail

- Trigger, start/end, model/provider, TTFT (always unavailable), finish, tools, subagents, uncertainty.
- Response or reasoning rendered as Markdown; long text is truncated with a note. The `Response limit` selector (4k/12k/20k/50k/80k characters) is persisted per browser. The analysis endpoint caps each step at 80k characters; the event detail endpoint still has the full recorded text.
- Tool call mini-cards with status/duration, input/output previews, subagent links.
- “Open step in Trajectory” jumps to the assistant step event. A `↗` button on each step row does the same without expanding the row.

### Context basis

- **Latest** — the last step's prompt size for each turn.
- **Cumulative** — the sum of all step prompt sizes in the turn.

The session total row always shows both final context and cumulative prompt, so the selector cannot change totals.

### Show event rows

Adds non-step rows for expanded turns and an **Unattached events** section. These rows are visually muted and explicitly marked “not included in turn/step totals”. They include system/context notices, agent/model/location switches, retries, errors, compactions, synthetic/skill/shell events.

### Diagnostics

Both statistics renderers place a **Diagnostics** section above **Compactions**, using the same card body as the Trajectory strip. Basic and Advanced render byte-identical cards because they share one renderer and one `analysis.diagnostics` source.

### Compactions

Each compaction is a distinct transaction card:

- context before/after (derived),
- removed tokens (signed),
- summary size and output tokens,
- cost,
- duration (unavailable),
- “Open in Trajectory”.

### Totals

The final row is labelled **Session total** when the loaded range covers the whole session, otherwise **Window total**. It shows turn/step counts, token sums, weighted cache hit rate, cost, model/tool times, output speed, and both context figures. `Recorded by OpenCode` compares with the session-row totals.

On desktop, the `#`, Trigger and Status columns stay visible while the 19-column table scrolls horizontally. The frozen columns are released below 700 px so the narrow layout keeps its scroll area.

## Access token

By default every `/api` route except `/api/health` requires an access token. The printed URL carries it in the fragment (`#/?token=…` or `#/s/<id>/<view>?token=…`). On load the UI:

1. reads the token from the fragment,
2. stores it in `sessionStorage` for the tab,
3. removes it from the address bar with `history.replaceState`.

The token is sent as `Authorization: Bearer …` (or `X-Observability-Token`) and is never placed in a server query parameter, log line or error body. If a request returns `401`, the UI clears the stored token and prompts for a new one. Opening a deep link without a token also prompts.

`--no-auth` disables authentication on loopback only. A non-loopback bind always requires authentication. The server writes a per-port token file with user-only permissions so the TUI can reuse the token; an explicit `--token=<value>` is not persisted.

## Reveal secrets

- Default: credential-shaped values are redacted server-side.
- `Reveal secrets` opens a themed confirmation dialog, then reloads the session and events with raw payloads.
- While active, a persistent warning is shown and the button changes to `Hide secrets`.
- Reveal is disabled unless the server starts with `--reveal`; the button is disabled and the API returns 403 for `reveal=1`. When a token is enabled, a valid token is also required before the reveal policy is evaluated.

Redaction preserves token counts and metrics. It targets keys such as `api_key`, `authorization`, `password`, `secret`, `access_token`, `refresh_token`, `credential`, and strings such as bearer tokens, `sk-…`, GitHub/Slack/AWS tokens, private keys, URL credentials and credential query parameters.

## Export

| Format | Content |
|---|---|
| JSON | Generator/version, export time, redaction flag, session, analysis, optional full events, limitations |
| Markdown | Summary, turns, steps, compactions, trajectory, metric basis and limitations |
| HTML | One self-contained report with inline CSS, turn/step tables, compaction cards, trajectory and collapsible payloads |

Exports use the current reveal state. Redacted exports include a warning.

## Deep links

```text
#/s/<sessionID>/trajectory
#/s/<sessionID>/statistics
#/s/<sessionID>/trajectory?event=<eventID>
```

The session ID and event ID are URL-encoded. Opening a link loads the event page centered on the target (`around`), scrolls the ledger to it and opens its drawer, even when the event is outside the newest page. The same “jump” path is used by Statistics → “Open step in Trajectory”.

A Recovery Map card deep-links with `?event=<firstFailureEventID>` and reuses that same centered jump. On load the matching stored incident supplies the full `failureEventIDs` set for the range highlight; an event that is not an incident's first failure clears the highlight, as does a session switch.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `/` | Focus search |
| `1` / `2` | Trajectory / Statistics |
| `e` | Errors only |
| `t` | Tool calls |
| `c` | Compactions |
| `r` | Retries |
| `s` | Subagents |
| `j` / `k` | Next / previous event |
| `Enter` | Open selected event |
| `g` / `G` | Top / bottom |
| `?` | Shortcut dialog |
| `Esc` | Close dialog/drawer |

Shortcuts are ignored while typing in an input, textarea or select.

## Accessibility

- Text labels accompany every status/badge; color is never the only signal.
- Focus-visible outlines; skip link; dialog roles and labels.
- The drawer, Settings, Shortcuts and confirmation dialogs trap focus; closing returns focus to the control that opened them.
- While a dialog or the drawer is open, other keyboard shortcuts are ignored so they cannot act on content behind it.
- Multiple dark and light themes; system preference (`auto`) plus a manual picker in Settings.
- Reduced-motion media query disables transitions.
- Tables use tabular numerals for alignment.
- Mobile: off-canvas sidebar, horizontally scrollable dense table, two-column stat tiles.

## TUI integration

Start the UI once:

```bash
npm start
```

In OpenCode 2:

```text
/observability
/trajectory
/statistics
```

The commands use the session currently shown in the TUI, check `GET /api/health`, and open the corresponding deep link in the browser. The TUI reads the per-port token file written by the server; the plugin option `token` or `OPENCODE_OBSERVABILITY_TOKEN` overrides it (required for an explicit `--token=<value>`). If the UI is not running, a toast shows the start command. If no token is available, the TUI explains how to provide one and does not open an unauthenticated page. The token is never shown in a toast. The commands never mutate the session.

## Troubleshooting

| Symptom | Check |
|---|---|
| “No OpenCode 2 database found” | Start OpenCode 2 once or pass `--db`. The app lists all candidates on failure. |
| “OpenCode 1 database detected” | Point `--db` at the OpenCode 2 store (`session_v2`/`session_message`). |
| “Database is locked” | The analysis is read-only; retry when the session is idle. WAL reads normally work while OpenCode runs. |
| Empty Trajectory | Clear filters or search; check `totalInSession`. |
| `Reveal secrets` disabled | The server was started without `--reveal`. |
| “A valid access token is required” | Reopen the printed URL, paste the token into the prompt, or restart the server so it writes a fresh token file. |
| TUI command says a token is required | Check that the server wrote a token file for the configured port, or set the plugin option `token` / `OPENCODE_OBSERVABILITY_TOKEN`. |
| TUI command says the UI is not running | Run `npm start -- --port 4517` (add `--no-auth` only for unauthenticated loopback), or set the plugin `url` option to the actual port. |
| Port in use | Use `--port 0` (ephemeral) or another port. |
