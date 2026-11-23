import type { ReactNode } from "react";
import clsx from "clsx";
import { SKIP_LINK } from "../lib/copy.ts";

export interface ShellProps {
  sidebar: ReactNode;
  topbar: ReactNode;
  banner?: ReactNode;
  tabs: ReactNode;
  view: ReactNode;
  sidebarOpen: boolean;
  /** The id of the selected view tab, when there is one. */
  labelledBy?: string;
}

/**
 * The page frame: skip link, off-canvas sidebar, topbar, view tabs and the
 * live view region.
 *
 * The view region is the only `aria-live` container; it is the `tabpanel` the
 * tabs control. On the benchmark route there is no tab, so `aria-label` names
 * the region instead of `aria-labelledby`.
 */
export function Shell({
  sidebar,
  topbar,
  banner,
  tabs,
  view,
  sidebarOpen,
  labelledBy,
}: ShellProps) {
  return (
    <>
      <a
        href={SKIP_LINK.href}
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:border focus:border-border-strong focus:bg-surface focus:px-3 focus:py-1.5 focus:text-[12.5px] focus:text-text"
      >
        {SKIP_LINK.label}
      </a>
      <div className="grid h-dvh max-h-dvh grid-cols-[272px_minmax(0,1fr)] overflow-hidden max-[900px]:grid-cols-1">
        <aside
          id="sidebar"
          aria-label="Sessions"
          className={clsx(
            "flex min-h-0 flex-col border-r border-border bg-surface",
            "max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:z-30 max-[900px]:w-[272px] max-[900px]:transition-transform max-[900px]:motion-reduce:transition-none",
            sidebarOpen ? "max-[900px]:translate-x-0" : "max-[900px]:-translate-x-full",
          )}
        >
          {sidebar}
        </aside>
        <main id="main" className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          {topbar}
          {banner}
          {tabs}
          <section
            id="view"
            role="tabpanel"
            aria-live="polite"
            aria-labelledby={labelledBy}
            aria-label={labelledBy ? undefined : "Session view"}
            className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3"
          >
            {view}
          </section>
        </main>
      </div>
    </>
  );
}
