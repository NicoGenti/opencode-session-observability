import { Fragment } from "react";
import clsx from "clsx";
import type { SessionHealth } from "../../core/health.ts";
import type { Analysis } from "../../core/types.ts";
import {
  BASIS_LEGEND,
  BASIS_LEGEND_NOTE,
  BASIC_MODE_HINT,
  COPY_ACTIONS,
  STATS_TAB_OPTIONS,
  buildSummary,
  scopeLabel,
  type CopyActionModel,
  type StatsTab,
} from "../lib/statistics.ts";
import { CONTEXT_BASIS_OPTIONS, RESPONSE_LIMITS, normalizeResponseLimit } from "../lib/settings-form.ts";
import { Badge } from "./Badge.tsx";
import { HealthBadge } from "./HealthSection.tsx";

const GHOST =
  "rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2 hover:border-border-strong hover:text-text";

export interface StatsToolbarProps {
  mode: "basic" | "advanced";
  analysis: Analysis;
  statsTab: StatsTab;
  onStatsTab(tab: StatsTab): void;
  contextBasis: string;
  onContextBasis(value: string): void;
  showEventRows: boolean;
  onShowEventRows(value: boolean): void;
  responseLimit: number;
  onResponseLimit(value: number): void;
  allExpanded: boolean;
  onToggleAll(): void;
  health: SessionHealth | null | undefined;
  healthOpen: boolean;
  onToggleHealth(): void;
  onCopy(action: CopyActionModel): void;
  notice: string | null;
}

/**
 * The Statistics toolbar, as legacy renders it per mode (`app.js:2163-2175` for
 * Basic, `:2335-2385` for Advanced). The Advanced bar adds the health badge, the
 * Table/Charts sub-tab (renderer state, never a route), the basis/limit selects
 * and the two copy actions; Basic keeps its scope line and Expand all.
 */
export function StatsToolbar({
  mode,
  analysis,
  statsTab,
  onStatsTab,
  contextBasis,
  onContextBasis,
  showEventRows,
  onShowEventRows,
  responseLimit,
  onResponseLimit,
  allExpanded,
  onToggleAll,
  health,
  healthOpen,
  onToggleHealth,
  onCopy,
  notice,
}: StatsToolbarProps) {
  const summary = buildSummary(analysis, mode);
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-[13px] font-semibold text-text">
          {scopeLabel(analysis.totals)}
        </h2>
        {mode === "advanced" ? (
          <HealthBadge health={health} open={healthOpen} onToggle={onToggleHealth} />
        ) : null}
        <span className="text-[11.5px] text-text-2 tabular-nums">
          {summary.map((piece, index) => (
            <Fragment key={`${piece.text}:${index}`}>
              <span title={piece.title}>
                {piece.text}
                {piece.mark ? (
                  <sup className="ml-px align-super text-[10px] text-muted">{piece.mark}</sup>
                ) : null}
              </span>{" "}
            </Fragment>
          ))}
        </span>
        <span className="min-w-0 flex-1" />

        {mode === "basic" ? (
          <>
            <span className="text-[11.5px] text-muted">{BASIC_MODE_HINT}</span>
            <button type="button" id="expand-all" onClick={onToggleAll} className={GHOST}>
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
          </>
        ) : (
          <>
            <div role="group" aria-label="Statistics view" className="flex rounded-sm border border-border p-0.5">
              {STATS_TAB_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-stats-tab={option.id}
                  aria-pressed={statsTab === option.id}
                  onClick={() => onStatsTab(option.id)}
                  className={clsx(
                    "rounded-sm px-2 py-0.5 text-[11.5px]",
                    statsTab === option.id
                      ? "bg-accent-weak text-text"
                      : "text-text-2 hover:text-text",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <label className="flex items-center gap-1.5 text-[11.5px] text-text-2">
              Context basis
              <select
                id="context-basis"
                value={contextBasis}
                onChange={(event) => onContextBasis(event.target.value)}
                className="rounded-sm border border-border-strong bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-text"
              >
                {CONTEXT_BASIS_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {statsTab === "table" ? (
              <>
                <label className="flex items-center gap-1.5 text-[11.5px] text-text-2">
                  <input
                    id="show-event-rows"
                    type="checkbox"
                    checked={showEventRows}
                    onChange={(event) => onShowEventRows(event.target.checked)}
                  />
                  Show event rows
                </label>
                <label className="flex items-center gap-1.5 text-[11.5px] text-text-2">
                  Response limit
                  <select
                    id="response-limit"
                    value={normalizeResponseLimit(responseLimit)}
                    onChange={(event) => onResponseLimit(Number(event.target.value))}
                    className="rounded-sm border border-border-strong bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-text"
                  >
                    {RESPONSE_LIMITS.map((value) => (
                      <option key={value} value={value}>
                        {value / 1_000}k chars
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" id="expand-all" onClick={onToggleAll} className={GHOST}>
                  {allExpanded ? "Collapse all" : "Expand all"}
                </button>
              </>
            ) : null}

            {COPY_ACTIONS.map((action) => (
              <button
                key={action.id}
                type="button"
                id={action.id === "review" ? "copy-review-prompt" : "copy-digest"}
                onClick={() => onCopy(action)}
                className={GHOST}
              >
                {action.label}
              </button>
            ))}
          </>
        )}
      </div>
      {notice ? (
        <p role="status" className="m-0 text-[11.5px] text-text-2">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The basis legend (`app.js:2406-2412`): every provenance mark keeps its word,
 * followed by the standing note on what OpenCode 2 does not persist.
 */
export function BasisLegend() {
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px] text-text-2">
      {BASIS_LEGEND.map((entry) => (
        <span key={entry.mark} className="inline-flex items-center gap-1">
          <Badge label={entry.mark} /> {entry.label}
        </span>
      ))}
      <span className="text-muted">{BASIS_LEGEND_NOTE}</span>
    </div>
  );
}
