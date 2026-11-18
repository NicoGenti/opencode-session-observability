import test from "node:test";
import assert from "node:assert/strict";

import { ObservabilityService } from "../src/core/service.ts";
import { pathIdentity } from "../src/core/attribution.ts";
import { MAX_EVENT_LINKS } from "../src/core/health.ts";
import {
  COMPACTION_CONTEXT_CEILING,
  CONCENTRATED_FILE_MIN_FILES,
  CONCENTRATED_FILE_SHARE,
  MAX_RECOMMENDATION_ROWS,
  MAX_RECOMMENDATION_TURN_LINKS,
  REUSE_SUBAGENT_MIN_CALLS,
  SPLIT_TASK_MIN_DURATION_MS,
  SPLIT_TASK_MIN_STEPS,
  evaluateRecommendations,
} from "../src/core/recommendations.ts";
import type {
  Recommendation,
  Recommendations,
  RecommendationRuleId,
} from "../src/core/recommendations.ts";
import type { DiagnosticIncident } from "../src/core/diagnostics.ts";
import type { Analysis, CompactionTransaction } from "../src/core/types.ts";
import { metric } from "../src/core/types.ts";
import {
  BASE,
  assistant,
  compactionFixture,
  fixture,
  idle,
  memorySource,
  secretsFixture,
  session,
  simpleFixture,
  subagentFixture,
  textBlock,
  toolBlock,
  user,
} from "./fixtures/build.ts";
import type { Fixture } from "./fixtures/build.ts";

const TOKENS = {
  input: 100,
  output: 10,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

async function analysisOf(data: Fixture, id?: string): Promise<Analysis> {
  const service = new ObservabilityService(memorySource(data));
  const dataset = await service.loadDataset(id ?? data.sessions[0]!.meta.id);
  return dataset.analysis;
}

function recommendationsOf(analysis: Analysis): Recommendations {
  // Evaluated on demand: several cases mutate the loaded DTO to exercise a
  // boundary, so reading the attached rider would assert a stale verdict. The
  // attachment itself is covered by its own test below.
  const recommendations = evaluateRecommendations(analysis);
  assert.ok(recommendations, "recommendations must trigger");
  return recommendations;
}

function rowsFor(analysis: Analysis, ruleID: RecommendationRuleId): Recommendation[] {
  return recommendationsOf(analysis).rows.filter((row) => row.ruleID === ruleID);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `steps` assistant steps in one turn; the last one ends the turn. */
function stepFixture(steps: number, costPerStep = 0.001): Fixture {
  const messages = [user("msg_u1", 1, BASE)];
  for (let index = 0; index < steps; index += 1) {
    messages.push(
      assistant({
        id: `msg_a${index}`,
        seq: index + 2,
        created: BASE + 100 + index * 100,
        streamed: BASE + 140 + index * 100,
        completed: BASE + 180 + index * 100,
        content: [textBlock(`Step ${index}`)],
        tokens: TOKENS,
        cost: costPerStep,
      }),
    );
  }
  messages.push(idle("msg_i1", steps + 2, BASE + 100 + steps * 100 + 200, "succeeded"));
  return fixture([
    {
      meta: session("ses_steps", {
        time: {
          created: BASE,
          updated: BASE + 100 + steps * 100 + 200,
          busy: BASE,
          idle: BASE + 100 + steps * 100 + 200,
        },
      }),
      messages,
    },
  ]);
}

/** One failing shell tool in the turn's last step: no recovery evidence. */
function failingToolFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 200,
      completed: BASE + 400,
      content: [
        toolBlock({
          name: "shell",
          created: BASE + 150,
          ran: BASE + 180,
          completed: BASE + 400,
          status: "error",
          input: {
            command: "API_KEY=SECRET_SENTINEL_TOKEN curl https://x",
          },
          output: "sk-abcdefghijklmnopqrstuvwxyz",
          error: { type: "tool.invalid", message: "boom", status: 400 },
        }),
      ],
      tokens: TOKENS,
      cost: 0.01,
    }),
    idle("msg_i1", 3, BASE + 500, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_failing_tool", {
        time: { created: BASE, updated: BASE + 500, busy: BASE, idle: BASE + 500 },
      }),
      messages,
    },
  ]);
}

/** Two attributed files, one carrying almost all of the step cost. */
function twoFileFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 200,
      completed: BASE + 300,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 120,
          ran: BASE + 150,
          completed: BASE + 200,
          input: { path: "src/hot.ts" },
          output: "hot",
        }),
      ],
      tokens: TOKENS,
      cost: 0.02,
    }),
    assistant({
      id: "msg_a2",
      seq: 3,
      created: BASE + 400,
      streamed: BASE + 500,
      completed: BASE + 600,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 420,
          ran: BASE + 450,
          completed: BASE + 500,
          input: { path: "src/cold.ts" },
          output: "cold",
        }),
      ],
      tokens: TOKENS,
      cost: 0.001,
    }),
    idle("msg_i1", 4, BASE + 700, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_files", {
        time: { created: BASE, updated: BASE + 700, busy: BASE, idle: BASE + 700 },
      }),
      messages,
    },
  ]);
}

/**
 * One file recorded with a different separator in each of two turns, plus a
 * distinct second file so the concentration rule still has two identities.
 */
function twoSpellingFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 200,
      completed: BASE + 300,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 120,
          ran: BASE + 150,
          completed: BASE + 200,
          input: { path: "src\\hot.ts" },
          output: "hot",
        }),
      ],
      tokens: TOKENS,
      cost: 0.02,
    }),
    assistant({
      id: "msg_a2",
      seq: 3,
      created: BASE + 400,
      streamed: BASE + 500,
      completed: BASE + 600,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 420,
          ran: BASE + 450,
          completed: BASE + 500,
          input: { path: "src/cold.ts" },
          output: "cold",
        }),
      ],
      tokens: TOKENS,
      // A positive share small enough that the aggregated hot file still
      // rounds to 100% while a second identity exists.
      cost: 0.000000000001,
    }),
    idle("msg_i1", 4, BASE + 700, "succeeded"),
    user("msg_u2", 5, BASE + 800),
    assistant({
      id: "msg_a3",
      seq: 6,
      created: BASE + 900,
      streamed: BASE + 950,
      completed: BASE + 1_000,
      content: [
        toolBlock({
          name: "read",
          created: BASE + 920,
          ran: BASE + 940,
          completed: BASE + 960,
          input: { path: "src/hot.ts" },
          output: "hot again",
        }),
      ],
      tokens: TOKENS,
      cost: 0.02,
    }),
    idle("msg_i2", 7, BASE + 1_100, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_two_spellings", {
        time: {
          created: BASE,
          updated: BASE + 1_100,
          busy: BASE,
          idle: BASE + 1_100,
        },
      }),
      messages,
    },
  ]);
}

function incident(
  tool: string,
  turnID: string,
  attempts: number,
  overrides: Partial<DiagnosticIncident> = {},
): DiagnosticIncident {
  return {
    tool,
    turn: 1,
    turnID,
    attempts,
    recoveryEventID: null,
    recovery: "no-recovery-evidence",
    basis: "derived",
    failureBasis: "measured",
    why: "deterministic explanation",
    inputsCompared: false,
    inputsComparable: true,
    similarity: "unknown",
    inputKeyShape: null,
    firstFailureEventID: `f_${tool}_${turnID}_${attempts}`,
    lastFailureEventID: `l_${tool}_${turnID}_${attempts}`,
    failureEventIDs: [`f_${tool}_${turnID}_${attempts}`],
    successEventID: null,
    trigger: { kind: "user", eventID: "msg_u1", label: "User message" },
    elapsed: metric(null, "unavailable"),
    stepCostSum: metric(attempts / 100, "derived"),
    ...overrides,
  };
}

/** Injects a triggered `context-growth` health rule onto a loaded analysis. */
function withContextGrowth(analysis: Analysis): Analysis {
  analysis.health = {
    state: "watch",
    insufficient: false,
    insufficientReasons: [],
    triggeredCount: 1,
    rules: [
      {
        id: "context-growth",
        label: "Context growth",
        triggered: true,
        level: "watch",
        evaluable: true,
        note: "longest growth run 5 turn(s); final context 160000",
        eventIDs: [],
        turnIDs: analysis.turns.map((turn) => turn.id),
      },
    ],
  };
  return analysis;
}

/** A compaction-shaped row with a small recorded pre-compaction context. */
function smallCompaction(turnID: string): CompactionTransaction {
  return {
    eventID: "msg_comp_union",
    turnID,
    timestamp: BASE + 500,
    status: "completed",
    reason: null,
    model: null,
    provider: null,
    tokens: null,
    cost: null,
    summaryChars: 0,
    summaryPreview: "",
    contextBefore: metric(1_000, "derived"),
    contextAfter: metric(500, "derived"),
    contextDelta: metric(-500, "derived"),
    removedTokens: metric(500, "derived"),
    duration: metric(null, "unavailable"),
    uncertainty: [],
  };
}

/**
 * One analysis that triggers all six rules, for the neutrality and windowed
 * tests. Each mutation supplies the missing source layer to a loaded fixture;
 * everything stays a normal `Analysis`, so the evaluator runs unmodified.
 */
async function allRulesAnalysis(): Promise<Analysis> {
  const analysis = withContextGrowth(await analysisOf(failingToolFixture()));
  const turn = analysis.turns[0]!;
  // split-task: the 15-minute recorded-turn-time trigger.
  turn.totalTime = metric(SPLIT_TASK_MIN_DURATION_MS, "derived");
  // reuse-subagent: a count plus the attributed subtask that anchors it.
  analysis.totals.subagentCalls = REUSE_SUBAGENT_MIN_CALLS;
  analysis.attribution!.turns[0]!.subtasks = [
    { sessionID: "ses_child", agent: "explorer", basis: "measured" },
  ];
  // avoid-unnecessary-compaction: one small-prompt-token compaction.
  analysis.compactions = [smallCompaction(turn.id)];
  // concentrated-file-cost: one dominant file plus a second identity.
  analysis.attribution!.turns[0]!.files = [
    {
      path: "src/hot.ts",
      ops: { read: 1, write: 0 },
      costShare: metric(0.9, "derived"),
      basis: "measured",
      eventIDs: ["msg_a1:0"],
    },
    {
      path: "src/cold.ts",
      ops: { read: 1, write: 0 },
      costShare: metric(0.01, "derived"),
      basis: "measured",
      eventIDs: ["msg_a1:1"],
    },
  ];
  return analysis;
}

const ALL_RULES: readonly RecommendationRuleId[] = [
  "reduce-context",
  "retry-failed-tool",
  "split-task",
  "reuse-subagent",
  "avoid-unnecessary-compaction",
  "concentrated-file-cost",
];

// ---------------------------------------------------------------------------
// Rule 1 — reduce-context
// ---------------------------------------------------------------------------

test("reduce-context restates the triggered health rule and pairs a trim hypothesis", async () => {
  const analysis = withContextGrowth(await analysisOf(simpleFixture()));
  const rows = rowsFor(analysis, "reduce-context");

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.kind, "fact");
  assert.equal(rows[0]!.severity, "info");
  assert.equal(rows[0]!.id, "reduce-context:fact");
  assert.equal(rows[0]!.label, "Context growth");
  assert.match(rows[0]!.note, /Health rule "context-growth" is triggered \(watch\)/);
  // The health rule's own deterministic phrase is restated, not recounted.
  assert.match(rows[0]!.note, /longest growth run 5 turn\(s\); final context 160000/);
  assert.equal(rows[1]!.kind, "hypothesis");
  assert.equal(rows[1]!.severity, "advisory");
  assert.equal(rows[1]!.id, "reduce-context:hypothesis");
  assert.match(rows[1]!.note, /trimming or summarizing in-turn context/);
  assert.ok(rows[1]!.turnIDs.length > 0, "the health rule's turn links ride along");
  // The health rule records no event ids, so turn anchors supply the link.
  assert.ok(rows[0]!.eventIDs.length > 0, "every row must link to an event");
  assert.ok(rows[1]!.eventIDs.length > 0, "every row must link to an event");
});

test("reduce-context stays silent when context-growth did not trigger", async () => {
  const plain = await analysisOf(simpleFixture());
  assert.equal(plain.recommendations, undefined);

  const analysis = await analysisOf(simpleFixture());
  const rule = analysis.health!.rules.find((item) => item.id === "context-growth")!;
  rule.triggered = false;
  rule.level = null;
  assert.deepEqual(
    evaluateRecommendations(analysis)?.rows.filter((row) => row.ruleID === "reduce-context") ??
      [],
    [],
  );});

// ---------------------------------------------------------------------------
// Rule 2 — retry-failed-tool
// ---------------------------------------------------------------------------

test("retry-failed-tool restates unrecovered incidents and names the tool", async () => {
  const analysis = await analysisOf(failingToolFixture());
  assert.equal(analysis.diagnostics?.incidents.length, 1);
  assert.equal(analysis.diagnostics?.incidents[0]!.recovery, "no-recovery-evidence");

  const rows = rowsFor(analysis, "retry-failed-tool");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.kind, "fact");
  assert.match(rows[0]!.note, /1 incident\(s\) across 1 tool\(s\) have no recovery evidence/);
  assert.match(rows[0]!.note, /shell failed 1 time\(s\) in one run/);
  assert.equal(rows[1]!.kind, "hypothesis");
  assert.match(rows[1]!.note, /checking its precondition or configuration/);
  // The first failure event anchors the drill link.
  assert.equal(rows[0]!.eventIDs[0], analysis.diagnostics!.incidents[0]!.firstFailureEventID);
  assert.equal(rows[0]!.turnIDs[0], analysis.diagnostics!.incidents[0]!.turnID);
});

test("retry-failed-tool ignores recovered, possible-recovery and insufficient incidents", async () => {
  const analysis = await analysisOf(failingToolFixture());
  for (const recovery of ["recovered", "possible-recovery", "insufficient-data"] as const) {
    analysis.diagnostics!.incidents = [
      incident("shell", analysis.turns[0]!.id, 2, { recovery }),
    ];
    assert.deepEqual(
      evaluateRecommendations(analysis)?.rows.filter(
        (row) => row.ruleID === "retry-failed-tool",
      ) ?? [],
      [],
      recovery,
    );
  }
  analysis.diagnostics = undefined;
  assert.equal(
    evaluateRecommendations(analysis)?.rows.some(
      (row) => row.ruleID === "retry-failed-tool",
    ) ?? false,
    false,
  );
});

test("retry-failed-tool caps its evidence and names the longest run", async () => {
  const analysis = await analysisOf(failingToolFixture());
  const turnID = analysis.turns[0]!.id;
  analysis.diagnostics!.incidents = [
    incident("grep", turnID, 20),
    ...Array.from({ length: 14 }, (_, index) =>
      incident(`tool${index}`, turnID, index + 1),
    ),
  ];
  const rows = rowsFor(analysis, "retry-failed-tool");
  const fact = rows[0]!;

  assert.equal(fact.eventIDs.length, MAX_EVENT_LINKS);
  assert.equal(fact.turnIDs.length, 1, "one distinct turn id is never duplicated");
  assert.match(fact.note, /15 incident\(s\) across 15 tool\(s\)/);
  assert.match(fact.note, /grep failed 20 time\(s\)/);
});

// ---------------------------------------------------------------------------
// Rule 3 — split-task
// ---------------------------------------------------------------------------

test("split-task triggers on the step bound and pairs a splitting hypothesis", async () => {
  const analysis = await analysisOf(stepFixture(SPLIT_TASK_MIN_STEPS));
  const rows = rowsFor(analysis, "split-task");

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.kind, "fact");
  assert.match(rows[0]!.note, new RegExp(`Turn 1 recorded ${SPLIT_TASK_MIN_STEPS} step`));
  assert.equal(rows[0]!.turnIDs[0], analysis.turns[0]!.id);
  assert.equal(rows[1]!.kind, "hypothesis");
  assert.match(rows[1]!.note, /splitting this turn into smaller prompts/);
});

test("split-task stays silent below the step and duration bounds", async () => {
  const below = await analysisOf(stepFixture(SPLIT_TASK_MIN_STEPS - 1));
  assert.deepEqual(
    evaluateRecommendations(below)?.rows.filter((row) => row.ruleID === "split-task") ??
      [],
    [],
  );

  const analysis = await analysisOf(stepFixture(2));
  // A long recorded turn time is the second, independent trigger.
  analysis.turns[0]!.totalTime = metric(SPLIT_TASK_MIN_DURATION_MS, "derived");
  const rows = rowsFor(analysis, "split-task");
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.note, /min of recorded turn time/);
  assert.deepEqual(
    (await analysisOf(stepFixture(2))).recommendations?.rows.filter(
      (row) => row.ruleID === "split-task",
    ) ?? [],
    [],
  );
});

// ---------------------------------------------------------------------------
// Rule 4 — reuse-subagent
// ---------------------------------------------------------------------------

test("reuse-subagent triggers from three recorded subagent calls with attribution evidence", async () => {
  const analysis = await analysisOf(subagentFixture(), "ses_parent");
  analysis.totals.subagentCalls = REUSE_SUBAGENT_MIN_CALLS;
  const rows = rowsFor(analysis, "reuse-subagent");

  assert.equal(rows.length, 2);
  assert.match(rows[0]!.note, /3 subagent call\(s\) were recorded/);
  assert.equal(rows[0]!.severity, "info");
  assert.match(rows[1]!.note, /one reusable subagent/);
  // The attributed subtask turn is the evidence.
  assert.equal(rows[0]!.turnIDs.length, 1);
  // `totals` carries no event ids; the attributed turn's anchor is the link.
  assert.ok(rows[0]!.eventIDs.length > 0);
  assert.ok(rows[1]!.eventIDs.length > 0);
});

test("reuse-subagent stays silent below three calls", async () => {
  const analysis = await analysisOf(subagentFixture(), "ses_parent");
  analysis.totals.subagentCalls = REUSE_SUBAGENT_MIN_CALLS - 1;
  assert.deepEqual(
    evaluateRecommendations(analysis)?.rows.filter(
      (row) => row.ruleID === "reuse-subagent",
    ) ?? [],
    [],
  );
});

test("reuse-subagent stays silent when the call count has no attributed subtask", async () => {
  const analysis = await analysisOf(subagentFixture(), "ses_parent");
  analysis.totals.subagentCalls = REUSE_SUBAGENT_MIN_CALLS;
  for (const turn of analysis.attribution?.turns ?? []) turn.subtasks = [];
  assert.deepEqual(
    evaluateRecommendations(analysis)?.rows.filter(
      (row) => row.ruleID === "reuse-subagent",
    ) ?? [],
    [],
  );
});

// ---------------------------------------------------------------------------
// Rule 5 — avoid-unnecessary-compaction
// ---------------------------------------------------------------------------

test("avoid-unnecessary-compaction questions compactions below the prompt-token ceiling", async () => {
  const analysis = await analysisOf(compactionFixture());
  const compaction = analysis.compactions[0]!;
  assert.ok((compaction.contextBefore.value ?? 0) < COMPACTION_CONTEXT_CEILING);
  const rows = rowsFor(analysis, "avoid-unnecessary-compaction");

  assert.equal(rows.length, 2);
  assert.match(rows[0]!.note, /1 of 1 compaction\(s\)/);
  assert.match(rows[0]!.note, new RegExp(`${COMPACTION_CONTEXT_CEILING} prompt tokens`));
  assert.equal(rows[0]!.eventIDs[0], compaction.eventID);
  assert.match(rows[1]!.note, /may not have been necessary/);
});

test("avoid-unnecessary-compaction stays silent at or above the prompt-token ceiling", async () => {
  const analysis = await analysisOf(compactionFixture());
  analysis.compactions[0]!.contextBefore = metric(
    COMPACTION_CONTEXT_CEILING,
    "derived",
  );
  assert.deepEqual(
    evaluateRecommendations(analysis)?.rows.filter(
      (row) => row.ruleID === "avoid-unnecessary-compaction",
    ) ?? [],
    [],
  );

  const unknown = await analysisOf(compactionFixture());
  unknown.compactions[0]!.contextBefore = metric(null, "unavailable");
  assert.deepEqual(
    evaluateRecommendations(unknown)?.rows.filter(
      (row) => row.ruleID === "avoid-unnecessary-compaction",
    ) ?? [],
    [],
  );
});

// ---------------------------------------------------------------------------
// Rule 6 — concentrated-file-cost (attribution source)
// ---------------------------------------------------------------------------

test("a file topping the attribution cost share yields a fact row", async () => {
  const analysis = await analysisOf(twoFileFixture());
  assert.ok(analysis.attribution, "attribution drives this rule");
  assert.equal(
    analysis.attribution.turns.flatMap((turn) => turn.files).length,
    CONCENTRATED_FILE_MIN_FILES,
  );
  const rows = rowsFor(analysis, "concentrated-file-cost");

  assert.equal(rows.length, 1, "this rule is a fact, with no hypothesis to pair");
  assert.equal(rows[0]!.kind, "fact");
  assert.match(rows[0]!.note, /src\/hot\.ts carries \d+% of the attributed file cost/);
  assert.match(rows[0]!.note, /across 1 turn\(s\)/);
  assert.ok(rows[0]!.eventIDs.length > 0);
});

test("concentrated-file-cost aggregates two spellings of one path by identity", async () => {
  const analysis = await analysisOf(twoSpellingFixture());
  assert.deepEqual(
    pathIdentity("src\\hot.ts"),
    pathIdentity("src/hot.ts"),
    "the exported identity is the single path rule",
  );
  assert.equal(
    analysis.attribution!.turns.flatMap((turn) => turn.files).length,
    3,
    "three raw file rows across two turns",
  );

  const rows = rowsFor(analysis, "concentrated-file-cost");
  assert.equal(rows.length, 1);
  const note = rows[0]!.note;
  // One aggregated entry, first-seen spelling, 100% of the cost, both turns.
  assert.match(note, /src\\hot\.ts carries 100% of the attributed file cost/);
  assert.match(note, /across 2 turn\(s\)/);
  assert.ok(rows[0]!.eventIDs.length > 0);
});

test("concentrated-file-cost needs two files and half of the share", async () => {
  const single = await analysisOf(twoFileFixture());
  single.attribution!.turns = [
    { ...single.attribution!.turns[0]!, files: [single.attribution!.turns[0]!.files[0]!] },
  ];
  assert.deepEqual(
    evaluateRecommendations(single)?.rows.filter(
      (row) => row.ruleID === "concentrated-file-cost",
    ) ?? [],
    [],
  );

  const spread = await analysisOf(twoFileFixture());
  const turn = spread.attribution!.turns[0]!;
  turn.files[0]!.costShare = metric(0.01, "derived");
  turn.files[1]!.costShare = metric(0.01, "derived");
  // Three equal shares leave a 33% top file: below the concentration threshold.
  turn.files = [
    ...turn.files,
    {
      ...turn.files[1]!,
      path: "src/warm.ts",
      eventIDs: ["msg_a2:0"],
      costShare: metric(0.01, "derived"),
    },
  ];
  assert.equal(CONCENTRATED_FILE_SHARE, 0.5);
  assert.deepEqual(
    evaluateRecommendations(spread)?.rows.filter(
      (row) => row.ruleID === "concentrated-file-cost",
    ) ?? [],
    [],
  );

  const absent = await analysisOf(simpleFixture());
  assert.equal(absent.attribution, undefined);
  assert.deepEqual(
    evaluateRecommendations(absent)?.rows.filter(
      (row) => row.ruleID === "concentrated-file-cost",
    ) ?? [],
    [],
  );
});

// ---------------------------------------------------------------------------
// Shape, pairing, neutrality
// ---------------------------------------------------------------------------

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectKeys(item, out);
    }
  }
  return out;
}

test("every hypothesis ships with a companion fact naming its finding, per analysis", async () => {
  const reuse = await analysisOf(subagentFixture(), "ses_parent");
  reuse.totals.subagentCalls = REUSE_SUBAGENT_MIN_CALLS;
  const analyses = [
    await analysisOf(stepFixture(SPLIT_TASK_MIN_STEPS)),
    await analysisOf(compactionFixture()),
    await analysisOf(failingToolFixture()),
    await analysisOf(twoFileFixture()),
    withContextGrowth(await analysisOf(simpleFixture())),
    reuse,
  ];
  let hypotheses = 0;

  for (const analysis of analyses) {
    const rows = recommendationsOf(analysis).rows;
    for (const hypothesis of rows.filter((row) => row.kind === "hypothesis")) {
      hypotheses += 1;
      const facts = rows.filter(
        (row) => row.ruleID === hypothesis.ruleID && row.kind === "fact",
      );
      assert.equal(
        facts.length,
        1,
        `no companion fact for ${hypothesis.ruleID} in this analysis`,
      );
      assert.ok(facts[0]!.note.length > 0);
      // The fact is listed before its hypothesis: declaration order, not rank.
      const ordered = rows.filter((row) => row.ruleID === hypothesis.ruleID);
      assert.equal(ordered[0]!.kind, "fact");
    }
  }
  assert.equal(hypotheses, 5, "each of the five paired rules is exercised once");
});

test("severity vocabulary is exactly info and advisory", async () => {
  const analysis = withContextGrowth(await analysisOf(stepFixture(SPLIT_TASK_MIN_STEPS)));
  for (const row of recommendationsOf(analysis).rows) {
    assert.ok(row.severity === "info" || row.severity === "advisory", row.severity);
    assert.equal(row.severity, row.kind === "fact" ? "info" : "advisory");
    assert.ok(row.label.length > 0);
    assert.ok(row.note.length > 0);
    assert.ok(!row.note.includes("!"), "notes stay declarative");
  }
});

test("the DTO carries no ranking key anywhere", async () => {
  const analysis = await analysisOf(stepFixture(SPLIT_TASK_MIN_STEPS));
  const recommendations = recommendationsOf(analysis);
  const keys = collectKeys(recommendations);
  const banned = /score|priority|rank|weight/i;

  assert.ok(keys.length > 10);
  for (const key of keys) {
    assert.doesNotMatch(key, banned, `ranking key in DTO: ${key}`);
  }
  assert.ok(recommendations.rows.length <= MAX_RECOMMENDATION_ROWS);
  assert.deepEqual(Object.keys(recommendations), ["rows", "basisNotes"]);
  assert.deepEqual(Object.keys(recommendations.rows[0]!).sort(), [
    "eventIDs",
    "id",
    "kind",
    "label",
    "note",
    "ruleID",
    "severity",
    "turnIDs",
  ]);
});

test("the evaluator is deterministic and never mutates the analysis", async () => {
  const analysis = withContextGrowth(await analysisOf(stepFixture(SPLIT_TASK_MIN_STEPS)));
  const before = JSON.stringify(analysis);
  const first = evaluateRecommendations(analysis);
  const second = evaluateRecommendations(analysis);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(analysis), before, "the input must not be mutated");
  // Two independent evaluations of the same fixture agree too.
  const third = withContextGrowth(await analysisOf(stepFixture(SPLIT_TASK_MIN_STEPS)));
  assert.deepEqual(
    recommendationsOf(third).rows.map((row) => row.id),
    first!.rows.map((row) => row.id),
  );});

test("no payload text enters the recommendation DTO across all six rules", async () => {
  const analysis = await allRulesAnalysis();
  const recommendations = recommendationsOf(analysis);
  const covered = new Set(recommendations.rows.map((row) => row.ruleID));
  assert.deepEqual(
    [...covered].sort(),
    [...ALL_RULES].sort(),
    "the fixture must trigger the whole closed rule set before scanning",
  );
  assert.ok(recommendations.rows.some((row) => row.kind === "fact"));
  assert.ok(recommendations.rows.some((row) => row.kind === "hypothesis"));
  // Non-vacuity per rule and per row: every rule emitted rows, and every row
  // links to at least one recorded event.
  for (const ruleID of ALL_RULES) {
    assert.ok(
      recommendations.rows.some((row) => row.ruleID === ruleID),
      `no row for ${ruleID}`,
    );
  }
  for (const row of recommendations.rows) {
    assert.ok(row.eventIDs.length > 0, `${row.id} carries no event link`);
  }

  // The underlying analysis really carries the payloads the scan looks for.
  const source = JSON.stringify(analysis);
  const sentinels = [
    "SECRET_SENTINEL_TOKEN",
    "API_KEY=",
    "https://x",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "curl",
  ];
  for (const sentinel of sentinels) {
    assert.ok(source.includes(sentinel), `fixture is missing ${sentinel}`);
  }

  // Scan the whole DTO recursively: rows of both kinds and the basis notes.
  const text = JSON.stringify(recommendations);
  for (const sentinel of sentinels) {
    assert.equal(text.includes(sentinel), false, `payload leaked: ${sentinel}`);
  }
});

test("the closed rule set cannot exceed the documented row bound", async () => {
  const analysis = await allRulesAnalysis();
  const rows = recommendationsOf(analysis).rows;

  // Six facts plus five paired hypotheses is the true ceiling.
  assert.equal(rows.length, 11);
  assert.equal(MAX_RECOMMENDATION_ROWS, rows.length);
  assert.ok(rows.length <= MAX_RECOMMENDATION_ROWS);
});

test("windowed analyses qualify aggregating notes and add a basis note", async () => {
  const analysis = await allRulesAnalysis();
  analysis.coverage = { ...analysis.coverage, complete: false };
  const recommendations = recommendationsOf(analysis);
  const aggregating: RecommendationRuleId[] = [
    "concentrated-file-cost",
    "avoid-unnecessary-compaction",
    "reuse-subagent",
    "split-task",
  ];

  for (const ruleID of aggregating) {
    const rows = recommendations.rows.filter((row) => row.ruleID === ruleID);
    assert.ok(rows.length > 0, `${ruleID} must trigger in the union fixture`);
    for (const row of rows) {
      assert.match(
        row.note,
        /\(in the analysed window\)/,
        `${ruleID}:${row.kind} must not state a window aggregate as a session fact`,
      );
    }
  }
  assert.ok(
    recommendations.basisNotes.some((note) =>
      note.includes("The analysis covers a window, not the full session"),
    ),
  );
  // Non-aggregating rules keep their wording.
  for (const row of recommendations.rows.filter(
    (row) => row.ruleID === "retry-failed-tool",
  )) {
    assert.doesNotMatch(row.note, /in the analysed window/);
  }
});

test("the rider is attached by the service only when a rule triggers", async () => {
  const failing = await analysisOf(failingToolFixture());
  assert.ok(failing.recommendations);
  assert.ok(failing.recommendations.rows.length > 0);
  assert.deepEqual(failing.recommendations, evaluateRecommendations(failing));

  const plain = await analysisOf(simpleFixture());
  assert.equal(plain.recommendations, undefined);
});

test("an analysis with nothing to report keeps the rider absent", async () => {
  const analysis = await analysisOf(simpleFixture());
  assert.equal(analysis.recommendations, undefined);
  assert.equal(evaluateRecommendations(analysis), null);
});

test("a malformed analysis yields no rider instead of throwing", () => {
  assert.equal(evaluateRecommendations(null as unknown as Analysis), null);
  assert.equal(evaluateRecommendations({} as Analysis), null);
  assert.equal(
    evaluateRecommendations({
      ...({} as Analysis),
      turns: [],
      events: [],
      compactions: [],
    }),
    null,
  );
});

test("the rider rides the analysis and survives redaction unchanged", async () => {
  const service = new ObservabilityService(memorySource(failingToolFixture()));
  const presented = await service.analyze("ses_failing_tool");
  const revealed = await service.analyze("ses_failing_tool", { reveal: true });

  assert.ok(presented.analysis.recommendations);
  assert.equal(presented.analysis.redacted, true);
  assert.deepEqual(
    presented.analysis.recommendations,
    revealed.analysis.recommendations,
    "recommendations carry no payload text, so redaction leaves them untouched",
  );
  // Export renders the same rider verbatim: the exported JSON's recommendation
  // array deep-equals the one the analysis endpoint presented.
  const exported = await service.export("ses_failing_tool", { format: "json" });
  const payload = JSON.parse(exported.content) as { analysis: Analysis };
  assert.deepEqual(
    payload.analysis.recommendations,
    presented.analysis.recommendations,
  );
});

test("the redacted secret fixture keeps its rider identical to the revealed one", async () => {
  const service = new ObservabilityService(memorySource(secretsFixture()));
  const presented = await service.analyze("ses_secrets");
  const revealed = await service.analyze("ses_secrets", { reveal: true });

  assert.deepEqual(
    presented.analysis.recommendations,
    revealed.analysis.recommendations,
    "a payload-free rider cannot differ between redacted and revealed copies",
  );
});

test("turn evidence is capped and the fact/hypothesis rows are in fixed rule order", async () => {
  const analysis = withContextGrowth(await analysisOf(failingToolFixture()));
  const rows = recommendationsOf(analysis).rows;
  const order = rows.map((row) => row.ruleID);

  assert.ok(order.indexOf("reduce-context") >= 0);
  assert.ok(order.indexOf("retry-failed-tool") >= 0);
  assert.ok(
    order.indexOf("reduce-context") < order.indexOf("retry-failed-tool"),
    "rows follow the declaration order of the rule set",
  );
  for (const row of rows) {
    assert.ok(row.turnIDs.length <= MAX_RECOMMENDATION_TURN_LINKS);
    assert.ok(row.eventIDs.length <= MAX_EVENT_LINKS);
  }
});
