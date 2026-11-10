import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import {
  badgeLineInvalidated,
  statusBadgeText,
  type StatusContext,
} from "../tui-status.ts";

/**
 * Slot input subset the badge reads, structurally compatible with the host's
 * `PromptFooterInput` (the SDK does not export the type).
 */
export interface StatusBadgeInput {
  readonly sessionID?: string;
  readonly mode?: "normal" | "shell";
  readonly showDetails?: boolean;
}

function StatusBadge(props: {
  readonly context: StatusContext;
  readonly input: StatusBadgeInput;
}) {
  const [line, setLine] = createSignal<string | null>(null);
  let lastSessionID: string | undefined;

  createEffect(() => {
    // The slot input is reactive: reading the id here re-runs the effect when
    // the host switches session or clears the selection.
    const sessionID = props.input.sessionID;
    let active = true;
    onCleanup(() => {
      active = false;
    });
    // Keep the previous line across same-session re-renders (e.g. the host
    // toggling `showDetails`): only a session change clears it, so the footer
    // never blinks empty while the cached value is re-read.
    if (badgeLineInvalidated(lastSessionID, sessionID)) {
      lastSessionID = sessionID;
      setLine(null);
    }
    // `statusBadgeText` never rejects, returns `null` without a session id and
    // degrades each field to `n/a` when the analysis read fails.
    void statusBadgeText(props.context, sessionID).then((text) => {
      if (active) setLine(text);
    });
  });

  return (
    <Show when={line()}>
      <text>{line()}</text>
    </Show>
  );
}

/**
 * `prompt.footer.status` render body (issue #6, decision D3). It shows exactly
 * one line and nothing when the host passes no session id. Visibility is owned
 * by the host (`showDetails`); the badge never toasts and never throws.
 *
 * The data path is `statusBadgeText` in `tui-status.ts`; that module owns the
 * cached fetch and the formatter, which keeps this component JSX-only and lets
 * the Node test suite cover the behaviour without a JSX loader.
 */
export function statusBadgeElement(
  context: StatusContext,
  input: StatusBadgeInput,
) {
  return <StatusBadge context={context} input={input} />;
}
