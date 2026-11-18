import test from "node:test";
import assert from "node:assert/strict";

import { ObservabilityService } from "../src/core/service.ts";
import {
  BENCHMARK_GROUP_BYS,
  MAX_BENCHMARK_SESSIONS,
  NOT_RECORDED,
  PATTERN_MIN_SESSIONS,
  benchmarkGroupKey,
  benchmarkInputFrom,
  computeBenchmark,
  failingToolsOf,
  hasBenchmarkCriteria,
  isBenchmarkGroupBy,
  matchesBenchmarkFilters,
  matchesBenchmarkTaskType,
  patternsFor,
  rollupsFor,
  taskTypesOf,
} from "../src/core/benchmark.ts";
import type {
  Benchmark,
  BenchmarkSessionInput,
} from "../src/core/benchmark.ts";
import type { RawMessage, SessionMeta } from "../src/core/types.ts";
import {
  BASE,
  MODEL,
  assistant,
  fixture,
  idle,
  memorySource,
  secretsFixture,
  session,
  subagentFixture,
  toolBlock,
  user,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";

const TOKENS = {
  input: 10,
  output: 2,
  reasoning: 0,
  cacheRead: 5,
  cacheWrite: 0,
};

function makeInput(
  overrides: Partial<BenchmarkSessionInput> = {},
): BenchmarkSessionInput {
  return {
    sessionID: "ses_a",
    directory: "C:/fixtures/project",
    model: "test-model",
    provider: "test-provider",
    agent: "build",
    outcome: "succeeded",
    timeCreated: BASE,
    timeUpdated: BASE + 10_000,
    totals: {
      turns: 1,
      steps: 2,
      tokens: { ...TOKENS },
      cost: 0.5,
      duration: 1_000,
      cacheHitRate: 0.25,
      retries: 0,
      errors: 0,
      toolFailures: 0,
      compactions: 0,
    },
    triggeredRuleIDs: [],
    failingTools: [],
    windowed: false,
    taskTypes: ["user"],
    ...overrides,
  };
}

/** One one-turn session; `agent`/`outcome`/`updated` distinguish candidates. */
function tinySession(
  id: string,
  options: {
    agent?: string;
    outcome?: "succeeded" | "failed" | "interrupted";
    updated: number;
    delegated?: boolean;
  },
): { meta: SessionMeta; messages: RawMessage[] } {
  return {
    meta: session(id, {
      ...(options.delegated ? { parentID: "ses_parent" } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.outcome ? { outcome: options.outcome } : { outcome: "succeeded" }),
      time: { created: BASE, updated: options.updated, busy: BASE, idle: options.updated },
    }),
    messages: [
      user("msg_u1", 1, BASE),
      assistant({
        id: "msg_a1",
        seq: 2,
        created: BASE + 100,
        streamed: BASE + 300,
        completed: BASE + 400,
        content: [
          toolBlock({
            name: "grep",
            created: BASE + 150,
            ran: BASE + 200,
            completed: BASE + 250,
            status: "error",
            input: { pattern: "TODO" },
            output: "",
          }),
        ],
        tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0.01,
      }),
      idle("msg_i1", 3, BASE + 500, "succeeded"),
    ],
  };
}

function candidatesFixture(): Fixture {
  return fixture([
    tinySession("ses_a", { agent: "build", updated: BASE + 9_000 }),
    tinySession("ses_b", {
      agent: "explorer",
      outcome: "failed",
      updated: BASE + 8_000,
    }),
    tinySession("ses_c", { agent: "build", updated: BASE + 1_000 }),
  ]);
}

function manySessionsFixture(count: number): Fixture {
  const entries = [];
  for (let index = 0; index < count; index++) {
    const id = `ses_${String(index).padStart(3, "0")}`;
    entries.push(
      tinySession(id, {
        // The oldest candidate carries a distinguishable agent so the cap is
        // observable in the grouped output.
        agent: index === 0 ? "dropped" : "build",
        updated: BASE + (index + 1) * 1_000,
      }),
    );
  }
  return fixture(entries);
}

/**
 * 52 sessions that all match the summary filters. The two newest are delegated
 * children (their turns carry the `delegation` trigger), the 50 older ones are
 * user-triggered, so the cap loads exactly the two delegations plus 48 sessions
 * the task-type filter then drops.
 */
function delegationHeavyFixture(): Fixture {
  const entries = [];
  for (let index = 0; index < 52; index++) {
    entries.push(
      tinySession(`ses_${String(index).padStart(3, "0")}`, {
        updated: BASE + (index + 1) * 1_000,
        delegated: index >= 50,
      }),
    );
  }
  return fixture(entries);
}

function serviceOf(data: Fixture): ObservabilityService {
  return new ObservabilityService(memorySource(data));
}

// ---------------------------------------------------------------------------
// Rollup math
// ---------------------------------------------------------------------------

test("rollups sum every total and derive the averages", () => {
  const first = makeInput({
    sessionID: "ses_a",
    totals: {
      turns: 2,
      steps: 4,
      tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 5, cacheWrite: 0 },
      cost: 0.5,
      duration: 1_000,
      cacheHitRate: 0.25,
      retries: 1,
      errors: 2,
      toolFailures: 1,
      compactions: 0,
    },
  });
  const second = makeInput({
    sessionID: "ses_b",
    outcome: "failed",
    totals: {
      turns: 3,
      steps: 6,
      tokens: { input: 20, output: 4, reasoning: 1, cacheRead: 0, cacheWrite: 0 },
      cost: 1.5,
      duration: 3_000,
      cacheHitRate: 0.75,
      retries: 2,
      errors: 0,
      toolFailures: 2,
      compactions: 1,
    },
  });

  const benchmark = computeBenchmark([first, second]);
  const overall = benchmark.overall;

  assert.equal(overall.count, 2);
  assert.equal(overall.rollups.sessions, 2);
  assert.equal(overall.rollups.turns, 5);
  assert.equal(overall.rollups.steps, 10);
  assert.deepEqual(overall.rollups.tokens, {
    input: 30,
    output: 6,
    reasoning: 1,
    cacheRead: 5,
    cacheWrite: 0,
  });
  // input + output + reasoning + cacheRead + cacheWrite
  assert.equal(overall.rollups.tokensTotal, 42);
  assert.equal(overall.rollups.costSum.value, 2);
  assert.equal(overall.rollups.costSum.basis, "derived");
  assert.equal(overall.rollups.costPerSession.value, 1);
  assert.equal(overall.rollups.durationPerSession.value, 2_000);
  assert.equal(overall.rollups.cacheHitRate.value, 0.5);
  assert.equal(overall.rollups.retries, 3);
  assert.equal(overall.rollups.errors, 2);
  assert.equal(overall.rollups.toolFailures, 3);
  assert.equal(overall.rollups.compactions, 1);
  assert.deepEqual(overall.rollups.completions, {
    succeeded: 1,
    failed: 1,
    interrupted: 0,
    unrecorded: 0,
  });
  assert.equal(overall.rollups.windowedCount, 0);
  assert.equal(overall.rollups.averagedSessions, 2);

  for (const metric of [
    overall.rollups.costSum,
    overall.rollups.costPerSession,
    overall.rollups.durationPerSession,
    overall.rollups.cacheHitRate,
  ]) {
    assert.equal(metric.basis, "derived");
    assert.ok(metric.note, "a derived metric always carries its note");
  }
});

test("windowed sessions are counted in sums and excluded from averages", () => {
  const comparable = makeInput({
    sessionID: "ses_ok",
    totals: {
      turns: 1,
      steps: 1,
      tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 1,
      duration: 1_000,
      cacheHitRate: 0.5,
      retries: 0,
      errors: 0,
      toolFailures: 0,
      compactions: 0,
    },
  });
  const windowed = makeInput({
    sessionID: "ses_window",
    windowed: true,
    totals: {
      turns: 4,
      steps: 9,
      tokens: { input: 90, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 9,
      duration: 9_000,
      cacheHitRate: 0.9,
      retries: 8,
      errors: 6,
      toolFailures: 4,
      compactions: 2,
    },
  });

  const { rollups } = computeBenchmark([comparable, windowed]).overall;

  assert.equal(rollups.windowedCount, 1);
  assert.equal(rollups.averagedSessions, 1);
  assert.equal(rollups.sessions, 2);
  // Sums cover both sessions.
  assert.equal(rollups.tokensTotal, 100);
  assert.equal(rollups.costSum.value, 10);
  assert.equal(rollups.turns, 5);
  assert.equal(rollups.retries, 8);
  // Averages cover only the comparable session.
  assert.equal(rollups.costPerSession.value, 1);
  assert.equal(rollups.durationPerSession.value, 1_000);
  assert.equal(rollups.cacheHitRate.value, 0.5);
});

test("a missing value is labelled, never reported as zero", () => {
  const missing = makeInput({
    sessionID: "ses_missing",
    totals: {
      turns: 1,
      steps: 1,
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: null,
      duration: null,
      cacheHitRate: null,
      retries: 0,
      errors: 0,
      toolFailures: 0,
      compactions: 0,
    },
  });
  const present = makeInput({ sessionID: "ses_present", totals: { ...makeInput().totals, cost: 2 } });

  const { rollups } = computeBenchmark([missing, present]).overall;
  assert.equal(rollups.costSum.value, 2);
  assert.equal(rollups.costSum.basis, "derived");
  assert.match(rollups.costSum.note ?? "", /1 of 2 session\(s\) did not record a cost value/);
  assert.equal(rollups.costPerSession.value, 2);
  assert.match(rollups.costPerSession.note ?? "", /1 of 2 comparable session\(s\)/);
  assert.equal(rollups.durationPerSession.value, 1_000);

  const onlyMissing = computeBenchmark([missing]).overall.rollups;
  assert.equal(onlyMissing.costSum.value, null);
  assert.equal(onlyMissing.costSum.basis, "unavailable");
  assert.equal(onlyMissing.costPerSession.value, null);
  assert.equal(onlyMissing.costPerSession.basis, "unavailable");
  assert.equal(onlyMissing.cacheHitRate.value, null);
  assert.equal(onlyMissing.cacheHitRate.basis, "unavailable");
});

test("a single windowed session yields no comparable average at all", () => {
  const { rollups } = computeBenchmark([makeInput({ windowed: true })]).overall;
  assert.equal(rollups.averagedSessions, 0);
  assert.equal(rollups.costPerSession.value, null);
  assert.equal(rollups.costPerSession.basis, "unavailable");
  assert.equal(rollups.costPerSession.note, "no session was comparable");
  assert.equal(rollups.cacheHitRate.value, null);
  assert.equal(rollups.durationPerSession.value, null);
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

test("groups are ordered by recorded key and never by count", () => {
  const inputs = [
    makeInput({ sessionID: "ses_1", agent: "zeta" }),
    makeInput({ sessionID: "ses_2", agent: "alpha" }),
    makeInput({ sessionID: "ses_3", agent: "alpha" }),
  ];
  const benchmark = computeBenchmark(inputs, { groupBy: "agent" });

  assert.equal(benchmark.groupBy, "agent");
  assert.deepEqual(
    benchmark.groups.map((group) => group.key),
    ["alpha", "zeta"],
  );
  assert.deepEqual(
    benchmark.groups.map((group) => group.count),
    [2, 1],
  );
  assert.equal(benchmark.groups[0].label, "alpha");
  assert.equal(benchmark.groups[0].rollups.sessions, 2);
  assert.equal(benchmark.overall.count, 3);
});

test("groupBy none yields only the overall rollup", () => {
  const benchmark = computeBenchmark([makeInput()], {});
  assert.equal(benchmark.groupBy, "none");
  assert.deepEqual(benchmark.groups, []);
  assert.equal(benchmark.overall.count, 1);
});

test("group keys name the recorded value and share one bucket when absent", () => {
  const recorded = makeInput({ sessionID: "ses_1" });
  assert.equal(benchmarkGroupKey("model", recorded), "test-provider/test-model");
  assert.equal(benchmarkGroupKey("provider", recorded), "test-provider");
  assert.equal(benchmarkGroupKey("agent", recorded), "build");
  assert.equal(benchmarkGroupKey("outcome", recorded), "succeeded");
  assert.equal(benchmarkGroupKey("taskType", recorded), "user");
  assert.equal(
    benchmarkGroupKey("taskType", makeInput({ taskTypes: ["user", "delegation"] })),
    "user+delegation",
  );

  const empty = makeInput({
    model: null,
    provider: null,
    agent: null,
    outcome: null,
    taskTypes: [],
  });
  for (const groupBy of ["model", "provider", "agent", "outcome", "taskType"] as const) {
    assert.equal(benchmarkGroupKey(groupBy, empty), NOT_RECORDED);
  }
  assert.equal(benchmarkGroupKey("model", makeInput({ provider: null })), "test-model");
});

test("an unknown groupBy degrades to none", () => {
  const benchmark = computeBenchmark([makeInput()], { groupBy: "directory" });
  assert.equal(benchmark.groupBy, "none");
  assert.deepEqual(benchmark.groups, []);
  assert.equal(isBenchmarkGroupBy("directory"), false);
  assert.equal(isBenchmarkGroupBy("model"), true);
  assert.deepEqual([...BENCHMARK_GROUP_BYS], [
    "none",
    "model",
    "provider",
    "agent",
    "outcome",
    "taskType",
  ]);
});

// ---------------------------------------------------------------------------
// Recurring patterns
// ---------------------------------------------------------------------------

test("a pattern needs PATTERN_MIN_SESSIONS sessions", () => {
  const ruleInputs = (count: number): BenchmarkSessionInput[] =>
    Array.from({ length: count }, (_, index) =>
      makeInput({
        sessionID: `ses_${index}`,
        triggeredRuleIDs: ["retry-count", "cost-per-turn"],
        failingTools: ["grep"],
      }),
    );

  assert.equal(PATTERN_MIN_SESSIONS, 3);
  assert.deepEqual(patternsFor(ruleInputs(2)), []);

  const patterns = patternsFor(ruleInputs(3));
  assert.deepEqual(patterns, [
    {
      kind: "health-rule",
      key: "cost-per-turn",
      sessionCount: 3,
      sessionIDs: ["ses_0", "ses_1", "ses_2"],
    },
    {
      kind: "health-rule",
      key: "retry-count",
      sessionCount: 3,
      sessionIDs: ["ses_0", "ses_1", "ses_2"],
    },
    {
      kind: "failing-tool",
      key: "grep",
      sessionCount: 3,
      sessionIDs: ["ses_0", "ses_1", "ses_2"],
    },
  ]);
});

test("a failing-tool pattern uses each session's top failing tool only", () => {
  const inputs = [
    makeInput({ sessionID: "ses_0", failingTools: ["read", "grep"] }),
    makeInput({ sessionID: "ses_1", failingTools: ["write", "grep"] }),
    makeInput({ sessionID: "ses_2", failingTools: ["shell", "grep"] }),
  ];
  assert.deepEqual(patternsFor(inputs), []);

  const topShared = [
    makeInput({ sessionID: "ses_0", failingTools: ["grep", "read"] }),
    makeInput({ sessionID: "ses_1", failingTools: ["grep"] }),
    makeInput({ sessionID: "ses_2", failingTools: ["grep", "shell"] }),
  ];
  const patterns = patternsFor(topShared);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].kind, "failing-tool");
  assert.equal(patterns[0].key, "grep");
  assert.deepEqual(patterns[0].sessionIDs, ["ses_0", "ses_1", "ses_2"]);
});

test("patterns stay deterministic and follow the compared order", () => {
  const inputs = [
    makeInput({ sessionID: "ses_new", failingTools: ["grep"], triggeredRuleIDs: ["retry-count"] }),
    makeInput({ sessionID: "ses_mid", failingTools: ["grep"], triggeredRuleIDs: ["retry-count"] }),
    makeInput({ sessionID: "ses_old", failingTools: ["grep"], triggeredRuleIDs: ["retry-count"] }),
  ];
  const first = computeBenchmark(inputs, { groupBy: "agent" });
  const second = computeBenchmark(inputs, { groupBy: "agent" });
  assert.deepEqual(first, second);
  assert.deepEqual(first.recurringPatterns[0].sessionIDs, [
    "ses_new",
    "ses_mid",
    "ses_old",
  ]);
});

// ---------------------------------------------------------------------------
// Cap, candidate accounting, empty result
// ---------------------------------------------------------------------------

test("the cap is reported instead of silently truncating", () => {
  const inputs = Array.from({ length: MAX_BENCHMARK_SESSIONS }, (_, index) =>
    makeInput({ sessionID: `ses_${index}` }),
  );
  const capped = computeBenchmark(inputs, {
    sessionsCapped: true,
    candidatesConsidered: 120,
  });
  assert.equal(capped.sessionsCapped, true);
  assert.equal(capped.candidatesConsidered, 120);
  assert.equal(capped.overall.count, MAX_BENCHMARK_SESSIONS);
  assert.equal(
    capped.basisNotes[0],
    "Compared 50 of 50 loaded candidates (120 sessions matched the summary filters; older candidates were not loaded).",
  );

  const open = computeBenchmark(inputs, { candidatesConsidered: 12 });
  assert.equal(open.sessionsCapped, false);
  assert.equal(open.candidatesConsidered, 50);
  assert.equal(
    open.basisNotes[0],
    "Compared 50 of 50 loaded candidates (50 sessions matched the summary filters).",
  );
});

test("an empty comparison is a valid empty-shaped benchmark", () => {
  const benchmark: Benchmark = computeBenchmark([]);
  assert.equal(benchmark.overall.count, 0);
  assert.equal(benchmark.overall.rollups.sessions, 0);
  assert.equal(benchmark.overall.rollups.turns, 0);
  assert.equal(benchmark.overall.rollups.tokensTotal, 0);
  assert.equal(benchmark.overall.rollups.costSum.basis, "unavailable");
  assert.equal(benchmark.overall.rollups.costPerSession.basis, "unavailable");
  assert.equal(benchmark.overall.rollups.averagedSessions, 0);
  assert.deepEqual(benchmark.groups, []);
  assert.deepEqual(benchmark.recurringPatterns, []);
  assert.equal(benchmark.sessionsCapped, false);
  assert.equal(benchmark.candidatesConsidered, 0);
  assert.equal(benchmark.basisNotes.length, 5);
  assert.equal(
    benchmark.basisNotes[0],
    "Compared 0 of 0 loaded candidates (0 sessions matched the summary filters).",
  );
  assert.match(benchmark.basisNotes[1], /0 of 0 compared session\(s\) are windowed/);
  assert.match(
    benchmark.basisNotes[4],
    /^Candidates are the 1000 most recently updated sessions; older sessions were never listed\.$/,
  );
});

test("the candidate listing ceiling is stated in every comparison", () => {
  const notes = computeBenchmark([makeInput()]).basisNotes;
  assert.ok(
    notes.some(
      (note) =>
        note ===
        "Candidates are the 1000 most recently updated sessions; older sessions were never listed.",
    ),
  );
  assert.equal(
    notes.filter((note) => note.startsWith("Candidates are the")).length,
    1,
  );
});

test("a skipped candidate is reported in the notes", () => {
  const benchmark = computeBenchmark([makeInput()], {
    candidatesConsidered: 2,
    skippedSessions: 1,
  });
  assert.equal(benchmark.candidatesConsidered, 2);
  assert.ok(
    benchmark.basisNotes.some((note) =>
      /1 candidate session\(s\) could not be loaded/.test(note),
    ),
  );
});

// ---------------------------------------------------------------------------
// Pure filter helpers
// ---------------------------------------------------------------------------

test("hasBenchmarkCriteria ignores groupBy and blank strings", () => {
  assert.equal(hasBenchmarkCriteria({}), false);
  assert.equal(hasBenchmarkCriteria({ groupBy: "model" }), false);
  assert.equal(hasBenchmarkCriteria({ agent: "   " }), false);
  assert.equal(hasBenchmarkCriteria({ from: 0 }), true);
  assert.equal(hasBenchmarkCriteria({ to: BASE }), true);
  for (const key of [
    "model",
    "provider",
    "agent",
    "directory",
    "outcome",
    "taskType",
  ] as const) {
    assert.equal(hasBenchmarkCriteria({ [key]: "x" }), true, key);
  }
});

test("summary filters compare case-insensitively and bound the recency anchor", () => {
  const facts = {
    directory: "C:/Work/Project",
    model: { providerID: "Test-Provider", id: "Test-Model" },
    agent: "Build",
    outcome: "succeeded",
    timeCreated: BASE,
    timeUpdated: BASE + 5_000,
  };
  assert.equal(matchesBenchmarkFilters(facts, {}), true);
  assert.equal(matchesBenchmarkFilters(facts, { model: "test-model" }), true);
  assert.equal(matchesBenchmarkFilters(facts, { model: "other" }), false);
  assert.equal(matchesBenchmarkFilters(facts, { provider: "test-provider" }), true);
  assert.equal(matchesBenchmarkFilters(facts, { provider: "other" }), false);
  assert.equal(matchesBenchmarkFilters(facts, { agent: "build" }), true);
  assert.equal(matchesBenchmarkFilters(facts, { agent: "explorer" }), false);
  assert.equal(matchesBenchmarkFilters(facts, { directory: "work/proj" }), true);
  assert.equal(matchesBenchmarkFilters(facts, { directory: "other" }), false);
  assert.equal(matchesBenchmarkFilters(facts, { outcome: "SUCCEEDED" }), true);
  assert.equal(matchesBenchmarkFilters(facts, { outcome: "failed" }), false);
  assert.equal(matchesBenchmarkFilters(facts, { from: BASE + 5_000 }), true);
  assert.equal(matchesBenchmarkFilters(facts, { from: BASE + 5_001 }), false);
  assert.equal(matchesBenchmarkFilters(facts, { to: BASE + 5_000 }), true);
  assert.equal(matchesBenchmarkFilters(facts, { to: BASE + 4_999 }), false);

  // The recency anchor falls back to timeCreated when time.updated is absent.
  const noUpdate = { ...facts, timeUpdated: undefined };
  assert.equal(matchesBenchmarkFilters(noUpdate, { from: BASE }), true);
  assert.equal(matchesBenchmarkFilters(noUpdate, { from: BASE + 1 }), false);
});

test("the task-type filter matches recorded trigger kinds only", () => {
  const input = makeInput({ taskTypes: ["delegation"] });
  assert.equal(matchesBenchmarkTaskType(input, undefined), true);
  assert.equal(matchesBenchmarkTaskType(input, "delegation"), true);
  assert.equal(matchesBenchmarkTaskType(input, "user"), false);
  assert.equal(matchesBenchmarkTaskType(input, "retry"), false);
  assert.equal(matchesBenchmarkTaskType(makeInput({ taskTypes: [] }), "user"), false);
});

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

test("failing tools are ranked by incident count, then by name", async () => {
  const service = serviceOf(candidatesFixture());
  const dataset = await service.loadDataset("ses_a");
  assert.deepEqual(failingToolsOf(dataset.analysis), ["grep"]);
  assert.deepEqual(taskTypesOf(dataset.analysis), ["user"]);
});

test("failing tools order by count descending, then name ascending", async () => {
  const call = (name: string, seq: number): unknown =>
    toolBlock({
      name,
      created: BASE + seq * 10,
      ran: BASE + seq * 10 + 1,
      completed: BASE + seq * 10 + 2,
      status: "error",
      input: {},
      output: "",
    });
  const service = serviceOf(
    fixture([
      {
        meta: session("ses_order", {
          time: { created: BASE, updated: BASE + 1_000, busy: BASE, idle: BASE + 900 },
        }),
        messages: [
          user("msg_u1", 1, BASE),
          assistant({
            id: "msg_a1",
            seq: 2,
            created: BASE + 10,
            streamed: BASE + 200,
            completed: BASE + 300,
            // grep 2 errors (top), read 1, bash 1: the tie is broken by name.
            content: [
              call("grep", 1),
              call("read", 2),
              call("grep", 3),
              call("bash", 4),
            ],
            tokens: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            cost: 0.001,
          }),
          idle("msg_i1", 3, BASE + 400, "succeeded"),
        ],
      },
    ]),
  );
  const dataset = await service.loadDataset("ses_order");
  assert.deepEqual(failingToolsOf(dataset.analysis), ["grep", "bash", "read"]);
});

test("benchmarkInputFrom copies the summary and the totals-level row", async () => {
  const service = serviceOf(candidatesFixture());
  const summaries = await service.listSessions({ limit: 10 });
  const summary = summaries.find((item) => item.id === "ses_b")!;
  const dataset = await service.loadDataset("ses_b");
  const input = benchmarkInputFrom(summary, dataset.analysis);

  assert.equal(input.sessionID, "ses_b");
  assert.equal(input.directory, "C:/fixtures/project");
  assert.equal(input.model, MODEL.id);
  assert.equal(input.provider, MODEL.providerID);
  assert.equal(input.agent, "explorer");
  assert.equal(input.outcome, "failed");
  assert.equal(input.timeUpdated, BASE + 8_000);
  assert.equal(input.windowed, false);
  assert.deepEqual(input.taskTypes, ["user"]);
  assert.deepEqual(input.failingTools, ["grep"]);
  assert.equal(input.totals.turns, 1);
  assert.equal(input.totals.steps, 1);
  assert.equal(input.totals.errors, 1);
  assert.ok(input.totals.duration !== null);
  assert.ok(input.totals.cost !== null);
});

test("rollupsFor is pure and reusable", () => {
  const inputs = [makeInput(), makeInput({ sessionID: "ses_b", windowed: true })];
  const first = rollupsFor(inputs);
  const second = rollupsFor(inputs);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// Service filters
// ---------------------------------------------------------------------------

test("the service applies every summary filter", async () => {
  const service = serviceOf(candidatesFixture());

  assert.equal((await service.benchmark({ agent: "build" })).overall.count, 2);
  assert.equal((await service.benchmark({ provider: "test-provider" })).overall.count, 3);
  assert.equal((await service.benchmark({ model: "test-model" })).overall.count, 3);
  assert.equal((await service.benchmark({ directory: "fixtures" })).overall.count, 3);
  assert.equal((await service.benchmark({ outcome: "failed" })).overall.count, 1);
  assert.equal((await service.benchmark({ from: BASE + 5_000 })).overall.count, 2);
  assert.equal((await service.benchmark({ to: BASE + 2_000 })).overall.count, 1);
  assert.equal(
    (await service.benchmark({ from: BASE + 1_000, to: BASE + 8_000 })).overall.count,
    2,
  );
  assert.equal(
    (await service.benchmark({ agent: "build", outcome: "failed" })).overall.count,
    0,
  );
});

test("the service compares in recency order and reports the candidate set", async () => {
  const service = serviceOf(candidatesFixture());
  const benchmark = await service.benchmark({ directory: "fixtures" });

  assert.equal(benchmark.overall.count, 3);
  assert.equal(benchmark.candidatesConsidered, 3);
  assert.equal(benchmark.sessionsCapped, false);
  const pattern = benchmark.recurringPatterns.find(
    (item) => item.kind === "failing-tool",
  );
  assert.equal(pattern?.key, "grep");
  // Recency order: updated 9000, 8000, then 1000.
  assert.deepEqual(pattern?.sessionIDs, ["ses_a", "ses_b", "ses_c"]);

  const narrowed = await service.benchmark({ agent: "build" });
  assert.equal(narrowed.overall.count, 2);
  assert.equal(
    narrowed.recurringPatterns.length,
    0,
    "two sessions are below the pattern floor",
  );
});

test("the service caps at MAX_BENCHMARK_SESSIONS and notes it", async () => {
  const service = serviceOf(manySessionsFixture(MAX_BENCHMARK_SESSIONS + 1));
  const benchmark = await service.benchmark({ agent: "build" });

  assert.equal(benchmark.candidatesConsidered, MAX_BENCHMARK_SESSIONS);
  assert.equal(benchmark.overall.count, MAX_BENCHMARK_SESSIONS);
  const capped = await service.benchmark({ directory: "fixtures" }, {});
  assert.equal(capped.sessionsCapped, true);
  assert.equal(capped.candidatesConsidered, MAX_BENCHMARK_SESSIONS + 1);
  assert.equal(capped.overall.count, MAX_BENCHMARK_SESSIONS);

  const grouped = await service.benchmark({ directory: "fixtures", groupBy: "agent" });
  assert.deepEqual(
    grouped.groups.map((group) => group.key),
    ["build"],
    "the oldest candidate fell outside the cap",
  );
});

test("the task-type filter selects sessions by recorded turn trigger", async () => {
  const service = serviceOf(subagentFixture());
  const delegation = await service.benchmark({ taskType: "delegation" });
  assert.equal(delegation.overall.count, 1);
  assert.equal(delegation.groups.length, 0);

  const grouped = await service.benchmark({
    directory: "fixtures",
    taskType: "delegation",
    groupBy: "taskType",
  });
  assert.deepEqual(
    grouped.groups.map((group) => group.key),
    ["delegation"],
  );

  const user = await service.benchmark({ taskType: "user" });
  assert.equal(user.overall.count, 1);
  assert.equal(user.overall.rollups.sessions, 1);
});

test("the compared note names the compared count, not the loaded or matched count", async () => {
  const service = serviceOf(delegationHeavyFixture());
  const benchmark = await service.benchmark({
    directory: "fixtures",
    taskType: "delegation",
  });

  // 52 summary matches, 50 loaded (the cap), 2 of them delegated and compared.
  assert.equal(benchmark.overall.count, 2);
  assert.equal(benchmark.candidatesConsidered, 52);
  assert.equal(benchmark.sessionsCapped, true);
  assert.equal(
    benchmark.basisNotes[0],
    "Compared 2 of 50 loaded candidates (52 sessions matched the summary filters; older candidates were not loaded).",
  );
  assert.doesNotMatch(benchmark.basisNotes[0], /Compared 52/);
  assert.doesNotMatch(benchmark.basisNotes[0], /of 52/);
  // The 48 loaded candidates the task-type filter dropped get their own note.
  assert.equal(
    benchmark.basisNotes[1],
    "48 loaded candidates recorded none of the requested task types and were not compared.",
  );
});

test("the task-type drop note is absent when nothing was dropped after loading", async () => {
  const service = serviceOf(candidatesFixture());
  const benchmark = await service.benchmark({ directory: "fixtures" });
  assert.equal(
    benchmark.basisNotes.some((note) => note.includes("recorded none of the requested task types")),
    false,
  );
});

test("an empty comparison is a 200-shaped benchmark, not an error", async () => {
  const service = serviceOf(candidatesFixture());
  const benchmark = await service.benchmark({ agent: "nobody", groupBy: "agent" });
  assert.equal(benchmark.overall.count, 0);
  assert.deepEqual(benchmark.groups, []);
  assert.equal(benchmark.candidatesConsidered, 0);
  assert.equal(
    benchmark.basisNotes[0],
    "Compared 0 of 0 loaded candidates (0 sessions matched the summary filters).",
  );
});

test("the benchmark never clears the dataset cache", async () => {
  const service = serviceOf(candidatesFixture());
  let cleared = 0;
  service.clearCache = () => {
    cleared += 1;
  };
  await service.benchmark({ agent: "build" });
  await service.benchmark({ agent: "build", groupBy: "agent" });
  assert.equal(cleared, 0);
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test("payload text never reaches the benchmark and redaction is a pass-through", async () => {
  const service = serviceOf(secretsFixture());
  const redacted = await service.benchmark({ directory: "fixtures" });
  const revealed = await service.benchmark(
    { directory: "fixtures" },
    { reveal: true },
  );

  for (const benchmark of [redacted, revealed]) {
    const text = JSON.stringify(benchmark);
    assert.doesNotMatch(text, /sk-supersecretvalue12345/);
    assert.doesNotMatch(text, /hunter2/);
    assert.doesNotMatch(text, /ghp_abcdefghijklmnopqrstuvwxyz/);
    assert.equal(benchmark.overall.count, 1);
  }
  assert.deepEqual(redacted, revealed);
});

test("a secret-looking session field stays redacted by default", async () => {
  const sensitive = fixture([
    {
      meta: session("ses_secret_dir", {
        directory: "sk-abcdefghijklmnopqrstuvwxyz",
        time: { created: BASE, updated: BASE + 100, busy: BASE, idle: BASE + 90 },
      }),
      messages: [
        user("msg_u1", 1, BASE),
        assistant({
          id: "msg_a1",
          seq: 2,
          created: BASE + 10,
          streamed: BASE + 20,
          completed: BASE + 30,
          tokens: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0.001,
        }),
        idle("msg_i1", 3, BASE + 40, "succeeded"),
      ],
    },
  ]);
  const service = serviceOf(sensitive);
  const redacted = await service.benchmark({ agent: "build" }, {});
  assert.doesNotMatch(JSON.stringify(redacted), /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.equal(redacted.overall.count, 1);
  assert.equal(redacted.groups.length, 0);
});
