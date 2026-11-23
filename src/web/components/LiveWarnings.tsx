import clsx from "clsx";
import type { LiveWarning } from "../../core/live.ts";
import {
  LIVE_WARNINGS_BASIS,
  LIVE_WARNINGS_NOTE,
  LIVE_WARNINGS_TITLE,
  LIVE_WARNING_STATUS,
  cappedEventIDs,
  eventLinkLabel,
  liveWarningLevel,
} from "../lib/live.ts";

const LEVEL_CLASS: Record<"watch" | "strong", string> = {
  // A level is a chip with words, so a semantic text token is allowed; the
  // `--warning` hue itself is reserved for the row's left rule.
  watch: "border-border-strong bg-surface-2 text-text-2",
  strong: "border-critical bg-surface-2 text-critical",
};

export interface LiveWarningsProps {
  warnings: readonly LiveWarning[];
  /** Drill: opens the event in the Trajectory ledger. */
  onDrill(eventID: string): void;
}

/**
 * The live warning rows (`live.js:170-229`), above the active pane and above
 * the guardrails block.
 *
 * Each row mirrors the health-rule rhythm: the rule label, its level, the
 * `Triggered` status, the deterministic note and the capped evidence buttons.
 * The list is re-evaluated on every poll but never persisted or exported, which
 * the closing note states. An empty list renders nothing, so the caller keeps
 * the container out of the way.
 */
export function LiveWarnings({ warnings, onDrill }: LiveWarningsProps) {
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  return (
    <section
      aria-label={LIVE_WARNINGS_TITLE}
      role="status"
      aria-live="polite"
      className="grid gap-1.5 border-b border-border bg-surface px-4 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-[12.5px] font-semibold text-text">
          {LIVE_WARNINGS_TITLE}
        </h2>
        <span className="text-[11.5px] text-muted">{LIVE_WARNINGS_BASIS}</span>
      </div>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {warnings.map((warning) => {
          const level = liveWarningLevel(warning.level);
          const ids = cappedEventIDs(warning);
          return (
            <li
              key={warning.id}
              className="border-l-2 border-warning bg-surface-2 px-2.5 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[12px] font-semibold text-text">
                  {warning.label || "Rule"}
                </span>
                {level ? (
                  <span
                    className={clsx(
                      "rounded-full border px-1.5 py-px text-[11px]",
                      LEVEL_CLASS[level],
                    )}
                  >
                    {level}
                  </span>
                ) : null}
                <span className="text-[11.5px] text-text-2">{LIVE_WARNING_STATUS}</span>
                <span className="min-w-0 flex-1" />
                {ids.length ? (
                  <span className="flex flex-wrap gap-1">
                    {ids.map((eventID, position) => (
                      <button
                        key={eventID}
                        type="button"
                        data-event-id={eventID}
                        aria-label={eventLinkLabel(position)}
                        onClick={() => onDrill(eventID)}
                        className="rounded-sm px-1 text-[11.5px] text-accent hover:underline"
                      >
                        {`Event ${position + 1}`}
                      </button>
                    ))}
                  </span>
                ) : null}
              </div>
              <p className="m-0 mt-0.5 text-[11.5px] text-muted">
                {warning.note ?? ""}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="m-0 text-[11.5px] text-muted">{LIVE_WARNINGS_NOTE}</p>
    </section>
  );
}
