/**
 * The Trajectory filter state machine and its query-parameter projection, ported
 * from `src/ui/app.js`:
 *
 * - `defaultFilters` / `advancedFilterCount` / `activeFilterCount`
 *   (`:218-277`)
 * - `filterParams` (`:379-401`)
 * - the `[data-filter]` binding semantics (`:881-900`): a select commits
 *   `[value]` or `[]`, a datetime-local or number commits its raw string
 * - chip semantics (`:901-914`): `tools` toggles the `["tool"]` kind
 *
 * `eventsQueryParams` adds the paging envelope from `loadEvents` (`:508-522`).
 * The advanced dialog's validation lives here too (Zod), so the schema and the
 * legacy collection rules are exercised by the same test suite.
 */

import { z } from "zod";
import type { EventIndexEntry, EventKind } from "../../core/types.ts";
import { EVENT_PAGE_LIMIT } from "./paging.ts";

export type QueryValue = string | number | boolean | readonly string[] | undefined;

export type EventsQueryParams = Record<string, QueryValue>;

export interface EventFilters {
  q: string;
  kinds: readonly string[];
  agents: readonly string[];
  models: readonly string[];
  providers: readonly string[];
  tools: readonly string[];
  statuses: readonly string[];
  errorsOnly: boolean;
  retriesOnly: boolean;
  compactionsOnly: boolean;
  subagentsOnly: boolean;
  contextOnly: boolean;
  from: string;
  to: string;
  minPromptTokens: string;
  maxPromptTokens: string;
}

/** A fresh filter object; every write produces a new one, never a mutation. */
export function emptyFilters(): EventFilters {
  return {
    q: "",
    kinds: [],
    agents: [],
    models: [],
    providers: [],
    tools: [],
    statuses: [],
    errorsOnly: false,
    retriesOnly: false,
    compactionsOnly: false,
    subagentsOnly: false,
    contextOnly: false,
    from: "",
    to: "",
    minPromptTokens: "",
    maxPromptTokens: "",
  };
}

/** The legacy kind vocabulary offered by the Kind select (`app.js:90-109`). */
export const EVENT_KINDS: readonly EventKind[] = Object.freeze([
  "assistant",
  "reasoning",
  "text",
  "tool",
  "user",
  "synthetic",
  "system",
  "skill",
  "shell",
  "compaction",
  "agent-switched",
  "model-switched",
  "location-switched",
  "idle",
  "retry",
  "error",
  "session",
  "unknown",
]);

export type FilterChip =
  | "errorsOnly"
  | "tools"
  | "compactionsOnly"
  | "retriesOnly"
  | "subagentsOnly"
  | "contextOnly";

/** Chip labels and order, verbatim from `filterBarHtml` (`app.js:728-733`). */
export const FILTER_CHIPS: readonly { id: FilterChip; label: string }[] = Object.freeze([
  Object.freeze({ id: "errorsOnly", label: "Errors" }),
  Object.freeze({ id: "tools", label: "Tools" }),
  Object.freeze({ id: "compactionsOnly", label: "Compactions" }),
  Object.freeze({ id: "retriesOnly", label: "Retries" }),
  Object.freeze({ id: "subagentsOnly", label: "Subagents" }),
  Object.freeze({ id: "contextOnly", label: "Context" }),
]);

export function isChipActive(filters: EventFilters, chip: FilterChip): boolean {
  if (chip === "tools") {
    return filters.kinds.length === 1 && filters.kinds[0] === "tool";
  }
  return filters[chip];
}

/** `[data-chip]` click semantics, including the `tools` kind special case. */
export function toggleChip(filters: EventFilters, chip: FilterChip): EventFilters {
  if (chip === "tools") {
    const active = filters.kinds.length === 1 && filters.kinds[0] === "tool";
    return { ...filters, kinds: active ? [] : ["tool"] };
  }
  return { ...filters, [chip]: !filters[chip] };
}

export type FilterShortcutKey = Exclude<FilterChip, "contextOnly">;

/** The keyboard model's `e`/`t`/`c`/`r`/`s` on the full filter state. */
export function applyFilterShortcut(
  filters: EventFilters,
  key: FilterShortcutKey,
): EventFilters {
  return toggleChip(filters, key);
}

/** The Kind select commits one value or none (`app.js:884-886`). */
export function setKind(filters: EventFilters, kind: string): EventFilters {
  return { ...filters, kinds: kind ? [kind] : [] };
}

/** The counts behind the Clear badge and the Advanced filters badge. */
export function advancedFilterCount(filters: EventFilters): number {
  let count = 0;
  for (const key of ["agents", "models", "providers", "tools", "statuses"] as const) {
    if (filters[key].length > 0) count++;
  }
  for (const key of ["from", "to", "minPromptTokens", "maxPromptTokens"] as const) {
    if (filters[key]) count++;
  }
  return count;
}

export function activeFilterCount(filters: EventFilters): number {
  let count = 0;
  if (filters.q.trim()) count++;
  if (filters.kinds.length > 0) count++;
  for (const key of [
    "errorsOnly",
    "retriesOnly",
    "compactionsOnly",
    "subagentsOnly",
    "contextOnly",
  ] as const) {
    if (filters[key]) count++;
  }
  return count + advancedFilterCount(filters);
}

export function filtersActive(filters: EventFilters): boolean {
  return activeFilterCount(filters) > 0;
}

/** A stable identity for a filter object, used for effect dependencies. */
export function filtersKey(filters: EventFilters): string {
  return JSON.stringify([
    filters.q,
    filters.kinds,
    filters.agents,
    filters.models,
    filters.providers,
    filters.tools,
    filters.statuses,
    filters.from,
    filters.to,
    filters.minPromptTokens,
    filters.maxPromptTokens,
    filters.errorsOnly,
    filters.retriesOnly,
    filters.compactionsOnly,
    filters.subagentsOnly,
    filters.contextOnly,
  ]);
}

/**
 * The exact legacy parameter object. Note the singular names (`kind`, `agent`,
 * …) and the falsy skips: a blank search, `false` chip, or empty array is
 * omitted, while `0` in a numeric field is kept because the raw string `"0"` is
 * truthy, exactly as the legacy inputs stored it.
 */
export function filterParams(filters: EventFilters): EventsQueryParams {
  const from = filters.from ? Date.parse(filters.from) : undefined;
  const to = filters.to ? Date.parse(filters.to) : undefined;
  return {
    q: filters.q.trim() || undefined,
    kind: filters.kinds,
    agent: filters.agents,
    model: filters.models,
    provider: filters.providers,
    tool: filters.tools,
    status: filters.statuses,
    from: typeof from === "number" && Number.isFinite(from) ? from : undefined,
    to: typeof to === "number" && Number.isFinite(to) ? to : undefined,
    minPromptTokens: filters.minPromptTokens || undefined,
    maxPromptTokens: filters.maxPromptTokens || undefined,
    errors: filters.errorsOnly || undefined,
    retries: filters.retriesOnly || undefined,
    compactions: filters.compactionsOnly || undefined,
    subagents: filters.subagentsOnly || undefined,
    context: filters.contextOnly || undefined,
  };
}

export interface EventsPageOptions {
  before?: string | null;
  after?: string | null;
  direction?: "forward" | "backward";
  around?: string | null;
}

/**
 * The `loadEvents` parameter envelope: filters, a 240-row window and the paging
 * cursor. `after` switches the direction to forward and drops `before`, exactly
 * as `loadEvents` does for "Load newer".
 */
export function eventsQueryParams(
  filters: EventFilters,
  options: EventsPageOptions = {},
): EventsQueryParams {
  const params: EventsQueryParams = {
    ...filterParams(filters),
    limit: EVENT_PAGE_LIMIT,
    direction: options.direction ?? "backward",
  };
  if (options.before) params.before = options.before;
  if (options.after) {
    params.after = options.after;
    params.direction = "forward";
    delete params.before;
  }
  if (options.around) params.around = options.around;
  return params;
}

/* ------------------------------------------------------------------- facets */

export interface FacetEntry {
  value: string;
  count: number;
}

export interface Facets {
  kinds: readonly FacetEntry[];
  agents: readonly FacetEntry[];
  models: readonly FacetEntry[];
  providers: readonly FacetEntry[];
  tools: readonly FacetEntry[];
  statuses: readonly FacetEntry[];
}

export const EMPTY_FACETS: Facets = Object.freeze({
  kinds: Object.freeze([] as FacetEntry[]),
  agents: Object.freeze([] as FacetEntry[]),
  models: Object.freeze([] as FacetEntry[]),
  providers: Object.freeze([] as FacetEntry[]),
  tools: Object.freeze([] as FacetEntry[]),
  statuses: Object.freeze([] as FacetEntry[]),
});

/** `buildFacets` (`app.js:650-682`): count then locale order, in that order. */
export function buildFacets(events: readonly EventIndexEntry[]): Facets {
  const maps = {
    kinds: new Map<string, number>(),
    agents: new Map<string, number>(),
    models: new Map<string, number>(),
    providers: new Map<string, number>(),
    tools: new Map<string, number>(),
    statuses: new Map<string, number>(),
  };
  const bump = (map: Map<string, number>, key: string | null | undefined): void => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const event of events) {
    bump(maps.kinds, event.kind);
    bump(maps.agents, event.agent);
    // `EventIndexEntry` has no `meta` in its published type, but the analysis
    // payload carries the delegated agent on it and the legacy facets count it
    // (`app.js:666`). Read it defensively instead of widening the core type.
    const delegated = (event as { meta?: { delegatedAgent?: unknown } }).meta
      ?.delegatedAgent;
    if (typeof delegated === "string") bump(maps.agents, delegated);
    if (event.model) bump(maps.models, `${event.model.providerID}/${event.model.id}`);
    bump(maps.providers, event.provider);
    bump(maps.tools, event.toolName);
    bump(maps.statuses, event.toolStatus ?? event.status);
  }
  const sorted = (map: Map<string, number>): FacetEntry[] =>
    [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));  return {
    kinds: sorted(maps.kinds),
    agents: sorted(maps.agents),
    models: sorted(maps.models),
    providers: sorted(maps.providers),
    tools: sorted(maps.tools),
    statuses: sorted(maps.statuses),
  };
}

/* --------------------------------------------------- advanced filter dialog */

/** The five single-value selects the dialog owns, in legacy order. */
export const ADVANCED_SELECT_FIELDS = Object.freeze([
  Object.freeze({ field: "agent", label: "Agent", facet: "agents", allLabel: "All agents" }),
  Object.freeze({ field: "model", label: "Model", facet: "models", allLabel: "All models" }),
  Object.freeze({
    field: "provider",
    label: "Provider",
    facet: "providers",
    allLabel: "All providers",
  }),
  Object.freeze({ field: "tool", label: "Tool", facet: "tools", allLabel: "All tools" }),
  Object.freeze({
    field: "status",
    label: "Status",
    facet: "statuses",
    allLabel: "All statuses",
  }),
] as const);

export type AdvancedSelectField = (typeof ADVANCED_SELECT_FIELDS)[number]["field"];

export interface AdvancedFilterValues {
  agent: string;
  model: string;
  provider: string;
  tool: string;
  status: string;
  from: string;
  to: string;
  minPromptTokens: string;
  maxPromptTokens: string;
}

const wholeNumber = z
  .string()
  .refine(
    (value) => value === "" || /^\d+$/.test(value.trim()),
    "Use a whole number, 0 or more",
  );

/**
 * The dialog contract. The legacy inputs stored strings, so the schema keeps
 * strings and validates their numeric form; that way a round-trip through the
 * form can never change a committed value (`"0"` stays `"0"`, never `0`).
 */
export const advancedFilterSchema = z
  .object({
    agent: z.string(),
    model: z.string(),
    provider: z.string(),
    tool: z.string(),
    status: z.string(),
    from: z.string(),
    to: z.string(),
    minPromptTokens: wholeNumber,
    maxPromptTokens: wholeNumber,
  })
  .superRefine((values, context) => {
    if (values.from && values.to) {
      const from = Date.parse(values.from);
      const to = Date.parse(values.to);
      if (Number.isFinite(from) && Number.isFinite(to) && from > to) {
        context.addIssue({
          code: "custom",
          path: ["from"],
          message: "From must be on or before To",
        });
      }
    }
    if (values.minPromptTokens !== "" && values.maxPromptTokens !== "") {
      if (Number(values.minPromptTokens) > Number(values.maxPromptTokens)) {
        context.addIssue({
          code: "custom",
          path: ["minPromptTokens"],
          message: "Min prompt tokens must be at most the maximum",
        });
      }
    }
  });

/** The form's initial values: arrays collapse to their single legacy value. */
export function advancedFormDefaults(filters: EventFilters): AdvancedFilterValues {
  return {
    agent: filters.agents[0] ?? "",
    model: filters.models[0] ?? "",
    provider: filters.providers[0] ?? "",
    tool: filters.tools[0] ?? "",
    status: filters.statuses[0] ?? "",
    from: filters.from,
    to: filters.to,
    minPromptTokens: filters.minPromptTokens,
    maxPromptTokens: filters.maxPromptTokens,
  };
}

/**
 * Commit the dialog's values with the exact `[data-filter]` semantics: a select
 * writes `[value]` / `[]`, the datetime and number inputs write their raw
 * string. Every other filter (search, kind, chips) is untouched.
 */
export function applyAdvancedValues(
  filters: EventFilters,
  values: AdvancedFilterValues,
): EventFilters {
  const single = (value: string): string[] => (value ? [value] : []);
  return {
    ...filters,
    agents: single(values.agent),
    models: single(values.model),
    providers: single(values.provider),
    tools: single(values.tool),
    statuses: single(values.status),
    from: values.from,
    to: values.to,
    minPromptTokens: values.minPromptTokens,
    maxPromptTokens: values.maxPromptTokens,
  };
}
