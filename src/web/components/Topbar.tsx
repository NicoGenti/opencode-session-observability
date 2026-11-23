import clsx from "clsx";
import { ArrowLeftRight, Menu, RefreshCw, Settings, Keyboard } from "lucide-react";
import { benchmarkFragment } from "../lib/hash.ts";
import type { ViewMode } from "../lib/settings.ts";
import { ExportMenu, type ExportKind } from "./ExportMenu.tsx";

export interface TopbarProps {
  viewMode: ViewMode;
  onViewModeChange(mode: ViewMode): void;
  onToggleSidebar(): void;
  onRefresh(): void;
  refreshing: boolean;
  onSettings(): void;
  onShortcuts(): void;
  onExport(kind: ExportKind): void;
  /** Live follows the session every 5 seconds while the tab is visible. */
  live: boolean;
  onToggleLive(enabled: boolean): void;
  revealAllowed: boolean;
  reveal: boolean;
  onToggleReveal(): void;
  /** The compare modal needs a selected session. */
  canCompare: boolean;
  onCompare(): void;
}

const MODES: readonly { id: ViewMode; label: string }[] = Object.freeze([
  Object.freeze({ id: "basic", label: "Basic" }),
  Object.freeze({ id: "advanced", label: "Advanced" }),
]);

const GHOST =
  "flex items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12.5px] text-text-2 hover:border-border-strong hover:text-text";

/**
 * The global session actions (`index.html:41-58`), now all real.
 *
 * The live switch and the reveal toggle were stubs until this phase; the export
 * menu was a stub too. The benchmark link keeps its Advanced-only placement
 * (Phase 2 already routes it), the compare button is enabled only with a session
 * to compare, and the export note states the current redaction state.
 */
export function Topbar({
  viewMode,
  onViewModeChange,
  onToggleSidebar,
  onRefresh,
  refreshing,
  onSettings,
  onShortcuts,
  onExport,
  live,
  onToggleLive,
  revealAllowed,
  reveal,
  onToggleReveal,
  canCompare,
  onCompare,
}: TopbarProps) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="Toggle session list"
        className={clsx(GHOST, "min-[901px]:hidden")}
      >
        <Menu size={14} aria-hidden="true" />
      </button>

      <div
        role="group"
        aria-label="View mode"
        className="flex rounded-sm border border-border p-0.5"
      >
        {MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            aria-pressed={viewMode === mode.id}
            onClick={() => onViewModeChange(mode.id)}
            className={clsx(
              "rounded-sm px-2 py-1 text-[12px]",
              viewMode === mode.id
                ? "bg-accent-weak text-text"
                : "text-text-2 hover:text-text",
            )}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onRefresh}
        aria-busy={refreshing}
        title="Reload the session list"
        className={GHOST}
      >
        <RefreshCw size={13} aria-hidden="true" />
        Refresh
      </button>

      <label
        title="Follow the session every 5 seconds while visible"
        className="flex items-center gap-1.5 text-[12.5px] text-text-2"
      >
        <input
          type="checkbox"
          checked={live}
          onChange={(event) => onToggleLive(event.target.checked)}
          className="accent-accent"
        />
        Live
      </label>

      {viewMode === "advanced" ? (
        <a
          href={benchmarkFragment()}
          title="Compare sessions across models, agents and outcomes"
          className={GHOST}
        >
          Benchmark
        </a>
      ) : null}

      <button
        type="button"
        onClick={onCompare}
        disabled={!canCompare}
        title="Compare two diagnostic episodes side by side"
        className={clsx(GHOST, "disabled:text-muted")}
      >
        <ArrowLeftRight size={13} aria-hidden="true" />
        Compare episodes
      </button>

      <button
        type="button"
        onClick={onToggleReveal}
        aria-pressed={reveal}
        disabled={!revealAllowed}
        title={
          revealAllowed
            ? "Show raw payloads; off by default"
            : "Reveal is disabled by the server"
        }
        className={clsx(
          GHOST,
          "disabled:text-muted",
          reveal ? "border-critical text-critical" : undefined,
        )}
      >
        {reveal ? "Hide secrets" : "Reveal secrets"}
      </button>

      <div className="ml-auto flex items-center gap-2">
        <button type="button" onClick={onSettings} className={GHOST}>
          <Settings size={13} aria-hidden="true" />
          Settings
        </button>
        <button
          type="button"
          onClick={onShortcuts}
          title="Keyboard shortcuts (?)"
          className={GHOST}
        >
          <Keyboard size={13} aria-hidden="true" />
          Shortcuts
        </button>
        <ExportMenu
          onExport={onExport}
          note={reveal ? "Raw secrets included in exports" : "Redacted by default"}
        />
      </div>
    </header>
  );
}
