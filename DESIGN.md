# Design contract — Session Observability

This is the design contract for the UI. It is a local, read-only ledger of OpenCode 2 agent sessions for developers inspecting their own runs; it should feel like reading a precise transcript, not like using a dashboard product. Behaviour and data semantics live in [`docs/UI.md`](docs/UI.md); this file adds the visual contract. All rules below are binding (see DR-6: existing tokens only; no one-off colours; WCAG AA in both themes).

## Purpose

- OpenCode Session Observability is a local-first, read-only viewer for OpenCode 2 session data: turns, steps, tool calls, token accounting, cost, compactions, retries.
- Audience: the developer who just ran an agent and wants to know what happened, on their own machine, without uploading anything.
- Look comes from the artifact: a session is a transcript with a recorded order, so the UI is a ledger of that transcript, not a marketing dashboard.
- Numbers are the content; their provenance (measured, derived, estimated) is part of the content.
- The OpenCode terminal theme is a first-class input: when the TUI opens the browser, the page wears the same palette the user is already looking at.

## Token system

- Tokens are CSS custom properties in `src/ui/styles.css`, reconciled by `src/ui/settings.js` (`THEME_VARS`) and derived per theme by `applyEntry`/`applyPalette` from three seed colours (page, text, accent) across the 38 OpenCode themes.
- Core set: `--page`, `--surface`, `--surface-2`, `--surface-3`, `--text`, `--text-2`, `--muted`, `--border`, `--border-strong`, `--grid`, `--accent`, `--accent-weak`, `--good`, `--warning`, `--serious`, `--critical`, `--shadow`, `--mono`, `--sans`, `--radius`, `--radius-sm`.
- Scales: 6 px controls, 10 px surfaces, 8/12/20 px spacing.
- Provenance of numbers: every metric carries M (measured), D (derived), E (estimated), or — (unavailable), shown as a superscript on stat tiles and aligned in the provenance rail.

## Contrast requirements

- WCAG AA ≥4.5:1 for every text token on its surface, in both themes.
- Light: ink `#0b0b0b` 18.67:1 on ground `#f9f9f7`; muted `#6b6a66` ≥5:1 (replaces `#898781`, 3.50:1); signal `#1f6ac2` 5.25:1 on surface (replaces `#2a78d6`, 4.30:1).
- Status, light: good `#0a7f0a` 5.05:1; critical `#c23535` 5.31:1 on surface and 4.71:1 on its 8% badge tint; warning `#fab219` is backgrounds/borders only, never text; serious `#ec835a` reserved.
- Dark: ground `#0d0d0d`, surface `#1a1a19`, text `#f0efec`; muted `#898781` 4.85:1; signal `#3987e5` 4.79:1; good `#0ca30c` 5.19:1; critical `#ef6a6a` 5.76:1.
- Every derived theme keeps muted ≥4.5:1; `applyEntry` derives muted at 65–70% of text toward page, not 50%.

## Typography

- System UI by decision, not default: offline local Node process, no font payload and no FOIT; no Inter or webfont.
- Mono only where the data is an identifier or code (IDs, gutter timestamps, payloads, diffs, command output); metrics use the sans face with `font-variant-numeric: tabular-nums`.
- Scale: 11 px meta and labels, 12 px table cells and small UI, 13 px control text and row titles, 14 px base, 18 px stat values, 24 px session title; nothing below 11 px. Line heights 1.5 body, 1.25 values, 1.2 title. Weights 400/600/650/680.
- No uppercase chrome; labels and headers are sentence case. The one stamped treatment is the status token — 11 px, 600, uppercase.
- No middle-dot strings as a default separator (`·` only in inline legends; tables, lists, exports use structure). No accented word in a heading.

## Elevation and layout

- Flat interface: borders and surface steps carry structure; exactly one shadow token `--shadow`, used only for floating surfaces (drawer, menu, modal, toast); cards, tiles and table rows never cast shadows; no glass, blur or layered translucency.
- Shapes: 6 px controls/inputs/buttons/tiles/menu/badge containers; 10 px ledger/table wrapper/modal/compaction card; 999 px chips/badges/toast (the only pills); turn and step headers use rules, not radii; the ledger rail is square; no radius above 12 px and no `rounded-2xl`.
- Structure: one vertical transcript ledger rail carries turn headers, step headers and event rows; its left gutter holds the timestamp and turn/step index; the rail thickens at turn boundaries and thins at step boundaries.
- Shell 300 px sidebar, fluid main, 20 px gutters (260 px at ≤1080, off-canvas with a 30 px topbar icon button at ≤900). Topbar holds global session actions only; the selected segment is marked by `accent-weak` plus an inset 2 px signal rule, not colour alone.
- Session header: title, sentence-case metadata, then stat tiles — four columns in both modes (advanced adds a second row of four; two columns at ≤700). Trajectory: filter bar, legend, virtualized ledger, footer; event rows size to content (up to four lines) and never clip.
- Statistics: basic shows seven turn columns; advanced shows the full 19-column set with `#`, `Trigger` and `Status` frozen so row identity survives horizontal scroll, the rest scrolling as one group; turn and step rows share column meanings; horizontal scroll remains available and is documented. Drawer 640 px (100% at ≤700), one scroll region, sections in reading order (event, tool, compaction, payload); only populated fields, with unavailable ones collapsed behind one "Not recorded" disclosure. Modals a 520 px centred card with focus trap and opener restoration. Tables use the full main width; prose in the drawer and step detail is capped at 72ch. Button (primary): signal background, ground text, 6 px radius, 5 px 10 px padding.

## Components

- Stat tile: sentence-case label (11 px muted), value (18 px, 650, tabular), sub-line (11 px `--text-2`), optional provenance superscript; no icon — the number is the icon.
- Ledger row: 64 px gutter with time and rail marks; title 13 px 600; sub-line and preview 12 px `--text-2`; metrics 11 px muted with tabular numerals; 3 px signal rule and `accent-weak` background when selected; hover is `surface-2`; the row is a button and keeps its full accessible name.
- Table: sentence-case header (11 px, 600 on `surface-2`); numeric cells right-aligned and tabular; total row on `surface-3`, sticky at the bottom, labelled "Session total" or "Window total"; frozen identity columns separated by a `border-strong` right rule.
- Chip and badge: 12 px and 11 px; chips toggle with `aria-pressed`; badges use only semantic colours (error, retry, compaction, context, subagent) and always carry text — error uses critical, retry/compaction/context/tool use accent, subagent uses good, uncertain uses a dashed border.
- Recovery Map cards (`.diagnostic-card` with `.diagnostic-head`, `.diagnostic-grid`, `.diagnostic-stat`, `.diagnostic-trigger`, `.diagnostic-why`) mirror the compaction card: 1 px `--border` and `--radius` on `--surface`, `--surface-2` stat cells, the same 8 px rhythm, and only the existing semantic badge scale (good, accent, dashed neutral). Distinct class name, no new component tokens.
- Banner: warning and error use the semantic border/background; body text stays ink, never warning-coloured text; persistent while the condition holds.
- Drawer and modal: `role="dialog"`, `aria-modal="true"`, focus trapped, `Esc` closes, focus returns to the opener; the drawer's close button is the first focus target and the opening row is restored on close; destructive confirmations use the same modal pattern, not `window.confirm`.
- Export: Markdown and HTML reuse the same token values and sentence-case conventions; the export token block is checked against the UI block by a test and is not a second hand-maintained palette; a custom OpenCode palette produces an export in that palette, or the export states which theme it used.
- TUI: deep links carry the resolved palette and theme name and the browser validates them; the TUI never opens an unauthenticated page and never prints the token. `/statistics` (alias `/stats`) renders a native fullscreen `session.panel` in the terminal — a summary banner over a dense turn table — instead of opening a browser; `/statistics:web` (alias `/stats:web`) keeps the browser deep link as the fallback. The native panel consumes the same `analysis` RPC payload and the same `themePalette` keys, so provenance marks and status colours match the web view; the deep-link guarantee above still governs every browser-opening command.

## Color never carries meaning alone

- Every status has a text label; every selected control has a non-colour cue (rule, border, weight).

## Token hygiene

- Do reuse the tokens above on every view, including export.
- Do add a token here before a view uses it; never invent a one-off inside a component.
- Do keep the provenance system visible: M measured, D derived, E estimated, — unavailable.
- Do keep status text next to status colour.
- Don't change the read-only data flow, the Basic/Advanced concept, the 38 OpenCode themes, the documented keyboard model, or the export formats.
- Panel-scoped keys (native Statistics only, active while that panel is open): `j`/`Down` next turn, `k`/`Up` previous turn, `Enter` expand/collapse the selected turn's steps, `Esc` close. They are registered on a layer gated to the open panel, so they never leak to other panels or to the browser keyboard model above.
- Don't use: cream + terracotta (SD1); near-black + acid green as decoration (SD2); hairlines and zero radius as a costume (SD3); tracked all-caps labels, mono eyebrows, middle-dot metadata or `WORD — fragment` labels (SD4); an accented headline word (SD5); decorative 01/02/03 (SD6); fake window chrome (SD7); emerald as the escape accent (SD8).
- Don't use purple/indigo gradients, gradient text, Inter or any webfont, `rounded-2xl`/`shadow-lg` on every surface, icon-in-a-rounded-square, unicode glyphs as the only icon, or red on an idle control.
- Don't use `window.confirm`; use the themed modal. Don't put an all-caps label above content whose heading already says it.

## Provenance rail

- The one bold move: spend the boldness on the provenance rail — the left gutter is a continuous trace of turn → step → event, with timestamps, turn indices and M/D/E marks aligned in one column.
- It is the signature because it comes from the data model, not from a style menu: every number in the product has a basis, and the rail makes that basis structural. Everything else stays quiet.
