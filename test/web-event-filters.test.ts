import test from "node:test";
import assert from "node:assert/strict";
import type { EventIndexEntry } from "../src/core/types.ts";
import {
  ADVANCED_SELECT_FIELDS,
  EMPTY_FACETS,
  EVENT_KINDS,
  FILTER_CHIPS,
  activeFilterCount,
  advancedFilterCount,
  advancedFilterSchema,
  advancedFormDefaults,
  applyAdvancedValues,
  applyFilterShortcut,
  buildFacets,
  emptyFilters,
  eventsQueryParams,
  filterParams,
  filtersActive,
  filtersKey,
  isChipActive,
  setKind,
  toggleChip,
  type EventFilters,
} from "../src/web/lib/event-filters.ts";

function filters(patch: Partial<EventFilters> = {}): EventFilters {
  return { ...emptyFilters(), ...patch };
}

/* --------------------------------------------------------------- the matrix */

test("filters: an empty state omits every parameter", () => {
  assert.deepEqual(filterParams(emptyFilters()), {
    q: undefined,
    kind: [],
    agent: [],
    model: [],
    provider: [],
    tool: [],
    status: [],
    from: undefined,
    to: undefined,
    minPromptTokens: undefined,
    maxPromptTokens: undefined,
    errors: undefined,
    retries: undefined,
    compactions: undefined,
    subagents: undefined,
    context: undefined,
  });
  assert.equal(activeFilterCount(emptyFilters()), 0);
  assert.equal(filtersActive(emptyFilters()), false);
  assert.equal(advancedFilterCount(emptyFilters()), 0);
});

test("filters: every control maps to the legacy singular parameter", () => {
  const full = filters({
    q: "  timeout  ",
    kinds: ["tool"],
    agents: ["build"],
    models: ["openai/gpt-5"],
    providers: ["openai"],
    tools: ["bash"],
    statuses: ["error"],
    errorsOnly: true,
    retriesOnly: true,
    compactionsOnly: true,
    subagentsOnly: true,
    contextOnly: true,
    from: "2026-01-02T03:04",
    to: "2026-01-02T04:05",
    minPromptTokens: "10",
    maxPromptTokens: "20",
  });
  const params = filterParams(full);
  assert.equal(params.q, "timeout");
  assert.deepEqual(params.kind, ["tool"]);
  assert.deepEqual(params.agent, ["build"]);
  assert.deepEqual(params.model, ["openai/gpt-5"]);
  assert.deepEqual(params.provider, ["openai"]);
  assert.deepEqual(params.tool, ["bash"]);
  assert.deepEqual(params.status, ["error"]);
  assert.equal(params.errors, true);
  assert.equal(params.retries, true);
  assert.equal(params.compactions, true);
  assert.equal(params.subagents, true);
  assert.equal(params.context, true);
  // `datetime-local` has no zone, so `Date.parse` treats it as local time.
  assert.equal(params.from, Date.parse("2026-01-02T03:04"));
  assert.equal(params.to, Date.parse("2026-01-02T04:05"));
  assert.equal(params.minPromptTokens, "10");
  assert.equal(params.maxPromptTokens, "20");
});

test("filters: blank search, false chips and invalid dates are skipped", () => {
  const params = filterParams(
    filters({ q: "   ", errorsOnly: false, from: "not-a-date", to: "" }),
  );
  assert.equal(params.q, undefined);
  assert.equal(params.errors, undefined);
  assert.equal(params.from, undefined);
  assert.equal(params.to, undefined);
});

test("filters: a zero bound keeps the raw string, a blank one is omitted", () => {
  assert.equal(filterParams(filters({ minPromptTokens: "0" })).minPromptTokens, "0");
  assert.equal(filterParams(filters({ maxPromptTokens: "0" })).maxPromptTokens, "0");
  assert.equal(filterParams(filters({ minPromptTokens: "" })).minPromptTokens, undefined);
});

test("filters: the paging envelope mirrors loadEvents", () => {
  assert.deepEqual(eventsQueryParams(emptyFilters()), {
    ...filterParams(emptyFilters()),
    limit: 240,
    direction: "backward",
  });

  const earlier = eventsQueryParams(emptyFilters(), { before: "cursor-before" });
  assert.equal(earlier.before, "cursor-before");
  assert.equal(earlier.direction, "backward");

  const newer = eventsQueryParams(emptyFilters(), {
    before: "cursor-before",
    after: "cursor-after",
  });
  assert.equal(newer.after, "cursor-after");
  assert.equal(newer.direction, "forward");
  assert.equal("before" in newer, false);

  const around = eventsQueryParams(emptyFilters(), { around: "evt-9" });
  assert.equal(around.around, "evt-9");
  assert.equal(around.direction, "backward");
});

/* -------------------------------------------------------------------- chips */

test("chips: each chip flips its own boolean and tools flips the kind", () => {
  for (const chip of ["errorsOnly", "compactionsOnly", "retriesOnly", "subagentsOnly", "contextOnly"] as const) {
    const on = toggleChip(emptyFilters(), chip);
    assert.equal(isChipActive(on, chip), true, chip);
    assert.equal(isChipActive(toggleChip(on, chip), chip), false, chip);
  }
  const tools = toggleChip(emptyFilters(), "tools");
  assert.deepEqual(tools.kinds, ["tool"]);
  assert.equal(isChipActive(tools, "tools"), true);
  assert.deepEqual(toggleChip(tools, "tools").kinds, []);
  // A different kind is not "tools".
  assert.equal(isChipActive(filters({ kinds: ["user"] }), "tools"), false);
  assert.deepEqual(toggleChip(filters({ kinds: ["user"] }), "tools").kinds, ["tool"]);
  // The chip order and labels are the legacy bar order.
  assert.deepEqual(
    FILTER_CHIPS.map((chip) => chip.label),
    ["Errors", "Tools", "Compactions", "Retries", "Subagents", "Context"],
  );
});

test("chips: the keyboard shortcuts apply to the same state", () => {
  assert.equal(applyFilterShortcut(emptyFilters(), "errorsOnly").errorsOnly, true);
  assert.deepEqual(applyFilterShortcut(emptyFilters(), "tools").kinds, ["tool"]);
  assert.equal(applyFilterShortcut(emptyFilters(), "retriesOnly").retriesOnly, true);
});

test("filters: kind, counts and the key stay deterministic", () => {
  assert.deepEqual(setKind(emptyFilters(), "tool").kinds, ["tool"]);
  assert.deepEqual(setKind(emptyFilters(), "").kinds, []);

  const advanced = filters({
    agents: ["build"],
    models: ["openai/gpt-5"],
    from: "2026-01-02T03:04",
    minPromptTokens: "0",
  });
  assert.equal(advancedFilterCount(advanced), 4);

  const active = filters({
    q: "x",
    kinds: ["tool"],
    errorsOnly: true,
    compactionsOnly: true,
    retriesOnly: true,
    subagentsOnly: true,
    contextOnly: true,
    agents: ["build"],
  });
  assert.equal(activeFilterCount(active), 8);
  assert.equal(filtersKey(emptyFilters()), filtersKey(emptyFilters()));
  assert.notEqual(filtersKey(emptyFilters()), filtersKey(filters({ q: "x" })));
});

test("kinds: the select offers exactly the legacy vocabulary", () => {
  assert.equal(EVENT_KINDS.length, 18);
  assert.equal(EVENT_KINDS[0], "assistant");
  assert.equal(EVENT_KINDS[EVENT_KINDS.length - 1], "unknown");
  assert.equal(EVENT_KINDS.includes("permission"), false);
});

/* ------------------------------------------------------------------- facets */

function indexEntry(patch: Partial<EventIndexEntry> = {}): EventIndexEntry {
  return {
    id: "e",
    messageID: "m",
    sessionID: "s",
    seq: 1,
    orderKey: "000001:0",
    timestamp: 1,
    kind: "tool",
    actor: "tool",
    title: "t",
    preview: "",
    agent: null,
    model: null,
    provider: null,
    status: null,
    toolName: null,
    toolStatus: null,
    tokens: null,
    cost: null,
    stepID: null,
    turnID: null,
    flags: {
      error: false,
      retry: false,
      compaction: false,
      context: false,
      subagent: false,
      approval: false,
      uncertain: false,
    },
    uncertainty: [],
    ...patch,
  };
}

test("facets: counts, sorting and the delegated agent", () => {
  const delegated: EventIndexEntry = Object.assign(
    indexEntry({
      kind: "assistant",
      agent: "plan",
      model: { providerID: "openai", id: "gpt-5" },
      provider: "openai",
      status: "completed",
      toolStatus: "completed",
    }),
    { meta: { delegatedAgent: "explore" } },
  );
  const facets = buildFacets([
    indexEntry({ toolName: "bash", kind: "tool" }),
    indexEntry({ toolName: "bash", kind: "tool", agent: "build" }),
    indexEntry({ toolName: "read", kind: "tool", agent: "build" }),
    delegated,
  ]);
  assert.deepEqual(facets.kinds, [
    { value: "tool", count: 3 },
    { value: "assistant", count: 1 },
  ]);
  // build 2, explore 1, plan 1 — ties break alphabetically.
  assert.deepEqual(facets.agents, [
    { value: "build", count: 2 },
    { value: "explore", count: 1 },
    { value: "plan", count: 1 },
  ]);
  assert.deepEqual(facets.tools, [
    { value: "bash", count: 2 },
    { value: "read", count: 1 },
  ]);
  assert.deepEqual(facets.models, [{ value: "openai/gpt-5", count: 1 }]);
  assert.deepEqual(facets.providers, [{ value: "openai", count: 1 }]);
  assert.deepEqual(facets.statuses, [{ value: "completed", count: 1 }]);
  assert.deepEqual(EMPTY_FACETS.kinds, []);
});

/* ------------------------------------------------------- advanced dialog */

test("advanced: the dialog field list is the legacy order", () => {
  assert.deepEqual(
    ADVANCED_SELECT_FIELDS.map((field) => field.label),
    ["Agent", "Model", "Provider", "Tool", "Status"],
  );
  assert.deepEqual(
    ADVANCED_SELECT_FIELDS.map((field) => field.allLabel),
    ["All agents", "All models", "All providers", "All tools", "All statuses"],
  );
});

test("advanced: a valid round-trip preserves the string shape", () => {
  const values = {
    agent: "build",
    model: "openai/gpt-5",
    provider: "openai",
    tool: "bash",
    status: "error",
    from: "2026-01-02T03:04",
    to: "2026-01-02T04:05",
    minPromptTokens: "0",
    maxPromptTokens: "200",
  };
  assert.deepEqual(advancedFilterSchema.parse(values), values);
  const applied = applyAdvancedValues(filters({ q: "keep me", kinds: ["tool"] }), values);
  assert.equal(applied.q, "keep me");
  assert.deepEqual(applied.kinds, ["tool"]);
  assert.deepEqual(applied.agents, ["build"]);
  assert.deepEqual(applied.statuses, ["error"]);
  assert.equal(applied.minPromptTokens, "0");
  assert.equal(applied.maxPromptTokens, "200");
  assert.deepEqual(advancedFormDefaults(applied), values);
});

test("advanced: blank selects commit empty arrays and blank bounds empty strings", () => {
  const applied = applyAdvancedValues(emptyFilters(), {
    agent: "",
    model: "",
    provider: "",
    tool: "",
    status: "",
    from: "",
    to: "",
    minPromptTokens: "",
    maxPromptTokens: "",
  });
  assert.deepEqual(applied.agents, []);
  assert.deepEqual(applied.models, []);
  assert.deepEqual(applied.providers, []);
  assert.deepEqual(applied.tools, []);
  assert.deepEqual(applied.statuses, []);
  assert.equal(applied.from, "");
  assert.equal(applied.minPromptTokens, "");
});

test("advanced: validation rejects from > to", () => {
  const result = advancedFilterSchema.safeParse({
    agent: "",
    model: "",
    provider: "",
    tool: "",
    status: "",
    from: "2026-01-02T04:05",
    to: "2026-01-02T03:04",
    minPromptTokens: "",
    maxPromptTokens: "",
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues[0].path[0], "from");
    assert.equal(result.error.issues[0].message, "From must be on or before To");
  }
  // Equal bounds are valid.
  assert.equal(
    advancedFilterSchema.safeParse({
      agent: "",
      model: "",
      provider: "",
      tool: "",
      status: "",
      from: "2026-01-02T03:04",
      to: "2026-01-02T03:04",
      minPromptTokens: "",
      maxPromptTokens: "",
    }).success,
    true,
  );
});

test("advanced: validation bounds the token numbers", () => {
  const base = {
    agent: "",
    model: "",
    provider: "",
    tool: "",
    status: "",
    from: "",
    to: "",
  };
  assert.equal(
    advancedFilterSchema.safeParse({ ...base, minPromptTokens: "10", maxPromptTokens: "20" })
      .success,
    true,
  );
  const inverted = advancedFilterSchema.safeParse({
    ...base,
    minPromptTokens: "20",
    maxPromptTokens: "10",
  });
  assert.equal(inverted.success, false);
  if (!inverted.success) {
    assert.equal(inverted.error.issues[0].path[0], "minPromptTokens");
    assert.equal(
      inverted.error.issues[0].message,
      "Min prompt tokens must be at most the maximum",
    );
  }
  for (const bad of ["-1", "1.5", "abc", "1e3"]) {
    const result = advancedFilterSchema.safeParse({
      ...base,
      minPromptTokens: bad,
      maxPromptTokens: "",
    });
    assert.equal(result.success, false, bad);
  }
  // A padded whole number is accepted and keeps its raw string.
  assert.equal(
    advancedFilterSchema.safeParse({
      ...base,
      minPromptTokens: " 12 ",
      maxPromptTokens: "",
    }).success,
    true,
  );
});
