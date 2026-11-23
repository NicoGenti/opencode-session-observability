import clsx from "clsx";
import type { Recommendations } from "../../core/recommendations.ts";
import { buildRecommendations } from "../lib/recommendations.ts";

/**
 * Recommendations (`docs/UI.md:167-173`): facts as plain cards, hypotheses with
 * the dashed uncertain treatment and the standing "not a diagnosis" copy, rows
 * in the DTO's fixed order. No sort control, no score, no ranking. An absent
 * rider renders nothing.
 */
export function RecommendationsSection({
  recommendations,
  onDrill,
}: {
  recommendations: Recommendations | null | undefined;
  onDrill(eventID: string): void;
}) {
  const model = buildRecommendations(recommendations);
  if (model.empty) return null;
  return (
    <section aria-label={model.title} className="mt-2.5 rounded-lg border border-border bg-surface p-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-[13px] font-semibold text-text">{model.title}</h2>
        <span className="text-[11.5px] text-text-2 tabular-nums">{model.counts}</span>
        <span className="text-[11.5px] text-muted">{model.rail}</span>
      </div>

      <ul className="m-0 mt-2 grid list-none gap-1.5 p-0">
        {model.rows.map((row) => (
          <li
            key={row.key}
            data-rule={row.ruleID}
            data-source={row.source}
            className={clsx(
              "rounded-sm border bg-surface px-2 py-1.5",
              row.kind === "hypothesis" ? "border-dashed border-border-strong" : "border-border",
            )}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={clsx(
                  "rounded-full border px-1.5 py-px text-[10.5px] text-text-2",
                  row.kind === "hypothesis" ? "border-border-strong" : "border-border",
                )}
              >
                {row.kindLabel}
              </span>
              <span className="text-[12px] font-semibold text-text">{row.label}</span>
              <span className="text-[11px] text-muted">{row.source}</span>
              {row.disclaimer ? (
                <span className="text-[10.5px] text-muted">{row.disclaimer}</span>
              ) : null}
              <span className="min-w-0 flex-1" />
              {row.links.map((link) => (
                <button
                  key={link.key}
                  type="button"
                  data-event-id={link.eventID}
                  aria-label={link.ariaLabel}
                  onClick={() => onDrill(link.eventID)}
                  className="rounded-sm text-[11px] text-accent hover:underline"
                >
                  {link.label}
                </button>
              ))}
            </div>
            <p className="m-0 mt-1 text-[11px] text-muted">{row.note}</p>
          </li>
        ))}
      </ul>

      <p className="m-0 mt-2 text-[11.5px] text-text-2">{model.standingNote}</p>
      {model.notes.length > 0 ? (
        <ul className="m-0 mt-1 pl-4 text-[11px] text-muted">
          {model.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
