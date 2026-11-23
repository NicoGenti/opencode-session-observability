import clsx from "clsx";
import type { HealthState, SessionHealth } from "../../core/health.ts";
import {
  HEALTH_BREAKDOWN_ID,
  HEALTH_DISCLAIMER,
  HEALTH_INSUFFICIENT_COPY,
  buildHealthBadge,
  buildHealthBreakdown,
} from "../lib/health.ts";
import type { Turn } from "../../core/types.ts";

const STATE_RULE: Record<HealthState, string> = {
  healthy: "border-good",
  watch: "border-warning",
  degraded: "border-critical",
};

/**
 * The Advanced Statistics health badge (`DESIGN.md:52`): a real button carrying
 * the state as text, the standing disclaimer in `title`/`aria-label`, and the
 * dashed uncertain treatment when the analysis is insufficient.
 */
export function HealthBadge({
  health,
  open,
  onToggle,
}: {
  health: SessionHealth | null | undefined;
  open: boolean;
  onToggle(): void;
}) {
  const badge = buildHealthBadge(health);
  return (
    <button
      type="button"
      data-health-toggle
      aria-expanded={open}
      aria-controls={HEALTH_BREAKDOWN_ID}
      aria-label={badge.ariaLabel}
      title={badge.title}
      onClick={onToggle}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border bg-surface-2 px-2 py-0.5 text-[11.5px] text-text",
        badge.insufficient ? "border-dashed border-border-strong" : STATE_RULE[badge.state],
      )}
    >
      <span>Session health: {badge.word}</span>
      {badge.subLabel ? (
        <span className="text-[10.5px] text-muted">insufficient data</span>
      ) : null}
    </button>
  );
}

/**
 * The rules breakdown the badge toggles: insufficiency first, then every rule
 * with its level, status, observed-values note and capped drill links, then the
 * standing disclaimer again. No numeric score exists anywhere.
 */
export function HealthBreakdown({
  health,
  turns,
  onDrill,
}: {
  health: SessionHealth | null | undefined;
  turns: readonly Turn[];
  onDrill(eventID: string): void;
}) {
  const model = buildHealthBreakdown(health, turns);
  return (
    <section
      id={HEALTH_BREAKDOWN_ID}
      aria-label="Session health rules"
      className="mb-2.5 rounded-lg border border-border bg-surface p-2.5"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-[13px] font-semibold text-text">Session health rules</h2>
        <span
          className={clsx(
            "rounded-full border px-1.5 py-px text-[11px] text-text-2",
            STATE_RULE[model.state],
          )}
        >
          {model.word}
        </span>
        <span className="text-[11.5px] text-muted">{model.disclaimer}</span>
      </div>

      {model.insufficient ? (
        <div className="mt-2 rounded-sm border border-dashed border-border-strong bg-surface-2 px-2 py-1.5">
          <p className="m-0 text-[11.5px] text-text-2">{HEALTH_INSUFFICIENT_COPY}</p>
          {model.reasons.length > 0 ? (
            <ul className="m-0 mt-1 pl-4 text-[11.5px] text-muted">
              {model.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {model.rules.length === 0 ? (
        <p className="m-0 mt-2 text-[11.5px] text-muted">
          No rule was evaluated for this analysis.
        </p>
      ) : (
        <ul className="m-0 mt-2 grid list-none gap-1.5 p-0">
          {model.rules.map((rule) => (
            <li key={rule.id} className="rounded-sm border border-border bg-surface px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[12px] font-semibold text-text">{rule.label}</span>
                {rule.level && rule.levelLabel ? (
                  <span
                    className={clsx(
                      "rounded-full border px-1.5 py-px text-[10.5px] text-text-2",
                      rule.level === "strong" ? "border-critical" : "border-warning",
                    )}
                  >
                    {rule.levelLabel}
                  </span>
                ) : null}
                <span className="text-[11px] text-muted">{rule.statusLabel}</span>
                <span className="min-w-0 flex-1" />
                {rule.links.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {rule.links.map((link) => (
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
                  </span>
                ) : null}
              </div>
              <p className="m-0 mt-1 text-[11px] text-muted">{rule.note}</p>
            </li>
          ))}
        </ul>
      )}

      <p className="m-0 mt-2 text-[11px] text-muted">{HEALTH_DISCLAIMER}</p>
    </section>
  );
}
