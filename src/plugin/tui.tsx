// Typed OpenTUI sidecar for `exports["./tui"]`.
// Type-checked by tsconfig.tui.json; intentionally NOT auto-mounted (issue #7
// is provide-only: the browser UI stays the primary surface). Only the JSX type
// is imported, so this module keeps the plugin type-only policy.
export { buildTuiUrl, themePalette } from "./tui.ts";
export { default } from "./tui.ts";
import type { JSX } from "@opentui/solid";
export function NativeObservabilityView(): JSX.Element {
  return (
    <box>
      <text>OpenCode session observability — native view scaffold (browser UI is primary)</text>
    </box>
  );
}
