import test from "node:test";
import assert from "node:assert/strict";
import {
  DIGEST_MAX_CHARS,
  REVIEW_PROMPT_INSTRUCTIONS,
  buildReviewPrompt,
  buildSessionDigest,
} from "../src/core/digest.ts";
import { EMPTY_TOKENS } from "../src/core/types.ts";
import type {
  Analysis,
  Basis,
  Capabilities,
  CompactionTransaction,
  Coverage,
  EventIndexEntry,
  Metric,
  SessionMeta,
  Step,
  ToolCallDetail,
  Totals,
  Turn,
} from "../src/core/types.ts";

const BASE = Date.UTC(2026, 0, 2, 3, 4, 5);

function metric(value: number | null, basis: Basis = "measured"): Metric {
  return value === null
    ? { value: null, basis: "unavailable" }
    : { value, basis };
}

function toolFixture(
  name: string,
  overrides: Partial<ToolCallDetail> = {},
): ToolCallDetail {
  return {
    callID: `call_${name}`,
    name,
    status: "completed",
    input: {},
    inputPreview: "{}",
    output: "ok",
    outputPreview: "ok",
    error: null,
    metadata: null,
    createdAt: BASE,
    ranAt: BASE,
    completedAt: BASE + 100,
    duration: metric(100),
    childSessionIDs: [],
    executed: true,
    ...overrides,
  };
}

function stepFixture(index: number, overrides: Partial<Step> = {}): Step {
  return {
    id: `ste_${index}`,
    turnID: "turn_0",
    index,
    trigger: "After tool results",
    startTime: BASE + index * 1_000,
    endTime: BASE + index * 1_000 + 500,
    startUnknown: false,
    agent: "build",
    model: { providerID: "openai", id: "gpt-5" },
    provider: "openai",
    finish: "stop",
    toolNames: [],
    toolCalls: [],
    tokens: { ...EMPTY_TOKENS, input: 100, output: 20 },
    cost: 0.001,
    promptTokens: metric(120),
    cacheHitRate: metric(0.5),
    ttft: metric(null),
    modelTime: metric(400),
    toolTime: metric(0),
    totalTime: metric(500),
    residualTime: metric(100),
    outputSpeed: metric(40),
    status: "completed",
    subagentSessionIDs: [],
    eventIDs: [],
    responseText: "",
    reasoningText: "",
    uncertainty: [],
    ...overrides,
  };
}

function turnFixture(index: number, overrides: Partial<Turn> = {}): Turn {
  const start = BASE + index * 10_000;
  return {
    id: `turn_${index}`,
    index,
    trigger: { kind: "user", eventID: null, label: "User message" },
    startTime: start,
    endTime: start + 5_000,
    status: "completed",
    steps: [stepFixture(0)],
    eventIDs: [],
    nonStepEventIDs: [],
    firstStepStart: start,
    lastStepEnd: start + 5_000,
    tokens: { ...EMPTY_TOKENS, input: 100, output: 20 },
    tokensComplete: true,
    promptTokensLatest: metric(120),
    promptTokensCumulative: metric(120),
    cacheHitRate: metric(0.5),
    contextDelta: metric(10),
    cost: metric(0.001),
    modelTime: metric(400),
    toolTime: metric(0),
    totalTime: metric(500),
    residualTime: metric(100),
    outputSpeed: metric(40),
    uncertainty: [],
    ...overrides,
  };
}

function compactionFixture(
  overrides: Partial<CompactionTransaction> = {},
): CompactionTransaction {
  return {
    eventID: "evt_compaction",
    turnID: null,
    timestamp: BASE + 30_000,
    status: "completed",
    reason: "context limit",
    model: { providerID: "openai", id: "gpt-5" },
    provider: "openai",
    tokens: { ...EMPTY_TOKENS, output: 500 },
    cost: 0.002,
    summaryChars: 1_200,
    summaryPreview: "summary",
    contextBefore: metric(120_000),
    contextAfter: metric(40_000),
    contextDelta: metric(-80_000),
    removedTokens: metric(80_000),
    duration: metric(2_000),
    uncertainty: [],
    ...overrides,
  };
}

function idleErrorEvent(
  id: string,
  status: string,
  timestamp: number,
): EventIndexEntry {
  return {
    id,
    messageID: id,
    sessionID: "ses_digest",
    seq: 1,
    orderKey: "1:0",
    timestamp,
    kind: "idle",
    actor: "session",
    title: "Session idle",
    preview: "",
    agent: null,
    model: null,
    provider: null,
    status,
    toolName: null,
    toolStatus: null,
    tokens: null,
    cost: null,
    stepID: null,
    turnID: null,
    flags: {
      error: true,
      retry: false,
      compaction: false,
      context: false,
      subagent: false,
      approval: false,
      uncertain: false,
    },
    uncertainty: [],
  };
}

function capabilitiesFixture(
  overrides: Partial<Capabilities> = {},
): Capabilities {
  return {
    source: "sqlite",
    ttft: false,
    approvals: false,
    requestHeaders: false,
    toolSetChanges: false,
    tokenUsage: true,
    reasoning: true,
    cacheUsage: true,
    cost: true,
    retries: true,
    compactions: true,
    subagents: true,
    contextNotices: true,
    modelSwitches: true,
    routeChanges: true,
    forkResumeMarkers: true,
    toolDurations: true,
    promptTokenBreakdown: "input + cache read + cache write",
    notes: [],
    ...overrides,
  };
}

function coverageFixture(overrides: Partial<Coverage> = {}): Coverage {
  return {
    fromSeq: 1,
    toSeq: 100,
    minSeq: 1,
    maxSeq: 100,
    complete: true,
    messages: 100,
    windowMessages: 100,
    ...overrides,
  };
}

interface AnalysisOverrides {
  session?: Partial<SessionMeta>;
  turns?: Turn[];
  compactions?: CompactionTransaction[];
  events?: EventIndexEntry[];
  totals?: Partial<Totals>;
  capabilities?: Partial<Capabilities>;
  coverage?: Partial<Coverage>;
  generatedAt?: number;
  redacted?: boolean;
}

function analysisFixture(overrides: AnalysisOverrides = {}): Analysis {
  const session: SessionMeta = {
    id: "ses_digest",
    title: "Digest fixture",
    agent: "build",
    model: { providerID: "openai", id: "gpt-5" },
    time: { created: BASE, updated: BASE + 60_000 },
    outcome: "succeeded",
    ...overrides.session,
  };
  const turns = overrides.turns ?? [turnFixture(0), turnFixture(1)];
  const totals: Totals = {
    scope: "session",
    turns: turns.length,
    steps: turns.reduce((sum, turn) => sum + turn.steps.length, 0),
    toolCalls: 0,
    subagentCalls: 0,
    errors: { total: 0, tool: 0, step: 0, session: 0 },
    retries: 0,
    compactions: overrides.compactions?.length ?? 0,
    tokens: { ...EMPTY_TOKENS, input: 200, output: 40, cacheRead: 50 },
    tokensComplete: true,
    stepTokens: { ...EMPTY_TOKENS, input: 200, output: 40 },
    compactionTokens: { ...EMPTY_TOKENS },
    cacheHitRate: metric(0.5),
    cost: metric(0.01),
    modelTime: metric(1_000),
    toolTime: metric(100),
    activeTurnTime: metric(900),
    wallClockTime: metric(1_000),
    outputSpeed: metric(30),
    finalContext: metric(5_000),
    cumulativePrompt: metric(6_000),
    ...overrides.totals,
  };
  return {
    version: 1,
    session,
    family: { rootID: session.id, parent: null, children: [] },
    capabilities: capabilitiesFixture(overrides.capabilities),
    coverage: coverageFixture(overrides.coverage),
    events: overrides.events ?? [],
    turns,
    compactions: overrides.compactions ?? [],
    totals,
    unattachedEventIDs: [],
    generatedAt: overrides.generatedAt ?? BASE + 60_000,
    redacted: overrides.redacted ?? true,
  };
}

function render(analysis: Analysis, unredacted = false): string {
  return buildSessionDigest({
    session: analysis.session,
    analysis,
    unredacted,
  });
}

test("digest is deterministic and ignores analysis.generatedAt", () => {
  const analysis = analysisFixture({ compactions: [compactionFixture()] });
  const first = render(analysis);
  const second = render(analysis);
  assert.equal(first, second);

  const shifted: Analysis = { ...analysis, generatedAt: analysis.generatedAt + 999_999 };
  assert.equal(render(shifted), first);
  assert.ok(!first.includes("Generated:"));
});

test("renders the documented sections in order", () => {
  const digest = render(analysisFixture());
  const order = [
    "# Session digest —",
    "## Totals",
    "## Errors",
    "## Retries",
    "## Compactions",
    "## Notable tool activity",
    "## Turn summary",
    "Generated by opencode-session-observability",
  ];
  let cursor = -1;
  for (const heading of order) {
    const found = digest.indexOf(heading);
    assert.ok(found > cursor, `${heading} missing or out of order`);
    cursor = found;
  }
});

test("renders metadata, totals and the redacted banner", () => {
  const digest = render(analysisFixture());
  assert.ok(digest.startsWith("# Session digest — Digest fixture"));
  assert.ok(digest.includes("- Session: `ses_digest`"));
  assert.ok(digest.includes("- Agent: `build`"));
  assert.ok(digest.includes("- Model: `openai/gpt-5`"));
  assert.ok(digest.includes("- Created: 2026-01-02T03:04:05.000Z"));
  assert.ok(digest.includes("- Updated: 2026-01-02T03:05:05.000Z"));
  assert.ok(digest.includes("- Outcome: succeeded"));
  assert.ok(digest.includes("- Source: sqlite (full session)"));
  assert.ok(
    digest.includes(
      "> Redacted: credential-shaped values were replaced with [REDACTED].",
    ),
  );
  assert.ok(!digest.includes("UNREDACTED"));

  assert.ok(digest.includes("- Turns: 2"));
  assert.ok(digest.includes("- Steps: 2"));
  assert.ok(digest.includes("- Tool calls: 0"));
  assert.ok(digest.includes("- Subagent calls: 0"));
  assert.ok(digest.includes("- Errors: 0 (tool 0, step 0, session 0)"));
  assert.ok(digest.includes("- Retries: 0"));
  assert.ok(digest.includes("- Compactions: 0"));
  assert.ok(digest.includes("- Input tokens: 200"));
  assert.ok(digest.includes("- Output tokens: 40"));
  assert.ok(digest.includes("- Cache read: 50"));
  assert.ok(digest.includes("- Cache write: 0"));
  assert.ok(digest.includes("- Cache hit rate: 50.0%"));
  assert.ok(digest.includes("- Cost: $0.0100"));
  assert.ok(digest.includes("- Output speed: 30.0 tok/s"));
  assert.ok(digest.includes("- Final context: 5,000"));
  assert.ok(digest.includes("- Cumulative prompt: 6,000"));
  assert.ok(
    digest.includes(
      "| 0 | User message | 1 | — | 100 | 20 | $0.001000 | 500 ms | completed |",
    ),
  );
  assert.ok(digest.endsWith("deterministic digest."));
});

test("renders the recorded-totals note when present", () => {
  const digest = render(
    analysisFixture({
      totals: {
        recorded: {
          tokens: { ...EMPTY_TOKENS, input: 10, output: 2 },
          cost: 0.25,
          note: "OpenCode stored these totals on the session row",
        },
      },
    }),
  );
  assert.ok(digest.includes("- Recorded by OpenCode:"));
  assert.ok(digest.includes("OpenCode stored these totals on the session row"));
  assert.ok(digest.includes("cost $0.2500"));
});

test("renders errors, retries, compactions and tool activity", () => {
  const analysis = analysisFixture({
    turns: [
      turnFixture(0, {
        status: "error",
        steps: [
          stepFixture(0, { status: "error", finish: "tool failed" }),
          stepFixture(1, {
            toolNames: ["read"],
            toolCalls: [
              toolFixture("read", {
                status: "error",
                error: { type: "api", message: "rate limited" },
              }),
            ],
          }),
        ],
      }),
      turnFixture(1, {
        trigger: { kind: "retry", eventID: null, label: "Retry after rate limit" },
      }),
    ],
    compactions: [compactionFixture()],
    totals: {
      turns: 2,
      steps: 3,
      toolCalls: 1,
      retries: 1,
      compactions: 1,
      errors: { total: 2, tool: 1, step: 1, session: 0 },
    },
  });
  const digest = render(analysis);
  assert.ok(digest.includes("- Turn 0.0 — step error: tool failed"));
  assert.ok(digest.includes("- Turn 0.1 tool read — api: rate limited"));
  assert.ok(digest.includes("Retries recorded in totals: 1."));
  assert.ok(digest.includes("- Turn 1 — Retry after rate limit"));
  assert.ok(digest.includes("context 120,000 → 40,000"));
  assert.ok(digest.includes("removed 80,000 tokens"));
  assert.ok(digest.includes("summary 1,200 chars"));
  assert.ok(digest.includes("### Tools"));
  assert.ok(digest.includes("| read | 1 | 1 | 100 ms |"));
  assert.ok(digest.includes("### Expensive steps"));
  assert.ok(digest.includes("| 0.0 | — | $0.001000 | 500 ms |"));
});

test("renders session-level errors from failed idle events", () => {
  const analysis = analysisFixture({
    events: [idleErrorEvent("evt_idle", "failed", BASE + 5_000)],
    totals: { errors: { total: 1, tool: 0, step: 0, session: 1 } },
  });
  const digest = render(analysis);
  assert.ok(digest.includes("- Errors: 1 (tool 0, step 0, session 1)"));
  assert.ok(digest.includes("- Session — failed at 2026-01-02T03:04:10.000Z"));
  assert.ok(!digest.includes("- Session — succeeded"));
  assert.equal(render(analysis), digest);
});

test("session-level errors count toward the 20-entry error cap", () => {
  const turns = Array.from({ length: 25 }, (_, index) =>
    turnFixture(index, {
      steps: [
        stepFixture(0, {
          toolNames: ["read"],
          toolCalls: [
            toolFixture("read", {
              status: "error",
              error: { type: "api", message: "rate limited" },
            }),
          ],
        }),
      ],
    }),
  );
  const digest = render(
    analysisFixture({
      turns,
      events: [
        idleErrorEvent("evt_idle_1", "failed", BASE + 1_000),
        idleErrorEvent("evt_idle_2", "interrupted", BASE + 2_000),
      ],
    }),
  );
  assert.ok(digest.includes("[truncated: 7 of 27 errors omitted]"));
});

test("unredacted input switches the banner", () => {
  const analysis = analysisFixture();
  const unredacted = render(analysis, true);
  assert.ok(unredacted.includes("> UNREDACTED: generated with reveal active"));
  assert.ok(unredacted.includes("contains unredacted secrets"));
  assert.ok(!unredacted.includes("> Redacted:"));

  const redacted = render(analysis, false);
  assert.ok(redacted.includes("> Redacted:"));
  assert.ok(!redacted.includes("UNREDACTED"));
});

test("empty session renders a valid digest", () => {
  const analysis = analysisFixture({
    turns: [],
    compactions: [],
    totals: {
      turns: 0,
      steps: 0,
      toolCalls: 0,
      subagentCalls: 0,
      retries: 0,
      compactions: 0,
      cost: metric(null),
      cacheHitRate: metric(null),
      finalContext: metric(null),
      cumulativePrompt: metric(null),
    },
  });
  const digest = render(analysis);
  assert.ok(digest.startsWith("# Session digest —"));
  assert.ok(digest.includes("## Totals"));
  assert.ok(digest.includes("- Turns: 0"));
  assert.ok(digest.includes("## Errors"));
  assert.ok(digest.includes("None recorded."));
  assert.ok(digest.includes("## Turn summary"));
  assert.ok(digest.includes("- Cost: —"));
  assert.ok(digest.endsWith("deterministic digest."));
  assert.ok(digest.length < DIGEST_MAX_CHARS);
});

test("oversized session keeps error turns and marks turn truncation", () => {
  const turns: Turn[] = [];
  for (let index = 0; index < 300; index += 1) {
    turns.push(
      turnFixture(index, {
        status: index === 0 ? "error" : "completed",
        steps: [stepFixture(0, { cost: 0, totalTime: metric(0) })],
      }),
    );
  }
  const digest = render(analysisFixture({ turns }));
  assert.ok(digest.length <= DIGEST_MAX_CHARS);
  assert.ok(digest.includes("[truncated: 274 of 300 turns omitted]"));
  assert.ok(digest.includes("| 0 |"));
  assert.ok(!digest.includes("| 200 |"));
  const errorTurn = digest.indexOf("| 0 |");
  const recentTurn = digest.indexOf("| 285 |");
  assert.ok(errorTurn >= 0 && errorTurn < recentTurn);
});

test("hard cap trims on a line boundary and keeps the footer", () => {
  const turns: Turn[] = [];
  for (let index = 0; index < 300; index += 1) {
    turns.push(
      turnFixture(index, {
        status: "error",
        steps: [stepFixture(0, { status: "error", finish: `failure ${index}` })],
      }),
    );
  }
  const digest = render(analysisFixture({ turns }));
  assert.ok(digest.length <= DIGEST_MAX_CHARS);
  assert.ok(digest.includes("[digest truncated:"));
  assert.ok(digest.includes("chars omitted]"));
  assert.ok(digest.includes("Generated by opencode-session-observability"));
  assert.ok(digest.endsWith("deterministic digest."));
  assert.ok(!digest.includes("\r"));
});

test("review prompt is the instructions prefix followed by the digest", () => {
  const digest = render(analysisFixture());
  const prompt = buildReviewPrompt(digest, { unredacted: false });
  assert.ok(
    prompt.startsWith(
      "You are reviewing an OpenCode coding-agent session from its observability data.",
    ),
  );
  assert.ok(prompt.includes("Return this structure:"));
  assert.ok(
    prompt.includes("- Verdict: effective / partially effective / ineffective"),
  );
  assert.ok(prompt.includes(`SESSION DIGEST:\n${digest}`));
  assert.ok(prompt.endsWith(digest));
  assert.ok(!prompt.includes("UNREDACTED"));
});

test("review prompt prepends the UNREDACTED warning only when unredacted", () => {
  const digest = render(analysisFixture());
  const unredacted = buildReviewPrompt(digest, { unredacted: true });
  assert.ok(
    unredacted.startsWith(
      "> UNREDACTED: generated with reveal active — contains unredacted secrets. Share only with tools you trust.\n\nYou are reviewing an OpenCode coding-agent session",
    ),
  );
  assert.ok(unredacted.endsWith(digest));

  const redacted = buildReviewPrompt(digest, { unredacted: false });
  assert.ok(!redacted.startsWith(">"));
  assert.ok(
    redacted.startsWith(
      "You are reviewing an OpenCode coding-agent session from its observability data.",
    ),
  );
});

test("review prompt instructions are verbatim and byte-stable", async () => {
  const lines = REVIEW_PROMPT_INSTRUCTIONS.split("\n");
  assert.equal(lines.length, 26);
  assert.equal(
    lines[0],
    "You are reviewing an OpenCode coding-agent session from its observability data.",
  );
  assert.equal(lines[5], "   or uncertain work.");
  assert.equal(lines[25], "SESSION DIGEST:");
  assert.ok(
    REVIEW_PROMPT_INSTRUCTIONS.includes(
      "Be concise and evidence-based. Refer to turn numbers and tool names where possible.",
    ),
  );
  assert.ok(!REVIEW_PROMPT_INSTRUCTIONS.includes("\r"));
  assert.ok(!REVIEW_PROMPT_INSTRUCTIONS.endsWith("\n"));

  const reloaded = await import("../src/core/digest.ts");
  assert.equal(reloaded.REVIEW_PROMPT_INSTRUCTIONS, REVIEW_PROMPT_INSTRUCTIONS);
});
