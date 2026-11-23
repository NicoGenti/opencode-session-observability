import { useMemo } from "react";
import type { DiagnosticIncident } from "../../core/diagnostics.ts";
import { buildRecoveryMap } from "../lib/diagnostics.ts";
import type { DiagnosticsStatus } from "../hooks/useEvents.ts";
import { Badge } from "./Badge.tsx";

export interface DiagnosticsSectionProps {
  incidents: readonly DiagnosticIncident[];
  status: DiagnosticsStatus;
  error: string | null;
  /** Drill: sets the `?event=` route and reveals that row. */
  onDrill(eventID: string): void;
}

/**
 * The Recovery map strip that sits between the legend and the ledger
 * (`recoveryMapHtml`, `app.js:1640-1649`).
 *
 * Every card is text first: the tool, the recovery label, the turn number, the
 * trigger, the three labelled stat cells and the engine's `why`. The badge kind
 * only selects a token treatment, so colour never carries a state alone. The
 * drill button carries `data-event-id`, which is the same route/scroll hook the
 * ledger and the Statistics drill links use.
 *
 * The strip is content-sized up to its cap: `max-h` with `overflow-auto`, never
 * a height, so few cards leave no reserved band. The cap is in `dvh`, not `%`,
 * because the two render sites size the box differently. In the Trajectory flex
 * column a percentage resolves against the full pane, but the Statistics grid
 * sizes its row from this item's own content, so a `%` cap left the row at the
 * content height while the box capped: a blank band under the cards. Viewport
 * units are independent of that ancestor and cap identically in both views.
 */
export function DiagnosticsSection({
  incidents,
  status,
  error,
  onDrill,
}: DiagnosticsSectionProps) {
  const model = useMemo(() => buildRecoveryMap(incidents), [incidents]);

  return (
    <section
      aria-label={model.title}
      className="mb-2.5 max-h-[45dvh] shrink-0 overflow-auto pr-1"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-[13px] font-semibold text-text">{model.title}</h2>
        <span className="text-[11.5px] text-muted">{model.countLabel}</span>
      </div>

      {status === "loading" ? (
        <p className="m-0 mt-1 text-[11.5px] text-muted">Loading diagnostics…</p>
      ) : null}

      {status === "error" ? (
        <p role="status" className="m-0 mt-1 text-[11.5px] text-text-2">
          {error}
        </p>
      ) : null}

      {status === "ready" && model.empty ? (
        <p className="m-0 mt-1 text-[11.5px] text-muted">{model.note}</p>
      ) : null}

      {model.cards.length > 0 ? (
        <div className="mt-1.5 grid gap-2">
          {model.cards.map((card) => (
            <div
              key={card.key}
              className="rounded-lg border border-border bg-surface p-2.5"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge label={card.tool} kind="tool" />
                <Badge label={card.badge.label} kind={card.badge.kind} />
                <span className="text-[11px] text-muted">{card.turnText}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-2">
                  {card.triggerLabel}
                </span>
                <button
                  type="button"
                  data-event-id={card.eventID}
                  aria-label={card.openLabel}
                  onClick={() => onDrill(card.eventID)}
                  className="rounded-sm px-1 text-[12px] text-accent hover:underline"
                >
                  Open in Trajectory
                </button>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5 max-[560px]:grid-cols-1">
                {card.stats.map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-sm bg-surface-2 px-2 py-1"
                  >
                    <div className="text-[11px] text-muted">{stat.label}</div>
                    <div
                      className="text-[13px] text-text tabular-nums"
                      title={stat.value.title}
                    >
                      {stat.value.text}
                      {stat.value.basis !== "measured" && stat.value.mark !== "—" ? (
                        <sup className="ml-px text-[10px] text-muted">
                          {stat.value.mark}
                        </sup>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              <p className="m-0 mt-1.5 text-[11.5px] text-muted">{card.why}</p>
              <p className="m-0 mt-1 text-[11px] text-muted">{card.note}</p>
            </div>
          ))}
        </div>
      ) : null}

      {model.overflow ? (
        <p className="m-0 mt-1.5 text-[11.5px] text-muted">{model.overflow.text}</p>
      ) : null}
    </section>
  );
}
