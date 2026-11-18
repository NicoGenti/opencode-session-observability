import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "../src/core/service.ts";
import {
  HEALTH_RULES,
  MAX_EVENT_LINKS,
  MAX_TURN_LINKS,
  evaluateSessionHealth,
} from "../src/core/health.ts";
import type {
  HealthRuleId,
  HealthRuleResult,
  HealthThresholds,
  SessionHealth,
} from "../src/core/health.ts";
import { metric } from "../src/core/types.ts";
import type {
  Analysis,
  RawMessage,
  SessionMeta,
  TokenUsage,
} from "../src/core/types.ts";
import {
  BASE,
  assistant,
  compaction,
  fixture,
  idle,
  memorySource,
  session,
  toolBlock,
  user,
} from "./fixtures/build.ts";

const ID = "ses_health";

/** Prompt size 1,000 with a 0.90 cache hit rate. */
const HIGH_CACHE: TokenUsage = {
  input: 100,
  output: 20,
  reasoning: 0,
  cacheRead: 900,
  cacheWrite: 0,
};

/** Prompt size 1,000 with a 0.00 cache hit rate. */
const LOW_CACHE: TokenUsage = {
  input: 1_000,
  output: 20,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function usage(options: {
  input?: number;
  cacheRead?: number;
  output?: number;
} = {}): TokenUsage {
  return {
    input: options.input ?? 0,
    output: options.output ?? 20,
    reasoning: 0,
    cacheRead: options.cacheRead ?? 0,
    cacheWrite: 0,
  };
}

/** Builds one session's messages in recorded order with unique ids. */
class Script {
  private readonly messages: RawMessage[] = [];
  private seq = 0;
  private at = BASE;

  private tick(): { seq: number; at: number } {
    this.seq += 1;
    this.at += 1_000;
    return { seq: this.seq, at: this.at };
  }

  prompt(text = "Hello"): this {
    const slot = this.tick();
    this.messages.push(user(`msg_${slot.seq}`, slot.seq, slot.at, text));
    return this;
  }

  assistant(
    options: {
      tokens?: TokenUsage | null;
      cost?: number | null;
      retry?: boolean;
      error?: boolean;
      tool?: "error" | "completed";
      toolName?: string;
      content?: unknown[];
    } = {},
  ): this {
    const slot = this.tick();
    const blocks: unknown[] = options.content === undefined ? [] : [...options.content];
    if (options.tool !== undefined) {
      blocks.push(
        toolBlock({
          callID: `call_${slot.seq}`,
          name: options.toolName ?? "read",
          created: slot.at + 10,
          ran: slot.at + 20,
          completed: slot.at + 30,
          status: options.tool === "error" ? "error" : "completed",
          input: { path: "src/a.ts", apiKey: "sk-live-secret" },
          output: options.tool === "error" ? "" : "ok",
          error:
            options.tool === "error"
              ? { type: "tool-error", message: "tool failed" }
              : undefined,
        }),
      );
    }
    this.messages.push(
      assistant({
        id: `msg_${slot.seq}`,
        seq: slot.seq,
        created: slot.at,
        streamed: slot.at + 400,
        completed: slot.at + 500,
        content: blocks.length > 0 ? blocks : undefined,
        tokens: options.tokens === undefined ? HIGH_CACHE : options.tokens,
        cost: options.cost === undefined ? 0.01 : options.cost,
        retry: options.retry
          ? {
              attempt: 1,
              at: slot.at + 600,
              error: { message: "retry" },
            }
          : undefined,
        error: options.error
          ? { type: "step-error", message: "step failed" }
          : undefined,
      }),
    );
    return this;
  }

  idle(outcome: "succeeded" | "failed" | "interrupted" = "succeeded"): this {
    const slot = this.tick();
    this.messages.push(idle(`msg_${slot.seq}`, slot.seq, slot.at, outcome));
    return this;
  }

  compaction(options: { cost?: number } = {}): this {
    const slot = this.tick();
    this.messages.push(compaction(`msg_${slot.seq}`, slot.seq, slot.at, options));
    return this;
  }

  end(): RawMessage[] {
    return this.messages;
  }
}

type Build = (script: Script) => Script;

function empty(): Build {
  return (script) => script;
}

function serviceFor(
  build: Build,
  overrides: Partial<SessionMeta> = {},
): ObservabilityService {
  return new ObservabilityService(
    memorySource(
      fixture([
        {
          meta: session(ID, overrides),
          messages: build(new Script()).end(),
        },
      ]),
    ),
  );
}

async function analyzeBuild(
  build: Build,
  overrides: Partial<SessionMeta> = {},
): Promise<{ service: ObservabilityService; analysis: Analysis }> {
  const service = serviceFor(build, overrides);
  const { analysis } = await service.analyze(ID, { reveal: true });
  return { service, analysis };
}

async function healthFor(
  build: Build,
  overrides: Partial<SessionMeta> = {},
): Promise<SessionHealth> {
  const { analysis } = await analyzeBuild(build, overrides);
  assert.ok(analysis.health, "the service must attach analysis.health");
  return analysis.health;
}

function ruleFor(health: SessionHealth, id: HealthRuleId): HealthRuleResult {
  const found = health.rules.find((item) => item.id === id);
  assert.ok(found, `rule ${id} must be reported`);
  return found;
}

/** One turn holding `total` steps, the first `errors` of which failed. */
function errorSteps(total: number, errors: number): Build {
  return (script) => {
    script.prompt();
    for (let index = 0; index < total; index += 1) {
      script.assistant({ error: index < errors });
    }
    script.idle();
    return script;
  };
}

function retryTurns(count: number, tokens: TokenUsage = HIGH_CACHE): Build {
  return (script) => {
    for (let index = 0; index < count; index += 1) {
      script.prompt();
      script.assistant({ retry: true, tokens });
      script.idle();
    }
    return script;
  };
}

/** One turn per element; a `"error"` element records a failing tool call. */
function toolTurns(tools: Array<"error" | "completed">): Build {
  return (script) => {
    for (const tool of tools) {
      script.prompt();
      script.assistant({ tool });
      script.idle();
    }
    return script;
  };
}

function costTurns(costs: Array<number | null>): Build {
  return (script) => {
    for (const cost of costs) {
      script.prompt();
      script.assistant({ cost });
      script.idle();
    }
    return script;
  };
}

/** Turns whose prompt size grows linearly up to `finalContext`. */
function growth(
  count: number,
  finalContext: number,
  compactionAfter?: number,
): Build {
  return (script) => {
    for (let index = 0; index < count; index += 1) {
      const prompt =
        count === 1
          ? finalContext
          : Math.round(
              finalContext * (0.5 + (0.5 * index) / (count - 1)),
            );
      const input = Math.round(prompt * 0.2);
      script.prompt();
      script.assistant({
        tokens: usage({ input, cacheRead: prompt - input }),
      });
      if (compactionAfter === index + 1) script.compaction();
      script.idle();
    }
    return script;
  };
}

/** `low` cold turns followed by `high` warm turns, flat across turns. */
function cacheTurns(low: number, high: number, retry = false): Build {
  return (script) => {
    for (let index = 0; index < low + high; index += 1) {
      script.prompt();
      script.assistant({
        tokens: index < low ? LOW_CACHE : HIGH_CACHE,
        retry,
      });
      script.idle();
    }
    return script;
  };
}

// --- thresholds -----------------------------------------------------------

test("exports frozen threshold constants with the agreed caps", () => {
  assert.ok(Object.isFrozen(HEALTH_RULES));
  for (const section of Object.values(HEALTH_RULES)) {
    if (typeof section === "object") assert.ok(Object.isFrozen(section));
  }
  assert.equal(HEALTH_RULES.errorRate.watchRate, 0.25);
  assert.equal(HEALTH_RULES.errorRate.watchErrors, 4);
  assert.equal(HEALTH_RULES.errorRate.strongRate, 0.6);
  assert.equal(HEALTH_RULES.errorRate.strongErrors, 6);
  assert.equal(HEALTH_RULES.retryCount.watch, 8);
  assert.equal(HEALTH_RULES.retryCount.strong, 15);
  assert.equal(HEALTH_RULES.toolFailureRecurrence.watchIncidents, 4);
  assert.equal(HEALTH_RULES.toolFailureRecurrence.strongIncidents, 7);
  assert.equal(HEALTH_RULES.contextGrowth.watchRun, 5);
  assert.equal(HEALTH_RULES.contextGrowth.strongRun, 8);
  assert.equal(HEALTH_RULES.contextGrowth.watchFinalContext, 150_000);
  assert.equal(HEALTH_RULES.contextGrowth.strongFinalContext, 250_000);
  assert.equal(HEALTH_RULES.costPerTurn.watch, 2);
  assert.equal(HEALTH_RULES.costPerTurn.strong, 10);
  assert.equal(HEALTH_RULES.lowCacheHit.lowBelow, 0.2);
  assert.equal(HEALTH_RULES.lowCacheHit.watchShare, 0.6);
  assert.equal(HEALTH_RULES.lowCacheHit.strongShare, 0.8);
  assert.equal(MAX_EVENT_LINKS, 10);
  assert.equal(MAX_TURN_LINKS, 6);
  assert.equal(HEALTH_RULES.maxEventLinks, MAX_EVENT_LINKS);
  assert.equal(HEALTH_RULES.maxTurnLinks, MAX_TURN_LINKS);
});

test("reports every rule in a documented order", async () => {
  const health = await healthFor(empty());
  assert.deepEqual(
    health.rules.map((item) => item.id),
    [
      "error-rate",
      "retry-count",
      "tool-failure-recurrence",
      "context-growth",
      "cost-per-turn",
      "low-cache-hit",
      "unfinished-outcome",
    ],
  );
});

// --- parameterization -----------------------------------------------------

test("the default thresholds are the frozen rules", async () => {
  const { analysis } = await analyzeBuild(retryTurns(8));
  assert.deepEqual(
    evaluateSessionHealth(analysis),
    evaluateSessionHealth(analysis, HEALTH_RULES),
  );
});

test("injected thresholds change a verdict without touching the defaults", async () => {
  // Five retries stay quiet under the approved default of 8.
  const { analysis } = await analyzeBuild(retryTurns(5));
  assert.equal(
    ruleFor(evaluateSessionHealth(analysis), "retry-count").level,
    null,
  );

  const lowered: HealthThresholds = {
    ...HEALTH_RULES,
    retryCount: { watch: 5, strong: 12 },
  };
  const injected = evaluateSessionHealth(analysis, lowered);
  assert.equal(ruleFor(injected, "retry-count").level, "watch");
  assert.equal(injected.state, "watch");
  assert.equal(injected.triggeredCount, 1);

  // The frozen object is untouched and the default call is unchanged.
  assert.equal(HEALTH_RULES.retryCount.watch, 8);
  assert.equal(HEALTH_RULES.retryCount.strong, 15);
  assert.equal(
    ruleFor(evaluateSessionHealth(analysis), "retry-count").level,
    null,
  );
});

test("each rule reads its own bucket of the injected thresholds", async () => {
  // A 0.25 error rate with 5 errors is a default watch trigger.
  const { analysis } = await analyzeBuild(errorSteps(20, 5));
  assert.equal(
    ruleFor(evaluateSessionHealth(analysis), "error-rate").level,
    "watch",
  );

  const raised = evaluateSessionHealth(analysis, {
    ...HEALTH_RULES,
    errorRate: {
      watchRate: 0.5,
      watchErrors: 4,
      strongRate: 0.9,
      strongErrors: 6,
    },
  });
  assert.equal(ruleFor(raised, "error-rate").level, null);
  // Raising one bucket leaves the other rules at their approved thresholds.
  assert.equal(
    ruleFor(raised, "tool-failure-recurrence").note,
    "0 incident(s) recorded; max 0 attempt(s) in one run",
  );
});

test("injected link caps bound the returned evidence lists", async () => {
  const { analysis } = await analyzeBuild(retryTurns(9));
  const capped = evaluateSessionHealth(analysis, {
    ...HEALTH_RULES,
    maxEventLinks: 3,
    maxTurnLinks: 1,
  });
  assert.equal(ruleFor(capped, "retry-count").eventIDs.length, 3);
  assert.equal(
    ruleFor(evaluateSessionHealth(analysis), "retry-count").eventIDs.length,
    9,
  );
});

test("the sufficiency gate ignores injected thresholds", async () => {
  const { analysis } = await analyzeBuild(empty());
  const injected = evaluateSessionHealth(analysis, {
    ...HEALTH_RULES,
    retryCount: { watch: 1, strong: 2 },
  });
  assert.equal(injected.insufficient, true);
  assert.equal(injected.state, "watch");
  assert.deepEqual(injected.insufficientReasons, [
    "no turns were recorded",
    "neither token usage nor cost was recorded",
  ]);
});

// --- error-rate -----------------------------------------------------------

test("error-rate triggers watch at exactly 0.25 with 4 errors", async () => {
  const health = await healthFor(errorSteps(16, 4));
  const rule = ruleFor(health, "error-rate");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.triggered, true);
  assert.equal(rule.level, "watch");
  assert.equal(rule.note, "4 error(s) across 16 step(s); rate 0.25");
  assert.ok(rule.eventIDs.length > 0);
});

test("error-rate stays untriggered one step below the watch rate", async () => {
  const health = await healthFor(errorSteps(17, 4));
  const rule = ruleFor(health, "error-rate");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.triggered, false);
  assert.equal(rule.level, null);
});

test("error-rate triggers strong at exactly 0.60 with 6 errors", async () => {
  const health = await healthFor(errorSteps(10, 6));
  const rule = ruleFor(health, "error-rate");
  assert.equal(rule.level, "strong");
  assert.equal(rule.note, "6 error(s) across 10 step(s); rate 0.60");
});

test("error-rate stays watch one error below the strong count", async () => {
  const health = await healthFor(errorSteps(6, 4));
  const rule = ruleFor(health, "error-rate");
  assert.equal(rule.level, "watch");
});

test("error-rate is not evaluable without steps", async () => {
  const health = await healthFor(empty());
  const rule = ruleFor(health, "error-rate");
  assert.equal(rule.evaluable, false);
  assert.equal(rule.triggered, false);
  assert.equal(rule.note, "no steps were recorded");
});

// --- retry-count ----------------------------------------------------------

test("retry-count triggers watch at exactly 8 retries", async () => {
  const health = await healthFor(retryTurns(8));
  const rule = ruleFor(health, "retry-count");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.level, "watch");
  assert.equal(rule.note, "8 retry event(s) recorded");
  assert.equal(rule.eventIDs.length, 8);
});

test("retry-count stays untriggered at 7 retries", async () => {
  const health = await healthFor(retryTurns(7));
  const rule = ruleFor(health, "retry-count");
  assert.equal(rule.triggered, false);
  assert.equal(rule.level, null);
});

test("retry-count triggers strong at exactly 15 retries", async () => {
  const health = await healthFor(retryTurns(15));
  const rule = ruleFor(health, "retry-count");
  assert.equal(rule.level, "strong");
  assert.equal(rule.eventIDs.length, MAX_EVENT_LINKS);
});

test("retry-count stays watch at 14 retries", async () => {
  const health = await healthFor(retryTurns(14));
  assert.equal(ruleFor(health, "retry-count").level, "watch");
});

// --- tool-failure-recurrence ---------------------------------------------

test("tool-failure-recurrence triggers watch at exactly 4 incidents", async () => {
  const health = await healthFor(
    toolTurns(["error", "error", "error", "error"]),
  );
  const rule = ruleFor(health, "tool-failure-recurrence");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.level, "watch");
  assert.equal(rule.note, "4 incident(s) recorded; max 1 attempt(s) in one run");
  assert.equal(rule.eventIDs.length, 4);
});

test("tool-failure-recurrence stays untriggered at 3 incidents", async () => {
  const health = await healthFor(toolTurns(["error", "error", "error"]));
  assert.equal(ruleFor(health, "tool-failure-recurrence").triggered, false);
});

test("tool-failure-recurrence triggers watch at exactly 5 attempts", async () => {
  const build: Build = (script) => {
    script.prompt();
    for (let index = 0; index < 5; index += 1) {
      script.assistant({ tool: "error" });
    }
    script.idle();
    return script;
  };
  const rule = ruleFor(
    await healthFor(build),
    "tool-failure-recurrence",
  );
  assert.equal(rule.level, "watch");
  assert.equal(rule.note, "1 incident(s) recorded; max 5 attempt(s) in one run");
});

test("tool-failure-recurrence stays untriggered at 4 attempts", async () => {
  const build: Build = (script) => {
    script.prompt();
    for (let index = 0; index < 4; index += 1) {
      script.assistant({ tool: "error" });
    }
    script.idle();
    return script;
  };
  assert.equal(
    ruleFor(await healthFor(build), "tool-failure-recurrence").triggered,
    false,
  );
});

test("tool-failure-recurrence triggers strong at exactly 7 incidents", async () => {
  const health = await healthFor(toolTurns(new Array<"error">(7).fill("error")));
  assert.equal(ruleFor(health, "tool-failure-recurrence").level, "strong");
});

test("tool-failure-recurrence triggers strong at exactly 9 attempts", async () => {
  const build: Build = (script) => {
    script.prompt();
    for (let index = 0; index < 9; index += 1) {
      script.assistant({ tool: "error" });
    }
    script.idle();
    return script;
  };
  assert.equal(
    ruleFor(await healthFor(build), "tool-failure-recurrence").level,
    "strong",
  );
});

test("tool-failure-recurrence is evaluable without diagnostics", async () => {
  const health = await healthFor(costTurns([0.01, 0.01]));
  const rule = ruleFor(health, "tool-failure-recurrence");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.triggered, false);
  assert.equal(rule.note, "0 incident(s) recorded; max 0 attempt(s) in one run");
});

// --- context-growth -------------------------------------------------------

test("context-growth triggers watch at a run of exactly 5 turns", async () => {
  const health = await healthFor(growth(6, 150_000));
  const rule = ruleFor(health, "context-growth");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.level, "watch");
  assert.equal(
    rule.note,
    "longest growth run 5 turn(s); final context 150000",
  );
  assert.equal(rule.turnIDs.length, 2);
});

test("context-growth stays untriggered at a run of 4 turns", async () => {
  const health = await healthFor(growth(5, 150_000));
  const rule = ruleFor(health, "context-growth");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.triggered, false);
  assert.equal(rule.note, "longest growth run 4 turn(s); final context 150000");
});

test("context-growth stays untriggered below 150k final context", async () => {
  const health = await healthFor(growth(6, 149_999));
  assert.equal(ruleFor(health, "context-growth").triggered, false);
});

test("context-growth triggers strong at a run of exactly 8 turns", async () => {
  const health = await healthFor(growth(9, 250_000));
  const rule = ruleFor(health, "context-growth");
  assert.equal(rule.level, "strong");
  assert.equal(
    rule.note,
    "longest growth run 8 turn(s); final context 250000",
  );
});

test("context-growth stays watch at a run of 7 turns with 250k context", async () => {
  const health = await healthFor(growth(8, 250_000));
  assert.equal(ruleFor(health, "context-growth").level, "watch");
});

test("context-growth is not evaluable with fewer than 2 deltas", async () => {
  const health = await healthFor(growth(1, 150_000));
  const rule = ruleFor(health, "context-growth");
  assert.equal(rule.evaluable, false);
  assert.equal(rule.triggered, false);
  assert.match(rule.note, /at least 2 are required/);
});

test("context-growth is not evaluable when final context is unavailable", async () => {
  const { analysis } = await analyzeBuild(growth(6, 150_000));
  const patched: Analysis = {
    ...analysis,
    totals: {
      ...analysis.totals,
      finalContext: metric(null, "unavailable", "no step token usage"),
    },
  };
  const rule = ruleFor(evaluateSessionHealth(patched), "context-growth");
  assert.equal(rule.evaluable, false);
  assert.equal(rule.note, "final context size was not recorded");
});

test("a compaction inside the run ends it", async () => {
  const health = await healthFor(growth(6, 150_000, 3));
  const rule = ruleFor(health, "context-growth");
  assert.equal(
    rule.note,
    "longest growth run 3 turn(s); final context 150000",
  );
});

// --- cost-per-turn --------------------------------------------------------

test("cost-per-turn triggers watch at exactly $2.00 per turn", async () => {
  const health = await healthFor(costTurns([2, 2]));
  const rule = ruleFor(health, "cost-per-turn");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.level, "watch");
  assert.equal(rule.note, "$2.00 per turn across 2 turn(s)");
});

test("cost-per-turn stays untriggered below $2.00 per turn", async () => {
  const health = await healthFor(costTurns([1.99, 1.99]));
  assert.equal(ruleFor(health, "cost-per-turn").triggered, false);
});

test("cost-per-turn triggers strong at exactly $10.00 per turn", async () => {
  const health = await healthFor(costTurns([10, 10]));
  assert.equal(ruleFor(health, "cost-per-turn").level, "strong");
});

test("cost-per-turn stays watch below $10.00 per turn", async () => {
  const health = await healthFor(costTurns([9.99, 9.99]));
  assert.equal(ruleFor(health, "cost-per-turn").level, "watch");
});

test("cost-per-turn is not evaluable below 2 turns", async () => {
  const health = await healthFor(costTurns([5]));
  const rule = ruleFor(health, "cost-per-turn");
  assert.equal(rule.evaluable, false);
  assert.equal(rule.note, "1 turn(s) recorded; at least 2 are required");
});

test("cost-per-turn is not evaluable when cost was not recorded", async () => {
  const health = await healthFor(costTurns([null]));
  const rule = ruleFor(health, "cost-per-turn");
  assert.equal(rule.evaluable, false);
  assert.equal(rule.note, "cost was not recorded");
});

test("cost-per-turn links the three costliest turns", async () => {
  const health = await healthFor(costTurns([0.5, 12, 3, 20]));
  const rule = ruleFor(health, "cost-per-turn");
  assert.equal(rule.turnIDs.length, 3);
  assert.deepEqual(rule.turnIDs, [`${ID}:t4`, `${ID}:t2`, `${ID}:t3`]);
});

// --- low-cache-hit --------------------------------------------------------

test("low-cache-hit triggers watch at a share of exactly 0.60", async () => {
  const health = await healthFor(cacheTurns(6, 4));
  const rule = ruleFor(health, "low-cache-hit");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.level, "watch");
  assert.equal(rule.note, "6 of 10 turn(s) below a 0.20 cache hit rate");
  assert.equal(rule.turnIDs.length, 6);
});

test("low-cache-hit stays untriggered below the watch share", async () => {
  const health = await healthFor(cacheTurns(6, 5));
  assert.equal(ruleFor(health, "low-cache-hit").triggered, false);
});

test("low-cache-hit stays untriggered below 5 low turns", async () => {
  const health = await healthFor(cacheTurns(4, 1));
  const rule = ruleFor(health, "low-cache-hit");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.triggered, false);
});

test("low-cache-hit triggers strong at a share of exactly 0.80", async () => {
  const health = await healthFor(cacheTurns(12, 3));
  const rule = ruleFor(health, "low-cache-hit");
  assert.equal(rule.level, "strong");
  assert.equal(rule.note, "12 of 15 turn(s) below a 0.20 cache hit rate");
});

test("low-cache-hit stays watch below the strong share", async () => {
  const health = await healthFor(cacheTurns(9, 3));
  assert.equal(ruleFor(health, "low-cache-hit").level, "watch");
});

test("low-cache-hit is not evaluable without a recorded rate", async () => {
  const build: Build = (script) => {
    for (let index = 0; index < 2; index += 1) {
      script.prompt();
      script.assistant({ tokens: usage({}) });
      script.idle();
    }
    return script;
  };
  const rule = ruleFor(await healthFor(build), "low-cache-hit");
  assert.equal(rule.evaluable, false);
  assert.equal(rule.note, "no turn recorded a cache hit rate");
});

// --- unfinished-outcome ---------------------------------------------------

test("unfinished-outcome triggers watch for an interrupted session", async () => {
  const health = await healthFor(costTurns([0.01, 0.01]), {
    outcome: "interrupted",
  });
  const rule = ruleFor(health, "unfinished-outcome");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.level, "watch");
  assert.equal(
    rule.note,
    "session outcome: interrupted; last turn status: completed",
  );
});

test("unfinished-outcome triggers watch for an interrupted last turn", async () => {
  const build: Build = (script) => {
    script.prompt();
    script.assistant();
    script.idle();
    script.prompt();
    script.assistant();
    script.idle("interrupted");
    return script;
  };
  const rule = ruleFor(await healthFor(build), "unfinished-outcome");
  assert.equal(rule.level, "watch");
  assert.equal(rule.note, "session outcome: succeeded; last turn status: interrupted");
});

test("unfinished-outcome triggers strong for a failed session", async () => {
  const health = await healthFor(costTurns([0.01, 0.01]), { outcome: "failed" });
  const rule = ruleFor(health, "unfinished-outcome");
  assert.equal(rule.level, "strong");
  assert.equal(rule.note, "session outcome: failed; last turn status: completed");
});

test("unfinished-outcome triggers strong for an erroring last turn", async () => {
  const build: Build = (script) => {
    script.prompt();
    script.assistant();
    script.idle("failed");
    return script;
  };
  const rule = ruleFor(await healthFor(build), "unfinished-outcome");
  assert.equal(rule.level, "strong");
  assert.equal(rule.note, "session outcome: succeeded; last turn status: error");
});

test("unfinished-outcome never triggers for a running session", async () => {
  const build: Build = (script) => {
    script.prompt();
    script.assistant();
    return script;
  };
  const health = await healthFor(build, {
    time: {
      created: BASE,
      updated: BASE + 60_000,
      busy: BASE + 60_000,
      idle: BASE + 1_000,
    },
  });
  const rule = ruleFor(health, "unfinished-outcome");
  assert.equal(rule.evaluable, true);
  assert.equal(rule.triggered, false);
  assert.match(rule.note, /last turn status: running/);
});

// --- state mapping --------------------------------------------------------

test("no triggered rules map to healthy", async () => {
  const health = await healthFor(costTurns([0.01, 0.01]));
  assert.equal(health.state, "healthy");
  assert.equal(health.insufficient, false);
  assert.equal(health.triggeredCount, 0);
  assert.deepEqual(health.insufficientReasons, []);
});

test("one watch rule maps to watch", async () => {
  const health = await healthFor(retryTurns(8));
  assert.equal(health.triggeredCount, 1);
  assert.equal(health.state, "watch");
});

test("two watch rules map to degraded", async () => {
  const health = await healthFor(cacheTurns(5, 3, true));
  assert.equal(ruleFor(health, "retry-count").level, "watch");
  assert.equal(ruleFor(health, "low-cache-hit").level, "watch");
  assert.equal(health.triggeredCount, 2);
  assert.equal(health.state, "degraded");
});

test("one strong rule maps to degraded", async () => {
  const health = await healthFor(retryTurns(15));
  assert.equal(ruleFor(health, "retry-count").level, "strong");
  assert.equal(health.triggeredCount, 1);
  assert.equal(health.state, "degraded");
});

test("insufficient data plus strong evidence maps to degraded", async () => {
  const { analysis } = await analyzeBuild(retryTurns(15));
  const patched: Analysis = {
    ...analysis,
    coverage: { ...analysis.coverage, complete: false },
  };
  const health = evaluateSessionHealth(patched);
  assert.equal(health.insufficient, true);
  assert.equal(health.state, "degraded");
});

test("insufficient data without evidence maps to watch", async () => {
  const health = await healthFor(empty());
  assert.equal(health.insufficient, true);
  assert.equal(health.triggeredCount, 0);
  assert.equal(health.state, "watch");
});

// --- sufficiency gate -----------------------------------------------------

test("an empty session is insufficient and never healthy", async () => {
  const service = serviceFor(empty());
  const { analysis } = await service.analyze(ID);
  assert.ok(analysis.health);
  assert.equal(analysis.totals.turns, 0);
  assert.equal(analysis.health.state, "watch");
  assert.equal(analysis.health.insufficient, true);
  assert.deepEqual(analysis.health.insufficientReasons, [
    "no turns were recorded",
    "neither token usage nor cost was recorded",
  ]);
});

test("a windowed analysis is insufficient", async () => {
  const { analysis } = await analyzeBuild(costTurns([0.01, 0.01]));
  const patched: Analysis = {
    ...analysis,
    coverage: { ...analysis.coverage, complete: false },
  };
  const health = evaluateSessionHealth(patched);
  assert.equal(health.insufficient, true);
  assert.equal(health.state, "watch");
  assert.deepEqual(health.insufficientReasons, [
    "the analysis covers a window, not the full session",
  ]);
});

test("missing token usage and cost are insufficient", async () => {
  const build: Build = (script) => {
    script.prompt();
    script.assistant({ tokens: null, cost: null });
    script.idle();
    return script;
  };
  const health = await healthFor(build);
  assert.equal(health.insufficient, true);
  assert.equal(health.state, "watch");
  assert.deepEqual(health.insufficientReasons, [
    "neither token usage nor cost was recorded",
  ]);
});

test("missing token usage with recorded cost stays sufficient", async () => {
  const build: Build = (script) => {
    script.prompt();
    script.assistant({ tokens: null, cost: 0.1 });
    script.idle();
    script.prompt();
    script.assistant({ tokens: null, cost: 0.1 });
    script.idle();
    return script;
  };
  const health = await healthFor(build);
  assert.equal(health.insufficient, false);
  assert.deepEqual(health.insufficientReasons, []);
  assert.equal(health.state, "healthy");
});

// --- service wiring -------------------------------------------------------

test("the service attaches health even when diagnostics are absent", async () => {
  const { analysis } = await analyzeBuild(costTurns([0.01, 0.01]));
  assert.equal(analysis.diagnostics, undefined);
  assert.ok(analysis.health);
  assert.equal(analysis.health.rules.length, 7);
});

test("health is deterministic across repeated evaluations", async () => {
  const { analysis } = await analyzeBuild(cacheTurns(6, 4, true));
  const first = evaluateSessionHealth(analysis);
  const second = evaluateSessionHealth(analysis);
  assert.deepEqual(second, first);
});

test("a warm cached analysis returns the same health object", async () => {
  const service = serviceFor(cacheTurns(6, 4, true));
  const first = await service.analyze(ID, { reveal: true });
  const second = await service.analyze(ID, { reveal: true });
  assert.deepEqual(second.analysis.health, first.analysis.health);
  assert.equal(second.analysis.health, first.analysis.health);
});

test("health survives redaction and never carries payload text", async () => {
  const build = toolTurns(["error"]);
  const revealService = serviceFor(build);
  const revealed = await revealService.analyze(ID, { reveal: true });
  const defaultService = serviceFor(build);
  const redacted = await defaultService.analyze(ID);
  assert.equal(redacted.redacted, true);
  assert.ok(revealed.analysis.health);
  assert.ok(redacted.analysis.health);
  assert.deepEqual(redacted.analysis.health, revealed.analysis.health);
  const serialized = JSON.stringify(redacted.analysis.health);
  assert.equal(redacted.analysis.health.rules.length, 7);
  assert.ok(!serialized.includes("sk-live-secret"));
  assert.ok(!serialized.includes("src/a.ts"));
  assert.ok(!serialized.includes("tool failed"));
});

// --- link integrity -------------------------------------------------------

test("every link exists in the analysis and respects the caps", async () => {
  const build: Build = (script) => {
    for (let index = 0; index < 12; index += 1) {
      script.prompt();
      script.assistant({ retry: true, tool: "error" });
      script.idle();
    }
    return script;
  };
  const { analysis } = await analyzeBuild(build);
  assert.ok(analysis.health);
  const health = analysis.health;
  const eventIDs = new Set(analysis.events.map((event) => event.id));
  const turnIDs = new Set(analysis.turns.map((turn) => turn.id));
  for (const rule of health.rules) {
    assert.ok(rule.eventIDs.length <= MAX_EVENT_LINKS, `${rule.id} event cap`);
    assert.ok(rule.turnIDs.length <= MAX_TURN_LINKS, `${rule.id} turn cap`);
    assert.equal(new Set(rule.eventIDs).size, rule.eventIDs.length);
    assert.equal(new Set(rule.turnIDs).size, rule.turnIDs.length);
    for (const id of rule.eventIDs) {
      assert.ok(eventIDs.has(id), `${rule.id} links unknown event ${id}`);
    }
    for (const id of rule.turnIDs) {
      assert.ok(turnIDs.has(id), `${rule.id} links unknown turn ${id}`);
    }
  }
  assert.ok(ruleFor(health, "error-rate").eventIDs.length > 0);
  assert.equal(
    ruleFor(health, "tool-failure-recurrence").eventIDs.length,
    MAX_EVENT_LINKS,
  );
});
