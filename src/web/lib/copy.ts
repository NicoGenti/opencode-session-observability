/**
 * The user-visible copy and keyboard table that the shell, the shortcuts dialog
 * and the export menu render. Keeping them here lets the documented contracts
 * (`docs/UI.md:296-326`, the skip link and the export menu) be asserted without
 * a DOM, and leaves the components as renderers.
 */

export const SKIP_LINK = Object.freeze({
  href: "#main",
  label: "Skip to content",
});

export interface ShortcutRow {
  keys: readonly string[];
  action: string;
}

/**
 * Every documented shortcut, in the order the reference dialog lists it. Copy
 * matches the legacy dialog; `Enter` is the row the docs table adds.
 */
export const SHORTCUT_ROWS: readonly ShortcutRow[] = Object.freeze([
  Object.freeze({ keys: Object.freeze(["/"]), action: "Focus the event search" }),
  Object.freeze({ keys: Object.freeze(["1"]), action: "Trajectory view" }),
  Object.freeze({ keys: Object.freeze(["2"]), action: "Statistics view" }),
  Object.freeze({ keys: Object.freeze(["e"]), action: "Toggle errors-only" }),
  Object.freeze({ keys: Object.freeze(["t"]), action: "Toggle tool calls" }),
  Object.freeze({ keys: Object.freeze(["c"]), action: "Toggle compactions" }),
  Object.freeze({ keys: Object.freeze(["r"]), action: "Toggle retries" }),
  Object.freeze({ keys: Object.freeze(["s"]), action: "Toggle subagent calls" }),
  Object.freeze({ keys: Object.freeze(["j", "k"]), action: "Next / previous event" }),
  Object.freeze({ keys: Object.freeze(["Enter"]), action: "Open the selected event" }),
  Object.freeze({ keys: Object.freeze(["g", "G"]), action: "Jump to start / end" }),
  Object.freeze({ keys: Object.freeze(["Esc"]), action: "Close the detail drawer or dialog" }),
  Object.freeze({ keys: Object.freeze(["?"]), action: "This dialog" }),
]);

export type ExportKind = "json" | "markdown" | "html";

export const EXPORT_ITEMS: readonly { id: ExportKind; label: string }[] =
  Object.freeze([
    Object.freeze({ id: "json", label: "JSON (full analysis)" }),
    Object.freeze({ id: "markdown", label: "Markdown report" }),
    Object.freeze({ id: "html", label: "HTML report" }),
  ]);

/** Reveal is always off until Phase 6 wires it, so this is the current note. */
export const EXPORT_NOTE = "Redacted by default";
