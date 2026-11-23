import type { CompactionTransaction } from "../../core/types.ts";
import { buildCompactionCards } from "../lib/compactions.ts";
import { Badge } from "./Badge.tsx";

/**
 * One card per compaction transaction (`docs/UI.md:190-199`). Both Basic and
 * Advanced Statistics carry the section, below Diagnostics. The card repeats
 * the standing accounting note so its tokens are never mistaken for step
 * tokens.
 */
export function CompactionCards({
  compactions,
  onDrill,
}: {
  compactions: readonly CompactionTransaction[];
  onDrill(eventID: string): void;
}) {
  const model = buildCompactionCards(compactions);
  return (
    <section aria-label="Compactions" className="mt-2.5">
      <h2 className="m-0 mb-1.5 text-[13px] font-semibold text-text">Compactions</h2>
      {model.cards.length === 0 ? (
        <p className="m-0 text-[11.5px] text-muted">{model.emptyNote}</p>
      ) : (
        <div className="grid gap-2">
          {model.cards.map((card) => (
            <div key={card.key} className="rounded-lg border border-border bg-surface p-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <strong className="text-[12.5px] text-text">{card.title}</strong>
                <Badge label={card.status.label} kind={card.status.kind} />
                <Badge label={card.reason} kind="neutral" />
                <span className="text-[11px] text-muted">{card.time}</span>
                <span className="min-w-0 flex-1" />
                <button
                  type="button"
                  data-event-id={card.eventID}
                  aria-label={`Open ${card.title} in Trajectory`}
                  onClick={() => onDrill(card.eventID)}
                  className="rounded-sm text-[11.5px] text-accent hover:underline"
                >
                  Open in Trajectory
                </button>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5 max-[560px]:grid-cols-1">
                {card.stats.map((stat) => (
                  <div key={stat.label} className="rounded-sm bg-surface-2 px-2 py-1">
                    <div className="text-[11px] text-muted">{stat.label}</div>
                    <div className="text-[12.5px] text-text tabular-nums" title={stat.value.title}>
                      {stat.value.text}
                      {stat.value.basis !== "measured" && stat.value.basis !== "unavailable" ? (
                        <sup className="ml-px align-super text-[10px] text-muted">
                          {stat.value.mark}
                        </sup>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              {card.summaryPreview ? (
                <p className="m-0 mt-1.5 text-[11px] text-muted">{card.summaryPreview}</p>
              ) : null}
              <p className="m-0 mt-1.5 text-[11px] text-muted">{card.note}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
