import clsx from "clsx";
import { formatDateTime } from "../lib/format.ts";
import {
  LIVE_BADGE_TITLE,
  LIVE_UNAVAILABLE_VIEW,
  liveBadgeView,
  liveStaleText,
  liveUnavailableText,
  newEventsLabel,
  type LiveBadgeKind,
  type LiveFrame,
} from "../lib/live.ts";

const KIND_CLASS: Record<LiveBadgeKind, string> = {
  // `--warning` is a border/background tint only; the text stays ink.
  live: "border-warning bg-surface-2 text-text",
  incomplete: "border-dashed border-border-strong bg-surface-2 text-text",
  historical: "border-border bg-surface-2 text-text",
  unavailable: "border-dashed border-border-strong bg-surface-2 text-text",
};

export interface LiveBadgeProps {
  frame: LiveFrame | null;
  /** The first-poll failure: no frame exists yet. */
  error: string | null;
}

/**
 * The liveness chip (`live.js:63-98`, `app.js:1272-1296`).
 *
 * Three documented readings plus "Live unavailable" when the first poll failed
 * and there is no frame to mark stale. Every reading keeps its sentence-case
 * text; colour never carries the state alone. The poll error is rendered as
 * text, never as markup.
 */
export function LiveBadge({ frame, error }: LiveBadgeProps) {
  if (!frame && !error) return null;

  const view = frame ? liveBadgeView(frame) : LIVE_UNAVAILABLE_VIEW;
  return (
    <span
      className={clsx(
        "inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-full border px-2 py-px text-[11.5px]",
        KIND_CLASS[view.kind],
      )}
      title={frame ? LIVE_BADGE_TITLE : undefined}
    >
      <span className="font-semibold">{view.label}</span>
      <span className="text-muted">
        {frame
          ? `derived · as of ${formatDateTime(frame.asOf)}`
          : liveUnavailableText(error)}
      </span>
      {frame ? (
        <>
          {newEventsLabel(frame.newEvents) ? (
            <span
              title="Events recorded since the last poll"
              className="text-text-2 tabular-nums"
            >
              {newEventsLabel(frame.newEvents)}
            </span>
          ) : null}
          {frame.stale === true ? (
            <span role="status" className="text-text-2">
              {liveStaleText(frame.staleError)}
            </span>
          ) : null}
        </>
      ) : null}
    </span>
  );
}
