import { useEffect, useState } from "react";
import type { Guardrails } from "../../core/guardrails.ts";
import type { Turn } from "../../core/types.ts";
import { buildGuardrails } from "../lib/guardrails-ui.ts";
import { useSettings } from "../providers/SettingsProvider.tsx";

/**
 * The advisory guardrail block (`docs/UI.md:219+`): a native disclosure that is
 * app-wide, never behind the Advanced gate, and sits below the live-warning slot
 * above the active pane. Every row keeps its text label, `derived` basis chip,
 * `advisory` word and threshold; skipped budgets are reported, never guessed.
 *
 * The disclosure is persisted through the mirrored `guardrailsExpanded` /
 * `guardrailsCollapsed` keys (`app.js:124-141,4363-4366`) and seeded from the
 * provider, so a view re-key no longer collapses it. A settings reset propagates
 * through the same provider value.
 */
export function GuardrailsSection({
  guardrails,
  turns,
  onDrill,
}: {
  guardrails: Guardrails | null | undefined;
  turns: readonly Turn[];
  onDrill(eventID: string): void;
}) {
  const settings = useSettings();
  const [open, setOpen] = useState(settings.guardrailsExpanded);

  useEffect(() => {
    setOpen(settings.guardrailsExpanded);
  }, [settings.guardrailsExpanded]);

  const model = buildGuardrails(guardrails, turns);
  if (model.empty) return null;
  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={model.title}
      className="mb-2.5 shrink-0"
    >
      <details
        open={open}
        onToggle={(event) => {
          const expanded = event.currentTarget.open;
          setOpen(expanded);
          settings.setGuardrailsExpanded(expanded);
        }}
        className="rounded-lg border border-border bg-surface"
      >
        <summary className="flex cursor-pointer flex-wrap items-baseline gap-2 px-2.5 py-1.5">
          <h2 className="m-0 text-[13px] font-semibold text-text">{model.title}</h2>
          <span className="text-[11.5px] text-text-2 tabular-nums">{model.countLabel}</span>
          <span className="text-[11px] text-muted">{model.basisLabel}</span>
        </summary>
        <div className="border-t border-border px-2.5 py-2">
          <p className="m-0 text-[11px] text-muted">{model.advisoryCopy}</p>
          {model.rows.length > 0 ? (
            <ul className="m-0 mt-1.5 grid list-none gap-1 p-0">
              {model.rows.map((row) => (
                <li
                  key={row.key}
                  data-budget={row.id}
                  className="rounded-sm border border-border bg-surface px-2 py-1.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] font-semibold text-text">{row.label}</span>
                    <span className="rounded-full border border-border px-1.5 py-px text-[10.5px] text-text-2">
                      {row.basisLabel}
                    </span>
                    <span className="min-w-0 flex-1" />
                    <span className="text-[11px] text-text-2">{row.advisoryLabel}</span>
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
          ) : null}
          {model.skippedNote ? (
            <p className="m-0 mt-1.5 text-[11px] text-muted">{model.skippedNote}</p>
          ) : null}
        </div>
      </details>
    </section>
  );
}
