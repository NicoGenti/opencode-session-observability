import test from "node:test";
import assert from "node:assert/strict";
import { ObservabilityService } from "../src/core/service.ts";
import {
  DEFAULT_GUARDRAILS,
  MAX_ELAPSED_MINUTES,
  evaluateGuardrails,
} from "../src/core/guardrails.ts";
import type {
  GuardrailWarning,
  Guardrails,
} from "../src/core/guardrails.ts";
import { MAX_EVENT_LINKS, MAX_TURN_LINKS } from "../src/core/health.ts";
import { metric } from "../src/core/types.ts";
import type { Analysis, RawMessage, TokenUsage } from "../src/core/types.ts";
import {
  BASE,
  assistant,
  fixture,
  idle,
  memorySource,
  session,
  toolBlock,
  user,
} from "./fixtures/build.ts";

const ID = "ses_guardrails";

function usage(options: {
  input?: number;
  cacheRead?: number;
  output?: number;
} = {}): TokenUsage {
  return {
    input: options.input ?? 0,
    output: options.output ?? 0,
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
      tool?: "error" | "completed";
    } = {},
  ): this {
    const slot = this.tick();
    const blocks: unknown[] = [];
    if (options.tool !== undefined) {
      blocks.push(
        toolBlock({
          callID: `call_${slot.seq}`,
          name: "read",
          created: slot.at + 10,
          ran: slot.at + 20,
          completed: slot.at + 30,
          status: options.tool === "error" ? "error" : "completed",
          input: { path: "src/a.ts" },
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
        tokens: options.tokens === undefined ? usage({ input: 100 }) : options.tokens,
        cost: options.cost === undefined ? 0.01 : options.cost,
        retry: options.retry
          ? { attempt: 1, at: slot.at + 600, error: { message: "retry" } }
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

  end(): RawMessage[] {
    return this.messages;
  }
}

type Build = (script: Script) => Script;

function empty(): Build {
  return (script) => script;
}

async function analysisFor(build: Build): Promise<Analysis> {
  const service = new ObservabilityService(
    memorySource(
      fixture([{ meta: session(ID), messages: build(new Script()).end() }]),
    ),
  );
  const { analysis } = await service.analyze(ID, { reveal: true });
  return analysis;
}

function ruleIDs(guardrails: Guardrails): string[] {
  return guardrails.warnings.map((warning) => warning.id);
}

function warningFor(guardrails: Guardrails, id: string): GuardrailWarning {
  const found = guardrails.warnings.find((warning) => warning.id === id);
  assert.ok(found, `budget ${id} must be reported`);
  return found;
}

function retryTurns(count: number): Build {
  return (script) => {
    for (let index = 0; index < count; index += 1) {
      script.prompt();
      script.assistant({ retry: true });
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

/** Turns whose prompt size grows linearly up to `finalContext`. */
function growth(count: number, finalContext: number): Build {
  return (script) => {
    for (let index = 0; index < count; index += 1) {
      const prompt =
        count === 1
          ? finalContext
          : Math.round(finalContext * (0.5 + (0.5 * index) / (count - 1)));
      const input = Math.round(prompt * 0.2);
      script.prompt();
      script.assistant({ tokens: usage({ input, cacheRead: prompt - input }) });
      script.idle();
    }
    return script;
  };
}

/** One assistant step recording exactly `total` tokens in one turn. */
function tokenTurn(total: number): Build {
  return (script) => {
    script.prompt();
    script.assistant({ tokens: usage({ input: Math.round(total * 0.6), cacheRead: total - Math.round(total * 0.6) }) });
    script.idle();
    return script;
  };
}

/** Replaces the event index with two anchors spanning exactly `minutes`. */
function withElapsed(analysis: Analysis, minutes: number): Analysis {
  const anchor = analysis.events[0];
  assert.ok(anchor, "the fixture must record at least one event");
  return {
    ...analysis,
    coverage: { ...analysis.coverage, complete: true },
    events: [
      { ...anchor, id: "ev_first", timestamp: 0 },
      { ...anchor, id: "ev_last", timestamp: Math.round(minutes * 60_000) },
    ],
  };
}

/** Everything below its budget: no warning, no skip. */
const HUGE = {
  tokensTotal: Number.MAX_SAFE_INTEGER,
  costTotal: Number.MAX_SAFE_INTEGER,
  contextRun: Number.MAX_SAFE_INTEGER,
  retries: Number.MAX_SAFE_INTEGER,
  toolFailures: Number.MAX_SAFE_INTEGER,
  elapsedMinutes: Number.MAX_SAFE_INTEGER,
};

// --- defaults -------------------------------------------------------------

test("exports the frozen default budgets", () => {
  assert.ok(Object.isFrozen(DEFAULT_GUARDRAILS));
  assert.deepEqual(DEFAULT_GUARDRAILS, {
    tokensTotal: 2_000_000,
    costTotal: 5,
    contextRun: 6,
    retries: 10,
    toolFailures: 5,
    elapsedMinutes: 60,
  });
  assert.equal(MAX_ELAPSED_MINUTES, 100_000);
});

test("a malformed injected budget falls back to the default", async () => {
  const analysis = await analysisFor(costTurns([3, 3]));
  const malformed = {
    costTotal: Number.NaN,
    tokensTotal: -1,
  } as unknown as typeof DEFAULT_GUARDRAILS;
  const guardrails = evaluateGuardrails(analysis, malformed);
  // The default cost budget is 5, which $6.00 crosses.
  assert.equal(warningFor(guardrails, "cost-total").threshold, 5);
  // The default token budget is 2,000,000, which 200 tokens do not.
  assert.equal(guardrails.warnings.some((row) => row.id === "tokens-total"), false);
});

// --- token budget ---------------------------------------------------------

test("tokens-total triggers at, above and below its budget", async () => {
  const analysis = await analysisFor(tokenTurn(1_000));

  const at = warningFor(
    evaluateGuardrails(analysis, { ...HUGE, tokensTotal: 1_000 }),
    "tokens-total",
  );
  assert.equal(at.observed, "1000 total token(s) recorded");
  assert.equal(at.threshold, 1_000);

  assert.equal(
    ruleIDs(evaluateGuardrails(analysis, { ...HUGE, tokensTotal: 1_001 })).includes(
      "tokens-total",
    ),
    false,
  );
  assert.equal(
    ruleIDs(evaluateGuardrails(analysis, { ...HUGE, tokensTotal: 999 })).includes(
      "tokens-total",
    ),
    true,
  );
});

test("tokens-total links the heaviest turns, capped", async () => {
  const analysis = await analysisFor((script) => {
    script.prompt();
    script.assistant({ tokens: usage({ input: 10 }) });
    script.prompt();
    script.assistant({ tokens: usage({ input: 900 }) });
    script.prompt();
    script.assistant({ tokens: usage({ input: 300 }) });
    script.idle();
    return script;
  });
  const warning = warningFor(
    evaluateGuardrails(analysis, { ...HUGE, tokensTotal: 0 }),
    "tokens-total",
  );
  assert.deepEqual(warning.turnIDs, [`${ID}:t2`, `${ID}:t3`, `${ID}:t1`]);
});

test("tokens-total is skipped when token usage was not recorded", async () => {
  const guardrails = evaluateGuardrails(await analysisFor(empty()));
  assert.equal(
    guardrails.skipped.find((row) => row.id === "tokens-total")?.note,
    "token usage was not recorded",
  );
});

// --- cost budget ----------------------------------------------------------

test("cost-total triggers at, above and below its budget", async () => {
  const analysis = await analysisFor(costTurns([3, 3]));
  const at = warningFor(
    evaluateGuardrails(analysis, { ...HUGE, costTotal: 6 }),
    "cost-total",
  );
  assert.equal(at.observed, "$6.00 total recorded cost");
  assert.equal(at.threshold, 6);

  assert.equal(
    ruleIDs(evaluateGuardrails(analysis, { ...HUGE, costTotal: 6.01 })).includes(
      "cost-total",
    ),
    false,
  );
  assert.equal(
    ruleIDs(evaluateGuardrails(analysis, { ...HUGE, costTotal: 5.99 })).includes(
      "cost-total",
    ),
    true,
  );
});

test("cost-total is skipped when cost was not recorded", async () => {
  const guardrails = evaluateGuardrails(await analysisFor(costTurns([null])));
  assert.equal(
    guardrails.skipped.find((row) => row.id === "cost-total")?.note,
    "cost was not recorded",
  );
  assert.equal(guardrails.warnings.some((row) => row.id === "cost-total"), false);
});

// --- context-run budget ---------------------------------------------------

test("context-run triggers at, above and below its budget", async () => {
  const analysis = await analysisFor(growth(6, 150_000));
  const at = warningFor(
    evaluateGuardrails(analysis, { ...HUGE, contextRun: 5 }),
    "context-run",
  );
  assert.equal(at.observed, "longest growth run 5 turn(s)");
  assert.equal(at.turnIDs.length, 2);

  assert.equal(
    ruleIDs(evaluateGuardrails(analysis, { ...HUGE, contextRun: 6 })).includes(
      "context-run",
    ),
    false,
  );
  assert.equal(
    ruleIDs(evaluateGuardrails(analysis, { ...HUGE, contextRun: 4 })).includes(
      "context-run",
    ),
    true,
  );
});

test("context-run is skipped with fewer than two recorded deltas", async () => {
  const guardrails = evaluateGuardrails(await analysisFor(growth(1, 150_000)));
  assert.match(
    guardrails.skipped.find((row) => row.id === "context-run")?.note ?? "",
    /at least 2 are required/,
  );
});

// --- retries budget -------------------------------------------------------

test("retries triggers at, above and below its budget", async () => {
  const analysis = await analysisFor(retryTurns(4));
  const at = warningFor(
    evaluateGuardrails(analysis, { ...HUGE, retries: 4 }),
    "retries",
  );
  assert.equal(at.observed, "4 retry event(s) recorded");
  assert.equal(at.eventIDs.length, 4);

  assert.equal(
    ruleIDs(evaluateGuardrails(analysis, { ...HUGE, retries: 5 })).includes("retries"),
    false,
  );
  assert.equal(
    ruleIDs(evaluateGuardrails(analysis, { ...HUGE, retries: 3 })).includes("retries"),
    true,
  );
});

test("retry evidence is capped at the health event cap", async () => {
  const analysis = await analysisFor(retryTurns(15));
  const warning = warningFor(
    evaluateGuardrails(analysis, { ...HUGE, retries: 0 }),
    "retries",
  );
  assert.equal(warning.eventIDs.length, MAX_EVENT_LINKS);
});

// --- tool-failures budget -------------------------------------------------

test("tool-failures triggers at, above and below its budget", async () => {
  const analysis = await analysisFor(
    toolTurns(["error", "error", "error"]),
  );
  const at = warningFor(
    evaluateGuardrails(analysis, { ...HUGE, toolFailures: 3 }),
    "tool-failures",
  );
  assert.equal(at.observed, "3 tool-failure incident(s) recorded");
  assert.equal(at.eventIDs.length, 3);

  assert.equal(
    ruleIDs(evaluateGuardrails(analysis, { ...HUGE, toolFailures: 4 })).includes(
      "tool-failures",
    ),
    false,
  );
  assert.equal(
    ruleIDs(evaluateGuardrails(analysis, { ...HUGE, toolFailures: 2 })).includes(
      "tool-failures",
    ),
    true,
  );
});

// --- elapsed budget -------------------------------------------------------

test("elapsed-minutes triggers at, above and below its budget", async () => {
  const analysis = withElapsed(await analysisFor(costTurns([0.01, 0.01])), 60);

  const at = warningFor(
    evaluateGuardrails(analysis, { ...HUGE, elapsedMinutes: 60 }),
    "elapsed-minutes",
  );
  assert.equal(
    at.observed,
    "60.0 minute(s) from the first to the last recorded event",
  );
  assert.deepEqual(at.eventIDs, ["ev_first", "ev_last"]);

  assert.equal(
    ruleIDs(
      evaluateGuardrails(analysis, { ...HUGE, elapsedMinutes: 60.1 }),
    ).includes("elapsed-minutes"),
    false,
  );
  assert.equal(
    ruleIDs(
      evaluateGuardrails(analysis, { ...HUGE, elapsedMinutes: 59.9 }),
    ).includes("elapsed-minutes"),
    true,
  );
});

test("elapsed-minutes is skipped, never guessed, on a windowed analysis", async () => {
  const analysis = await analysisFor(costTurns([0.01, 0.01]));
  const windowed: Analysis = {
    ...analysis,
    coverage: { ...analysis.coverage, complete: false },
  };
  const guardrails = evaluateGuardrails(windowed, {
    ...HUGE,
    elapsedMinutes: 0,
  });
  assert.equal(guardrails.warnings.some((row) => row.id === "elapsed-minutes"), false);
  assert.equal(
    guardrails.skipped.find((row) => row.id === "elapsed-minutes")?.note,
    "the analysis covers a window, not the full session",
  );
});

// --- shape and determinism ------------------------------------------------

test("every warning carries the derived basis and the advisory flag", async () => {
  const analysis = withElapsed(await analysisFor(growth(6, 150_000)), 90);
  const guardrails = evaluateGuardrails(analysis, {
    tokensTotal: 0,
    costTotal: 0,
    contextRun: 0,
    retries: 0,
    toolFailures: 0,
    elapsedMinutes: 0,
  });
  assert.equal(guardrails.warnings.length, 6);
  for (const warning of guardrails.warnings) {
    assert.equal(warning.basis, "derived");
    assert.equal(warning.advisory, true);
    assert.ok(warning.label.length > 0);
    assert.ok(warning.observed.length > 0);
    assert.equal(typeof warning.threshold, "number");
    assert.ok(warning.eventIDs.length <= MAX_EVENT_LINKS);
    assert.ok(warning.turnIDs.length <= MAX_TURN_LINKS);
  }
  assert.equal(guardrails.skipped.length, 0);
});

test("zero budgets report every evaluable budget in the fixed order", async () => {
  const analysis = withElapsed(await analysisFor(growth(6, 150_000)), 90);
  const guardrails = evaluateGuardrails(analysis, {
    tokensTotal: 0,
    costTotal: 0,
    contextRun: 0,
    retries: 0,
    toolFailures: 0,
    elapsedMinutes: 0,
  });
  assert.deepEqual(ruleIDs(guardrails), [
    "tokens-total",
    "cost-total",
    "context-run",
    "retries",
    "tool-failures",
    "elapsed-minutes",
  ]);
});

test("an analysis under every budget reports nothing", async () => {
  const guardrails = evaluateGuardrails(
    await analysisFor(growth(6, 150_000)),
    HUGE,
  );
  assert.deepEqual(guardrails.warnings, []);
  assert.deepEqual(guardrails.skipped, []);
});

test("an empty session skips the budgets it cannot evaluate", async () => {
  const guardrails = evaluateGuardrails(await analysisFor(empty()));
  assert.deepEqual(
    guardrails.skipped.map((row) => row.id),
    ["tokens-total", "cost-total", "context-run", "elapsed-minutes"],
  );
  assert.deepEqual(guardrails.warnings, []);
});

test("every evidence link exists in the analysis", async () => {
  const analysis = withElapsed(await analysisFor(growth(6, 150_000)), 90);
  const eventIDs = new Set(analysis.events.map((event) => event.id));
  const turnIDs = new Set(analysis.turns.map((turn) => turn.id));
  const guardrails = evaluateGuardrails(analysis, {
    tokensTotal: 0,
    costTotal: 0,
    contextRun: 0,
    retries: 0,
    toolFailures: 0,
    elapsedMinutes: 0,
  });
  for (const warning of guardrails.warnings) {
    for (const id of warning.eventIDs) assert.ok(eventIDs.has(id), id);
    for (const id of warning.turnIDs) assert.ok(turnIDs.has(id), id);
  }
});

test("the evaluator is deterministic and never mutates the analysis", async () => {
  const analysis = withElapsed(await analysisFor(retryTurns(4)), 30);
  const snapshot = structuredClone(analysis);
  const first = evaluateGuardrails(analysis, { ...HUGE, tokensTotal: 0 });
  const second = evaluateGuardrails(analysis, { ...HUGE, tokensTotal: 0 });
  assert.deepEqual(first, second);
  assert.deepEqual(analysis, snapshot);
});

test("the DTO carries no payload text", async () => {
  const analysis = await analysisFor((script) => {
    script.prompt("sk-live-secret-value");
    script.assistant({ tool: "error", retry: true });
    script.idle("failed");
    return script;
  });
  const guardrails = evaluateGuardrails(analysis, {
    tokensTotal: 0,
    costTotal: 0,
    contextRun: 0,
    retries: 0,
    toolFailures: 0,
    elapsedMinutes: 0,
  });
  assert.doesNotMatch(JSON.stringify(guardrails), /sk-live-secret-value/);
});
