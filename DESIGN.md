---
version: alpha
name: OpenCode Session Observability
description: A local, read-only ledger of OpenCode 2 agent sessions for developers inspecting their own runs; it should feel like reading a precise transcript, not like using a dashboard product.
colors:
  ground: "#f9f9f7"
  ink: "#0b0b0b"
  muted: "#6b6a66"
  signal: "#1f6ac2"
typography:
  display:
    fontFamily: system-ui, -apple-system, "Segoe UI", sans-serif
    fontSize: 24px
    fontWeight: 680
    letterSpacing: -0.02em
  body:
    fontFamily: system-ui, -apple-system, "Segoe UI", sans-serif
    fontSize: 14px
    lineHeight: 1.5
rounded:
  sm: 6px
  md: 10px
spacing:
  sm: 8px
  md: 12px
  lg: 20px
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.ground}"
    rounded: "{rounded.sm}"
    padding: 5px 10px
---

# Design contract — Session Observability

This is the design contract for the UI. It keeps the existing product structure and records the tokens and rules the build implements: contrast-validated colours, sentence-case labels, content-sized ledger rows, frozen table identity and contained focus. Behaviour and data semantics stay in [`docs/UI.md`](docs/UI.md); this file adds the visual contract.

## Overview

OpenCode Session Observability is a local-first, read-only viewer for OpenCode 2 session data: turns, steps, tool calls, token accounting, cost, compactions and retries. Its audience is the developer who just ran an agent and wants to know what happened, on their own machine, without uploading anything.

The look comes from the artifact itself: a session is a transcript with a recorded order. The UI is a ledger of that transcript, not a marketing dashboard. Numbers are the content; their provenance (measured, derived, estimated) is part of the content. The OpenCode terminal theme is a first-class input: when the TUI opens the browser, the page wears the same palette the user is already looking at.

## Colors

- **Ground `#f9f9f7`:** warm neutral paper. Sessions are read like a document, so the page is a reading surface, not a canvas. It is deliberately grayer than parchment; the accent is blue, so the pair does not land in the cream-and-terracotta cluster.
- **Ink `#0b0b0b`:** body text, 18.67:1 on ground.
- **Muted `#6b6a66`:** secondary labels, metadata and sub-lines; 5.27:1 on `#fcfcfb` and 5.14:1 on ground. This replaces `#898781`, which measured 3.50:1. Every derived theme must keep muted at or above 4.5:1; `applyEntry` derives it at 65–70% of text toward page, not 50%.
- **Signal `#1f6ac2`:** one job — navigation, selection and links. 5.25:1 on surface. It is never used for status and never as decoration. This replaces `#2a78d6` (4.30:1).
- **Status, light:** `--good #0a7f0a` (5.05:1), `--critical #c23535` (5.31:1 on surface, 4.71:1 on its 8% badge tint), `--warning #fab219` (backgrounds and borders only, never text), `--serious #ec835a` (reserved).
- **Status, dark:** `--good #0ca30c` (5.19:1), `--critical #ef6a6a` (5.76:1), `--muted #898781` (4.85:1), `--signal #3987e5` (4.79:1).
- **Dark ground:** `#0d0d0d` page, `#1a1a19` surface, `#f0efec` text. Dark is legitimate here: this is a monitoring tool and the OpenCode theme may be dark. The palette is themed as a whole, not a neon signal on black; green is status, not voltage.
- **Rule:** color never carries meaning alone. Every status has a text label; every selected control has a non-color cue (rule, border, weight).

## Typography

- **System UI by decision, not by default.** The app must work offline, from a local Node process, with no font payload and no FOIT. Native rendering is the honest choice for a developer tool; the identity comes from structure and numeric typography, not from a display face. Do not add Inter or a webfont.
- **Mono only where the data is an identifier or code:** event/message/session IDs, gutter timestamps, payloads, diffs, command output. Metrics use the sans face with `font-variant-numeric: tabular-nums`; this keeps columns aligned without making every number look like a log line.
- **Scale:** 11 px meta and labels, 12 px table cells and small UI, 13 px control text and row titles, 14 px base, 18 px stat values, 24 px session title. Nothing below 11 px. Line heights: 1.5 body, 1.25 values, 1.2 title.
- **Weights:** 400 body, 600 labels and table headers, 650 stat values and section titles, 680 session title.
- **No uppercase chrome.** Labels, table headers, stat labels, drawer sections and settings groups are sentence case. The one stamped treatment is the status token: 11 px, 600, uppercase. It is the only place capitals do work, because it marks a state change in the transcript.
- **No middle-dot strings as a default separator.** Inline legends may use `·`; tables, definition lists and exported bullets use their own structure.
- **No accented word in a heading.** Hierarchy comes from size and weight, and the thing that stands out is a number or an identifier.

## Layout

One structural idea: **the transcript ledger.** A single vertical rail carries turn headers, step headers and event rows; the rail's left gutter holds the timestamp and the turn/step index. The rail thickens at turn boundaries and thins at step boundaries, so hierarchy is visible before any text is read.

- **Shell:** 300 px sidebar, fluid main, 20 px gutters. At ≤1080 px the sidebar narrows to 260 px; at ≤900 px it becomes off-canvas with a 30 px icon button in the topbar.
- **Topbar:** global session actions only — Basic/Advanced mode, refresh, live, reveal, export. The selected segment is marked by `accent-weak` plus an inset 2 px signal rule, not by colour alone.
- **Session header:** title, sentence-case metadata, then stat tiles. **Four columns in both modes**; Advanced adds a second row of four instead of wrapping six-plus-two. Two columns at ≤700 px.
- **Trajectory:** filter bar, legend, virtualized ledger, footer. Event rows size to their content (up to four lines: title, sub-line, preview, metrics) and never clip; the virtual list still computes height, but the height comes from content rather than a fixed 84 px.
- **Statistics:** Basic shows seven turn columns. Advanced shows the full 19-column set; `#`, `Trigger` and `Status` are frozen so row identity survives horizontal scrolling, and the remaining columns scroll as one group. Turn and step rows share the same column meanings. Horizontal scroll remains available and is documented.
- **Drawer:** 640 px (100% at ≤700 px), one scroll region, sections in reading order (event, tool, compaction, payload). Only populated fields are listed; unavailable fields collapse behind one "Not recorded" disclosure.
- **Modals:** 520 px card, centred, with focus trap and opener restoration.
- **Measure:** tables use the full main width; prose inside the drawer and step detail is capped at 72ch.

## Elevation & Depth

The interface is flat. Borders and surface steps carry structure. There is exactly one shadow token (`--shadow`), used only for surfaces that float above the page: drawer, menu, modal, toast. Cards, tiles and table rows never cast shadows. No glass, no backdrop blur, no layered translucency.

## Shapes

- 6 px: controls, inputs, buttons, stat tiles, menu items, badges' containers where not pills.
- 10 px: ledger, table wrapper, modal card, compaction card.
- 999 px: chips, badges, toast — the only pills.
- Turn header and step header use rules, not radii; the ledger rail is square by design.
- No radius above 12 px; no `rounded-2xl`.

## Components

- **Stat tile:** sentence-case label (11 px muted), value (18 px 650 tabular), sub-line (11 px `--text-2`), optional provenance superscript. No icon in the tile; the number is the icon.
- **Ledger row:** 64 px gutter with time and rail marks; title 13 px 600; sub-line and preview 12 px `--text-2`; metrics 11 px muted with tabular numerals; 3 px signal rule and `accent-weak` background when selected. Hover is `surface-2`. The row is a button and keeps its full accessible name.
- **Table:** sentence-case header 11 px 600 on `surface-2`; numeric cells right-aligned and tabular; total row on `surface-3`, sticky at the bottom, labelled Session total or Window total; frozen identity columns separated by a `border-strong` right rule.
- **Chip and badge:** 12 px and 11 px; chips toggle with `aria-pressed`; badges only use semantic colours (error, retry, compaction, context, subagent) and always carry text.
- **Banner:** warning and error use the semantic border/background; body text stays ink, never warning-coloured text. Persistent while the condition holds.
- **Drawer and modal:** `role="dialog"`, `aria-modal="true"`, focus trapped, `Esc` closes, focus returns to the opener. The drawer's close button is the first focus target; the row that opened it is restored on close. Destructive confirmations use the same modal pattern, not `window.confirm`.
- **Export:** Markdown and HTML reuse the same token values and the same sentence-case conventions. The export token block is checked against the UI block by a test; it is not a second hand-maintained palette. A custom OpenCode palette produces an export in that palette, or the export states which theme it used.
- **TUI:** deep links carry the resolved palette and theme name; the browser validates them. The TUI never opens an unauthenticated page and never prints the token.

## Do's and Don'ts

- Do reuse the tokens above on every view, including export.
- Do add a token here before a view uses it. Never invent a one-off inside a component.
- Do keep the provenance system visible: M measured, D derived, E estimated, — unavailable.
- Do keep status text next to status colour.
- Don't change: the read-only data flow, the Basic/Advanced concept, the 38 OpenCode themes, the documented keyboard model, or the export formats.
- Don't use: cream + terracotta (SD1); near-black + acid green as decoration (SD2); hairlines and zero radius as a costume (SD3); tracked all-caps labels, mono eyebrows, middle-dot metadata or `WORD — fragment` labels (SD4); an accented headline word (SD5); decorative 01/02/03 (SD6); fake window chrome (SD7); emerald as the escape accent (SD8).
- Don't use: purple/indigo gradients, gradient text, Inter or any webfont, `rounded-2xl`/`shadow-lg` on every surface, icon-in-a-rounded-square, unicode glyphs as the only icon, or red on an idle control.
- Don't use `window.confirm`; use the themed modal.
- Don't put an all-caps label above content whose heading already says it.

## The one bold move

Spend the boldness on the **provenance rail**: the left gutter is a continuous trace of turn → step → event, with timestamps, turn indices and M/D/E marks aligned in one column. It is the signature because it comes from the data model, not from a style menu: every number in the product has a basis, and the rail makes that basis structural. Everything else stays quiet.
