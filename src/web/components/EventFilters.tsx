import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import clsx from "clsx";
import {
  EVENT_KINDS,
  FILTER_CHIPS,
  activeFilterCount,
  advancedFilterCount,
  emptyFilters,
  isChipActive,
  setKind,
  toggleChip,
  type EventFilters,
  type Facets,
} from "../lib/event-filters.ts";
import { formatNumber } from "../lib/format.ts";

/** The legacy events-search debounce (`app.js:875-878`). */
export const EVENT_SEARCH_DEBOUNCE_MS = 260;

export interface EventFiltersBarProps {
  filters: EventFilters;
  facets: Facets;
  searchRef?: RefObject<HTMLInputElement | null>;
  onChange(next: EventFilters): void;
  onOpenAdvanced(): void;
  advancedOpen: boolean;
}

/**
 * The filter bar (`filterBarHtml`, `app.js:696-743`).
 *
 * The search field is debounced at 260 ms and writes the whole filter object;
 * the kind select commits `[value]`/`[]`; the six chips are real toggles with
 * `aria-pressed`, including the `tools` kind special case. Every control drives
 * the same `EventFilters` the events query is built from.
 */
export function EventFiltersBar({
  filters,
  facets,
  searchRef,
  onChange,
  onOpenAdvanced,
  advancedOpen,
}: EventFiltersBarProps) {
  const [query, setQuery] = useState(filters.q);
  const filtersRef = useRef(filters);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  filtersRef.current = filters;

  useEffect(() => {
    setQuery(filters.q);
  }, [filters.q]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const onSearch = (value: string): void => {
    setQuery(value);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const current = filtersRef.current;
      if (current.q === value) return;
      onChange({ ...current, q: value });
    }, EVENT_SEARCH_DEBOUNCE_MS);
  };

  const clearCount = activeFilterCount(filters);
  const advancedCount = advancedFilterCount(filters);
  const kindOptions = facets.kinds.filter((entry) =>
    (EVENT_KINDS as readonly string[]).includes(entry.value),
  );
  const selectedKind = filters.kinds[0] ?? "";

  return (
    <div
      role="search"
      aria-label="Event filters"
      className="flex flex-wrap items-end gap-2.5 border-b border-border bg-surface px-3 py-2"
    >
      <div className="grid min-w-[180px] flex-1 gap-0.5">
        <label htmlFor="event-search" className="text-[11px] text-muted">
          Search prompts, outputs and tool payloads
        </label>
        <input
          id="event-search"
          ref={searchRef}
          type="search"
          placeholder="Search events…"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onSearch(event.target.value)}
          className="w-full rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-[12.5px] text-text"
        />
      </div>
      <div className="grid gap-0.5">
        <label htmlFor="filter-kind" className="text-[11px] text-muted">
          Kind
        </label>
        <select
          id="filter-kind"
          data-filter="kinds"
          value={selectedKind}
          onChange={(event) => onChange(setKind(filtersRef.current, event.target.value))}
          className="rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-[12.5px] text-text"
        >
          <option value="">All kinds</option>
          {kindOptions.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.value} ({formatNumber(entry.count)})
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTER_CHIPS.map((chip) => {
          const active = isChipActive(filters, chip.id);
          return (
            <button
              key={chip.id}
              type="button"
              data-chip={chip.id}
              aria-pressed={active}
              onClick={() => onChange(toggleChip(filtersRef.current, chip.id))}
              className={clsx(
                "rounded-sm border px-2 py-1 text-[12px]",
                active
                  ? "border-accent bg-accent-weak text-text"
                  : "border-border bg-surface-2 text-text-2 hover:text-text",
              )}
            >
              {chip.label}
            </button>
          );
        })}
        <button
          type="button"
          id="advanced-filters-btn"
          aria-haspopup="dialog"
          aria-controls="advanced-filters"
          aria-expanded={advancedOpen}
          onClick={onOpenAdvanced}
          className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-2 hover:text-text"
        >
          Advanced filters
          <span
            className="rounded-full border border-border px-1.5 text-[10px] text-muted tabular-nums"
            title={`${advancedCount} advanced filter(s) active`}
          >
            {formatNumber(advancedCount)}
          </span>
        </button>
        <button
          type="button"
          id="clear-filters"
          disabled={clearCount === 0}
          onClick={() => {
            // Cancel a pending debounce so a search typed a moment ago cannot
            // repopulate the bar after Clear.
            if (timer.current !== null) {
              clearTimeout(timer.current);
              timer.current = null;
            }
            setQuery("");
            onChange(emptyFilters());
          }}
          className={clsx(
            "rounded-sm border border-border bg-surface-2 px-2 py-1 text-[12px]",
            clearCount === 0 ? "text-muted" : "text-text-2 hover:text-text",
          )}
        >
          {clearCount ? `Clear (${clearCount})` : "Clear"}
        </button>
      </div>
    </div>
  );
}
