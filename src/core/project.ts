import {
  cacheHitRateMetric,
  contextDeltaMetric,
  differenceMetric,
  durationMetric,
  modelTimeMetric,
  outputSpeedMetric,
  promptTokensMetric,
  sumMetrics,
  sumTokens,
  weightedCacheHitRate,
} from "./metrics.ts";
import { EMPTY_TOKENS, metric } from "./types.ts";
import type {
  Analysis,
  Capabilities,
  CompactionTransaction,
  Coverage,
  ErrorCounts,
  EventIndexEntry,
  Metric,
  NormalizedEvent,
  SessionFamily,
  SessionMeta,
  Step,
  StepStatus,
  TokenUsage,
  Totals,
  Turn,
  TurnStatus,
  TurnTrigger,
} from "./types.ts";
import { preview } from "./util.ts";

export interface ProjectOptions {
  session: SessionMeta;
  family: SessionFamily;
  coverage: Coverage;
  sourceKind: "sqlite" | "api" | "jsonl";
  /** When true, the first step of an incomplete window is marked start-unknown. */
  windowed?: boolean;
  generatedAt?: number;
}

interface StepBuilder {
  event: NormalizedEvent;
  events: NormalizedEvent[];
  tools: NormalizedEvent[];
  status: StepStatus;
  startUnknown: boolean;
}

interface TurnBuilder {
  index: number;
  id: string;
  trigger: TurnTrigger;
  startTime: number;
  endTime: number | null;
  idleTimestamp: number | null;
  idleOutcome: string | null;
  events: NormalizedEvent[];
  steps: StepBuilder[];
  currentStep: StepBuilder | null;
}

function stepStatus(event: NormalizedEvent): StepStatus {
  const status = event.status ?? "";
  if (status === "error") return "error";
  if (status === "interrupted" || status === "aborted") return "interrupted";
  if (status === "incomplete") return "incomplete";
  if (status === "running") return "running";
  if (status === "stop" || status === "tool-calls" || status === "length" || status === "content-filter") {
    return "completed";
  }
  if (status === "completed") return "completed";
  return event.endTimestamp === null ? "incomplete" : "completed";
}

function turnStatus(turn: TurnBuilder, sessionActive: boolean): TurnStatus {
  if (turn.idleOutcome === "succeeded") return "completed";
  if (turn.idleOutcome === "failed") return "error";
  if (turn.idleOutcome === "interrupted") return "interrupted";
  const steps = turn.steps;
  if (steps.length === 0) return "unknown";
  if (steps.some((step) => step.status === "error")) return "error";
  if (steps.some((step) => step.status === "interrupted")) return "interrupted";
  if (sessionActive) return "running";
  if (steps.every((step) => step.status === "completed")) {
    return "completed";
  }
  return "incomplete";
}

function isStepEvent(event: NormalizedEvent): boolean {
  return (
    event.kind === "assistant" ||
    event.kind === "reasoning" ||
    event.kind === "text" ||
    event.kind === "tool"
  );
}

function isNonStepEvent(event: NormalizedEvent): boolean {
  return !isStepEvent(event);
}

function finalizeStep(
  builder: StepBuilder,
  turnID: string,
  index: number,
  trigger: string,
): Step {
  const event = builder.event;
  const tokens = event.tokens;
  const tools = builder.tools
    .map((toolEvent) => toolEvent.tool)
    .filter((tool): tool is NonNullable<typeof tool> => tool !== null);
  const start = event.timestamp;
  const end = event.endTimestamp;
  const toolCount = tools.length;
  const startUnknown = builder.startUnknown;
  // The assistant event's endTimestamp is completed ?? streamed. Read the raw
  // payload for the precise `streamed` timestamp, which delimits model work.
  const payload = event.payload as Record<string, unknown> | null;
  const rawTime =
    payload && typeof payload === "object" && payload.time
      ? (payload.time as Record<string, unknown>)
      : {};
  const streamed = typeof rawTime.streamed === "number" ? rawTime.streamed : null;
  const completed = typeof rawTime.completed === "number" ? rawTime.completed : null;
  const exactModelTime = modelTimeMetric(
    { created: start, streamed, completed },
    toolCount,
    startUnknown,
  );
  const toolMetrics = tools.map((tool) => tool.duration);
  const toolTime =
    toolMetrics.length === 0
      ? metric(0, "measured", "no tool calls in this step")
      : sumMetrics(
          toolMetrics,
          toolMetrics.length > 1
            ? "sum of tool durations; parallel tool calls can exceed wall-clock"
            : undefined,
        );
  const totalTime = durationMetric(start, end, {
    startUnknown,
    incomplete:
      builder.status === "incomplete" ||
      builder.status === "running" ||
      (completed !== null && end !== null && end < completed),
    note:
      completed === null && end !== null
        ? "provider stream ended; step completion was not recorded"
        : undefined,
  });
  const residual = differenceMetric(totalTime, exactModelTime, toolTime);
  const prompt = promptTokensMetric(tokens);
  const cache = cacheHitRateMetric(tokens);
  const speed = outputSpeedMetric(tokens?.output ?? null, exactModelTime);
  const subagents = [
    ...new Set(tools.flatMap((tool) => tool.childSessionIDs)),
  ];
  const uncertainty = new Set<string>();
  for (const item of builder.events) for (const note of item.uncertainty) uncertainty.add(note);
  if (startUnknown) uncertainty.add("start-unknown");
  if (!tokens) uncertainty.add("tokens-missing");
  if (tokens && toolMetrics.some((value) => value.value === null)) {
    uncertainty.add("tool-duration-partial");
  }
  if (builder.status === "incomplete") uncertainty.add("step-incomplete");
  const responseText =
    event.meta && typeof event.meta === "object"
      ? String(event.meta.responseText ?? "")
      : "";
  const reasoningText =
    event.meta && typeof event.meta === "object"
      ? String(event.meta.reasoningText ?? "")
      : "";
  return {
    id: event.messageID,
    turnID,
    index,
    trigger,
    startTime: start,
    endTime: end,
    startUnknown,
    agent: event.agent,
    model: event.model,
    provider: event.provider,
    finish:
      event.meta && typeof event.meta === "object"
        ? (event.meta.finish as string | null) ?? null
        : null,
    toolNames: [...new Set(tools.map((tool) => tool.name))],
    toolCalls: tools,
    tokens,
    cost: event.cost,
    promptTokens: prompt,
    cacheHitRate: cache,
    ttft: metric(
      null,
      "unavailable",
      "OpenCode 2 does not persist a first-token timestamp",
    ),
    modelTime: exactModelTime,
    toolTime,
    totalTime,
    residualTime: residual,
    outputSpeed: speed,
    status: builder.status,
    subagentSessionIDs: subagents,
    eventIDs: builder.events.map((item) => item.id),
    responseText,
    reasoningText,
    uncertainty: [...uncertainty],
  };
}

function sumCosts(values: ReadonlyArray<number | null>): Metric {
  if (values.length === 0) return metric(null, "unavailable", "no model calls");
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return metric(null, "unavailable", "cost was not recorded");
  const total = present.reduce((sum, value) => sum + value, 0);
  return metric(
    total,
    "derived",
    present.length === values.length
      ? "sum of recorded costs"
      : `${values.length - present.length} cost value(s) missing`,
  );
}

function turnMetrics(
  builder: TurnBuilder,
  steps: Step[],
): Omit<
  Turn,
  "id" | "index" | "trigger" | "startTime" | "endTime" | "status" | "steps" | "eventIDs" | "nonStepEventIDs" | "uncertainty"
> {
  const tokenTotals = sumTokens(steps.map((step) => step.tokens));
  const promptValues = steps.map((step) => step.promptTokens);
  const latest = [...steps].reverse().find((step) => step.promptTokens.value !== null);
  const cumulative = sumMetrics(promptValues, "sum of step prompt sizes");
  const cache = weightedCacheHitRate(steps.map((step) => step.tokens));
  const modelTime = sumMetrics(steps.map((step) => step.modelTime));
  const toolTime = sumMetrics(steps.map((step) => step.toolTime));
  const firstStart = steps[0]?.startTime ?? builder.startTime;
  const lastStepEnd = steps.length > 0 ? steps[steps.length - 1]?.endTime ?? null : builder.endTime;
  const lastCompleted = [...steps].reverse().find((step) => step.status === "completed");
  const lastCompletedEnd = lastCompleted?.endTime ?? null;
  const lastEventTime =
    builder.events[builder.events.length - 1]?.timestamp ?? builder.endTime;
  const totalTime =
    steps.length > 0
      ? durationMetric(firstStart, lastCompletedEnd, {
          startUnknown: steps.some((step) => step.startUnknown),
          note: lastCompleted ? undefined : "no completed step in this turn",
        })
      : durationMetric(builder.startTime, lastEventTime, {
          note: "turn has no assistant step",
        });
  const residual = differenceMetric(totalTime, modelTime, toolTime);
  const speed = outputSpeedMetric(
    steps.reduce((sum, step) => sum + (step.tokens?.output ?? 0), 0),
    modelTime,
  );
  return {
    firstStepStart: steps[0]?.startTime ?? null,
    lastStepEnd,
    tokens: tokenTotals.tokens,
    tokensComplete: steps.length > 0 && tokenTotals.complete,
    promptTokensLatest: latest?.promptTokens ?? metric(null, "unavailable", "no step tokens"),
    promptTokensCumulative: cumulative,
    cacheHitRate: cache,
    contextDelta: metric(null, "unavailable", "computed after all turns"),
    cost: sumCosts(steps.map((step) => step.cost)),
    modelTime,
    toolTime,
    totalTime,
    residualTime: residual,
    outputSpeed: speed,
  };
}

function buildCompactions(
  events: readonly NormalizedEvent[],
  steps: readonly Step[],
): CompactionTransaction[] {
  const transactions: CompactionTransaction[] = [];
  for (const event of events) {
    if (event.kind !== "compaction") continue;
    const stepIndex = steps.findIndex((step) => step.startTime > event.timestamp);
    const previous =
      stepIndex === -1
        ? steps[steps.length - 1]
        : stepIndex === 0
          ? undefined
          : steps[stepIndex - 1];
    const next = stepIndex === -1 ? undefined : steps[stepIndex];
    const beforeFromRequest = event.tokens
      ? promptTokensMetric(event.tokens)
      : metric(null, "unavailable", "compaction request tokens missing");
    const before =
      beforeFromRequest.value !== null
        ? beforeFromRequest
        : previous?.promptTokens ?? metric(null, "unavailable", "previous step tokens missing");
    const after = next?.promptTokens ?? metric(null, "unavailable", "next step tokens missing");
    const delta =
      before.value !== null && after.value !== null
        ? metric(after.value - before.value, "derived", "after - before")
        : metric(null, "unavailable", "context before or after is unavailable");
    const removed =
      before.value !== null && after.value !== null
        ? metric(
            before.value - after.value,
            "derived",
            before.value - after.value >= 0
              ? "before - after; positive means context shrank"
              : "before - after; negative means context grew",
          )
        : metric(null, "unavailable", "context before or after is unavailable");
    const summary = event.text ?? "";
    const uncertainty = new Set<string>(event.uncertainty);
    uncertainty.add("summary-tokens-are-compaction-request-usage");
    if (before.value === null) uncertainty.add("context-before-unavailable");
    if (after.value === null) uncertainty.add("context-after-unavailable");
    transactions.push({
      eventID: event.id,
      turnID: event.turnID,
      timestamp: event.timestamp,
      status: event.status ?? "unknown",
      reason:
        event.meta && typeof event.meta === "object"
          ? (event.meta.reason as string | null) ?? null
          : null,
      model: event.model,
      provider: event.provider,
      tokens: event.tokens,
      cost: event.cost,
      summaryChars: summary.length,
      summaryPreview: preview(summary, 240),
      contextBefore: before,
      contextAfter: after,
      contextDelta: delta,
      removedTokens: removed,
      duration: metric(
        null,
        "unavailable",
        "only the compaction completion timestamp is persisted",
      ),
      uncertainty: [...uncertainty],
    });
  }
  return transactions;
}

function computedCapabilities(
  events: readonly NormalizedEvent[],
  session: SessionMeta,
  sourceKind: "sqlite" | "api" | "jsonl",
): Capabilities {
  const tokens = events.map((event) => event.tokens).filter(Boolean);
  const costs = events.map((event) => event.cost).filter((value) => value !== null);
  return {
    source: sourceKind,
    ttft: false,
    approvals: false,
    requestHeaders: false,
    toolSetChanges: false,
    tokenUsage: tokens.length > 0,
    reasoning: events.some((event) => event.kind === "reasoning"),
    cacheUsage: tokens.some((value) => value!.cacheRead > 0 || value!.cacheWrite > 0),
    cost: costs.length > 0,
    retries: events.some((event) => event.kind === "retry"),
    compactions: events.some((event) => event.kind === "compaction"),
    subagents:
      events.some((event) => event.flags.subagent) ||
      session.parentID !== undefined ||
      events.some((event) => event.kind === "tool" && event.tool?.childSessionIDs.length),
    contextNotices: events.some((event) => event.kind === "system"),
    modelSwitches: events.some((event) => event.kind === "model-switched"),
    routeChanges: events.some((event) => event.kind === "location-switched"),
    forkResumeMarkers:
      session.fork !== undefined ||
      session.revert !== undefined ||
      (session.resumeAttempts ?? 0) > 0 ||
      session.suspendedAt !== undefined,
    toolDurations: events.some(
      (event) => event.kind === "tool" && event.tool?.duration.value !== null,
    ),
    promptTokenBreakdown: "prompt = input + cache.read + cache.write",
    notes: [
      "TTFT, permission decisions, request headers and tool-set changes are not persisted in OpenCode 2.2.x session data.",
      "Tool timing is the sum of recorded tool durations; parallel calls may exceed wall-clock.",
      "OpenCode reports session-level totals that can include auxiliary model calls (title, generation, compaction).",
      ...(sourceKind === "api"
        ? [
            "Sequence numbers are synthesized from the API message order; the order itself is authoritative.",
          ]
        : []),
    ],
  };
}

function computedTotals(
  turns: readonly Turn[],
  steps: readonly Step[],
  events: readonly NormalizedEvent[],
  compactions: readonly CompactionTransaction[],
  session: SessionMeta,
  coverage: Coverage,
): Totals {
  const stepTotals = sumTokens(steps.map((step) => step.tokens));
  const compactionTotals = sumTokens(compactions.map((item) => item.tokens));
  const allUsages = [
    ...steps.map((step) => step.tokens),
    ...compactions.map((item) => item.tokens),
  ];
  const allTokens = sumTokens(allUsages);
  const modelTime = sumMetrics(steps.map((step) => step.modelTime));
  const toolTime = sumMetrics(steps.map((step) => step.toolTime));
  const activeTurnTime = sumMetrics(turns.map((turn) => turn.totalTime));
  const wallClock =
    events.length === 0
      ? metric(null, "unavailable", "no events")
      : durationMetric(
          events[0]!.timestamp,
          events[events.length - 1]!.timestamp,
          {
            note: coverage.complete
              ? "first to last recorded event"
              : "first to last event in the loaded window",
          },
        );
  const speed = outputSpeedMetric(
    steps.reduce((sum, step) => sum + (step.tokens?.output ?? 0), 0),
    modelTime,
  );
  const tools = events.filter((event) => event.kind === "tool");
  const toolErrors = tools.filter(
    (event) => event.tool?.status === "error" || event.tool?.error !== null,
  ).length;
  const stepErrors = steps.filter((step) => step.status === "error").length;
  const sessionErrors = events.filter(
    (event) => event.kind === "idle" && (event.status === "failed" || event.status === "interrupted"),
  ).length;
  const errors: ErrorCounts = {
    total: toolErrors + stepErrors + sessionErrors,
    tool: toolErrors,
    step: stepErrors,
    session: sessionErrors,
  };
  const costs = [
    ...turns.map((turn) => turn.cost.value),
    ...compactions.map((item) => item.cost),
  ];
  const presentCosts = costs.filter((value): value is number => value !== null);
  const cost =
    costs.length === 0
      ? metric(null, "unavailable", "no model calls")
      : presentCosts.length === 0
        ? metric(null, "unavailable", "cost was not recorded")
        : metric(
            presentCosts.reduce((sum, value) => sum + value, 0),
            "derived",
            presentCosts.length === costs.length
              ? "steps + compactions"
              : `${costs.length - presentCosts.length} cost value(s) missing`,
          );
  const finalContext =
    [...steps].reverse().find((step) => step.promptTokens.value !== null)?.promptTokens ??
    metric(null, "unavailable", "no step token usage");
  const cumulativePrompt = sumMetrics(
    steps.map((step) => step.promptTokens),
    "sum of step prompt sizes",
  );
  const recordedTokens = session.tokens;
  const recorded =
    recordedTokens || session.cost !== undefined
      ? {
          ...(recordedTokens ? { tokens: recordedTokens } : {}),
          ...(session.cost !== undefined ? { cost: session.cost } : {}),
          note: "Reported by the OpenCode session row; can include auxiliary model calls.",
        }
      : undefined;
  return {
    scope: coverage.complete ? "session" : "window",
    turns: turns.length,
    steps: steps.length,
    toolCalls: tools.length,
    subagentCalls: tools.filter((event) => event.flags.subagent).length,
    errors,
    retries: events.filter((event) => event.kind === "retry").length,
    compactions: compactions.length,
    tokens: allTokens.tokens,
    tokensComplete: allUsages.length > 0 && allTokens.complete,
    stepTokens: stepTotals.tokens,
    compactionTokens: compactionTotals.tokens,
    cacheHitRate: weightedCacheHitRate(allUsages),
    cost,
    modelTime,
    toolTime,
    activeTurnTime,
    wallClockTime: wallClock,
    outputSpeed: speed,
    finalContext,
    cumulativePrompt,
    recorded,
  };
}

export function toEventIndex(event: NormalizedEvent): EventIndexEntry {
  return {
    id: event.id,
    messageID: event.messageID,
    sessionID: event.sessionID,
    seq: event.seq,
    orderKey: event.orderKey,
    timestamp: event.timestamp,
    kind: event.kind,
    actor: event.actor,
    title: event.title,
    preview: event.textPreview ?? "",
    agent: event.agent,
    model: event.model,
    provider: event.provider,
    status: event.status,
    toolName: event.tool?.name ?? null,
    toolStatus: event.tool?.status ?? null,
    tokens: event.tokens,
    cost: event.cost,
    stepID: event.stepID,
    turnID: event.turnID,
    flags: event.flags,
    uncertainty: event.uncertainty,
  };
}

/**
 * Folds the normalized event stream into turns, steps, compaction
 * transactions, totals and capabilities.
 *
 * Grouping is deliberately conservative:
 * - recorded `seq` order is never changed;
 * - a user message opens a turn;
 * - an assistant message is one step;
 * - an idle message closes the open turn;
 * - system/switch/compaction events attach to the open turn, otherwise they
 *   stay unattached and are listed separately.
 */
export function projectSession(
  events: readonly NormalizedEvent[],
  options: ProjectOptions,
): Analysis {
  const { session, family, coverage, sourceKind } = options;
  const sessionActive =
    session.time.busy !== undefined &&
    (session.time.idle === undefined || session.time.busy > session.time.idle);

  const turns: TurnBuilder[] = [];
  const unattached: NormalizedEvent[] = [];
  const eventsWithTurn: NormalizedEvent[] = [];
  let current: TurnBuilder | null = null;

  const attach = (event: NormalizedEvent, turn: TurnBuilder): NormalizedEvent => {
    const assigned = { ...event, turnID: turn.id };
    turn.events.push(assigned);
    return assigned;
  };

  const startTurn = (event: NormalizedEvent, trigger: TurnTrigger): TurnBuilder => {
    const builder: TurnBuilder = {
      index: turns.length,
      id: `${session.id}:t${turns.length + 1}`,
      trigger,
      startTime: event.timestamp,
      endTime: null,
      idleTimestamp: null,
      idleOutcome: null,
      events: [],
      steps: [],
      currentStep: null,
    };
    turns.push(builder);
    return builder;
  };

  for (const rawEvent of events) {
    let event = rawEvent;

    if (event.kind === "session") {
      unattached.push(event);
      eventsWithTurn.push(event);
      continue;
    }

    if (event.kind === "user") {
      if (current) {
        const previous = current;
        previous.endTime =
          previous.endTime ??
          previous.events[previous.events.length - 1]?.timestamp ??
          null;
        current = null;
      }
      const trigger: TurnTrigger = {
        kind: session.parentID ? "delegation" : "user",
        eventID: event.id,
        label: session.parentID ? "Delegated prompt" : "User message",
      };
      const turn = startTurn(event, trigger);
      current = turn;
      event = attach(event, turn);
      eventsWithTurn.push(event);
      continue;
    }

    if (event.kind === "synthetic") {
      if (!current) {
        const turn = startTurn(event, {
          kind: "synthetic",
          eventID: event.id,
          label: "Synthetic/automatic message",
        });
        current = turn;
        event = attach(event, turn);
      } else {
        event = attach(event, current);
      }
      eventsWithTurn.push(event);
      continue;
    }

    if (event.kind === "assistant") {
      if (!current) {
        const trigger: TurnTrigger = event.flags.retry
          ? { kind: "retry", eventID: event.id, label: "Retry" }
          : sessionActive && (session.resumeAttempts ?? 0) > 0
            ? { kind: "resume", eventID: event.id, label: "Resumed execution" }
            : { kind: "orphan", eventID: event.id, label: "Assistant without user message" };
        const turn = startTurn(event, trigger);
        current = turn;
        turn.events.push({ ...event, turnID: turn.id });
        turn.currentStep = {
          event: { ...event, turnID: turn.id },
          events: [{ ...event, turnID: turn.id }],
          tools: [],
          status: stepStatus(event),
          startUnknown: event.timestamp <= 0,
        };
        turn.steps.push(turn.currentStep);
        event = { ...event, turnID: turn.id };
      } else {
        event = attach(event, current);
        current.currentStep = {
          event,
          events: [event],
          tools: [],
          status: stepStatus(event),
          startUnknown: event.timestamp <= 0,
        };
        current.steps.push(current.currentStep);
      }
      eventsWithTurn.push(event);
      continue;
    }

    if (event.kind === "reasoning" || event.kind === "text" || event.kind === "tool") {
      if (!current) {
        // A block without a preceding assistant message is malformed data.
        unattached.push(event);
        eventsWithTurn.push(event);
        continue;
      }
      const step = current.currentStep;
      if (!step || event.stepID !== step.event.messageID) {
        // Block events can arrive after a later assistant message in broken
        // data; keep them in the turn but do not invent a step.
        event = {
          ...event,
          uncertainty: [...event.uncertainty, "orphan-step-block"],
        };
      }
      event = attach(event, current);
      if (step && event.stepID === step.event.messageID) {
        step.events.push(event);
        if (event.kind === "tool") step.tools.push(event);
      }
      eventsWithTurn.push(event);
      continue;
    }

    if (event.kind === "idle") {
      if (!current) {
        unattached.push(event);
        eventsWithTurn.push(event);
        continue;
      }
      event = attach(event, current);
      current.idleTimestamp = event.timestamp;
      current.idleOutcome = event.status;
      current.endTime = event.timestamp;
      eventsWithTurn.push(event);
      current = null;
      continue;
    }

    if (event.kind === "retry" || event.kind === "error") {
      if (!current) {
        unattached.push(event);
        eventsWithTurn.push(event);
        continue;
      }
      event = attach(event, current);
      const step = current.currentStep;
      if (step && event.stepID === step.event.messageID) step.events.push(event);
      eventsWithTurn.push(event);
      continue;
    }

    // system, compaction, switches, skill, shell, unknown
    if (current) {
      event = attach(event, current);
    } else {
      unattached.push(event);
    }
    eventsWithTurn.push(event);
  }

  const finalizedTurns: Turn[] = [];
  const allSteps: Step[] = [];
  for (const builder of turns) {
    const steps = builder.steps.map((step, index) => {
      const previous = index > 0 ? builder.steps[index - 1] : null;
      const trigger =
        index === 0
          ? builder.trigger.label
          : previous && previous.tools.length > 0
            ? "After tool results"
            : "Assistant continuation";
      return finalizeStep(step, builder.id, index + 1, trigger);
    });
    allSteps.push(...steps);
    const base = turnMetrics(builder, steps);
    const eventIDs = builder.events.map((event) => event.id);
    const nonStepEventIDs = builder.events
      .filter((event) => isNonStepEvent(event))
      .map((event) => event.id);
    const uncertainty = new Set<string>();
    if (builder.trigger.kind === "orphan") uncertainty.add("assistant-without-user");
    for (const step of steps) for (const note of step.uncertainty) uncertainty.add(note);
    if (builder.idleOutcome === null && steps.length > 0) uncertainty.add("no-idle-recorded");
    finalizedTurns.push({
      id: builder.id,
      index: builder.index + 1,
      trigger: builder.trigger,
      startTime: builder.startTime,
      endTime:
        builder.idleTimestamp ??
        base.lastStepEnd ??
        builder.events[builder.events.length - 1]?.timestamp ??
        null,
      status: turnStatus(builder, sessionActive),
      steps,
      eventIDs,
      nonStepEventIDs,
      ...base,
      uncertainty: [...uncertainty],
    });
  }

  // Context deltas across turns (the selector in the UI does not change these).
  for (let index = 1; index < finalizedTurns.length; index++) {
    const turn = finalizedTurns[index]!;
    const previous = finalizedTurns[index - 1]!;
    turn.contextDelta = contextDeltaMetric(
      turn.promptTokensLatest,
      previous.promptTokensLatest,
    );
  }

  const compactions = buildCompactions(eventsWithTurn, allSteps);
  const totals = computedTotals(
    finalizedTurns,
    allSteps,
    eventsWithTurn,
    compactions,
    session,
    coverage,
  );
  const capabilities = computedCapabilities(eventsWithTurn, session, sourceKind);

  return {
    version: 1,
    session,
    family,
    capabilities,
    coverage,
    events: eventsWithTurn.map(toEventIndex),
    turns: finalizedTurns,
    compactions,
    totals,
    unattachedEventIDs: unattached.map((event) => event.id),
    generatedAt: options.generatedAt ?? Date.now(),
    redacted: false,
  };
}
