import {
  asArray,
  asRecord,
  bool,
  modelLabel,
  normalizeModel,
  normalizeTokens,
  num,
  parseJson,
  preview,
  safeStringify,
  str,
  toMillis,
  truncate,
} from "./util.ts";
import { metric } from "./types.ts";
import type {
  EventFlags,
  EventKind,
  ModelRef,
  NormalizedEvent,
  RawMessage,
  SessionMeta,
  ToolCallDetail,
  ToolError,
  ToolStatus,
  TokenUsage,
} from "./types.ts";
import { toolDurationMetric } from "./metrics.ts";

export interface NormalizeOptions {
  session?: SessionMeta | null;
}

const EMPTY_FLAGS: EventFlags = {
  error: false,
  retry: false,
  compaction: false,
  context: false,
  subagent: false,
  approval: false,
  uncertain: false,
};

function orderKey(seq: number, order: number, messageID: string): string {
  return `${String(seq).padStart(12, "0")}:${String(order + 10).padStart(4, "0")}:${messageID}`;
}

function flag(
  flags: EventFlags,
  updates: Partial<EventFlags>,
): EventFlags {
  return { ...flags, ...updates, uncertain: false };
}

function withUncertainty(event: NormalizedEvent): NormalizedEvent {
  const unique = [...new Set(event.uncertainty)];
  return {
    ...event,
    uncertainty: unique,
    flags: { ...event.flags, uncertain: unique.length > 0 },
  };
}

function eventBase(
  message: RawMessage,
  values: {
    id: string;
    order: number;
    timestamp: number;
    endTimestamp?: number | null;
    kind: EventKind;
    actor: NormalizedEvent["actor"];
    title: string;
    text?: string | null;
    agent?: string | null;
    model?: ModelRef | null;
    provider?: string | null;
    status?: string | null;
    tool?: ToolCallDetail | null;
    tokens?: TokenUsage | null;
    cost?: number | null;
    stepID?: string | null;
    flags?: EventFlags;
    uncertainty?: string[];
    payload?: unknown;
    meta?: Record<string, unknown>;
  },
): NormalizedEvent {
  const text = values.text ?? null;
  const event: NormalizedEvent = {
    id: values.id,
    messageID: message.id,
    sessionID: message.sessionID,
    seq: message.seq,
    order: values.order,
    orderKey: orderKey(message.seq, values.order, message.id),
    timestamp: values.timestamp,
    endTimestamp: values.endTimestamp ?? null,
    kind: values.kind,
    actor: values.actor,
    title: values.title,
    text,
    textPreview: text === null ? null : preview(text, 240),
    agent: values.agent ?? null,
    model: values.model ?? null,
    provider: values.provider ?? values.model?.providerID ?? null,
    status: values.status ?? null,
    tool: values.tool ?? null,
    tokens: values.tokens ?? null,
    cost: values.cost ?? null,
    stepID: values.stepID ?? null,
    turnID: null,
    flags: values.flags ?? EMPTY_FLAGS,
    uncertainty: values.uncertainty ?? [],
    payload: values.payload ?? message.data,
    meta: values.meta,
  };
  return withUncertainty(event);
}

function timeRecord(data: Record<string, unknown>): Record<string, unknown> {
  return asRecord(data.time);
}

function messageTimestamp(data: Record<string, unknown>, fallback: number): number {
  return toMillis(timeRecord(data).created) ?? fallback;
}

function toolStatus(value: unknown): ToolStatus {
  return value === "streaming" ||
    value === "running" ||
    value === "completed" ||
    value === "error"
    ? value
    : "unknown";
}

function toolError(value: unknown): ToolError | null {
  const record = asRecord(value);
  const type = str(record.type);
  const message = str(record.message);
  if (!type && !message) return null;
  const out: ToolError = {
    type: type ?? "unknown",
    message: message ?? "",
  };
  const status = num(record.status);
  if (status !== null) out.status = status;
  const retryAfterMs = num(record.retryAfterMs);
  if (retryAfterMs !== null) out.retryAfterMs = retryAfterMs;
  return out;
}

function outputFromContent(value: unknown): string | null {
  const parts: string[] = [];
  for (const item of asArray<Record<string, unknown>>(value)) {
    const type = str(item.type);
    if (type === "text") {
      const text = str(item.text);
      if (text !== null) parts.push(text);
    } else if (type === "file") {
      const name = str(item.name) ?? str(item.uri) ?? "file";
      parts.push(`[file] ${name}`);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function childSessionIDs(
  toolName: string,
  output: string | null,
  metadata: Record<string, unknown> | null,
  input: unknown,
): string[] {
  const found = new Set<string>();
  if (output) {
    const pattern = /<subagent\b[^>]*\bsessionID="([^"]+)"/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      if (match[1]) found.add(match[1]);
    }
  }
  if (metadata) {
    for (const key of ["sessionID", "sessionId", "childSessionID", "childSessionId"]) {
      const value = str(metadata[key]);
      if (value && value.startsWith("ses_")) found.add(value);
    }
  }
  if (toolName === "subagent" || toolName === "task") {
    const record = asRecord(input);
    for (const key of ["sessionID", "sessionId", "childSessionID", "childSessionId"]) {
      const value = str(record[key]);
      if (value && value.startsWith("ses_")) found.add(value);
    }
  }
  return [...found];
}

function toolDetail(block: Record<string, unknown>): ToolCallDetail {
  const state = asRecord(block.state);
  const status = toolStatus(state.status);
  const input = parseJson(state.input);
  const output = outputFromContent(state.content);
  const metadata = Object.keys(asRecord(state.metadata)).length > 0 ? asRecord(state.metadata) : null;
  const error = toolError(state.error);
  const time = asRecord(block.time);
  const createdAt = toMillis(time.created);
  const ranAt = toMillis(time.ran);
  const completedAt = toMillis(time.completed);
  const name = str(block.name) ?? "unknown";
  const duration = toolDurationMetric({
    createdAt,
    ranAt,
    completedAt,
    status,
  });
  return {
    callID: str(block.id) ?? "",
    name,
    status,
    input,
    inputPreview: preview(input, 240),
    output,
    outputPreview: output === null ? null : preview(output, 240),
    error,
    metadata,
    createdAt,
    ranAt,
    completedAt,
    duration,
    childSessionIDs: childSessionIDs(name, output, metadata, input),
    executed: bool(block.executed),
    ...(bool(asRecord(metadata).truncated) === true ? { outputTruncated: true } : {}),
  };
}

function assistantStatus(
  data: Record<string, unknown>,
  content: unknown[],
): { status: string; flags: Partial<EventFlags>; uncertainty: string[] } {
  const error = asRecord(data.error);
  const retry = asRecord(data.retry);
  const finish = str(data.finish);
  const time = timeRecord(data);
  const completed = toMillis(time.completed);
  const uncertainty: string[] = [];
  const flags: Partial<EventFlags> = {};
  if (Object.keys(error).length > 0 || finish === "error") {
    flags.error = true;
    const type = str(error.type) ?? "";
    const message = str(error.message) ?? "";
    if (type === "aborted" || /interrupt/i.test(type) || /interrupt/i.test(message)) {
      return { status: "interrupted", flags, uncertainty };
    }
    return { status: "error", flags, uncertainty };
  }
  if (retry.attempt !== undefined) {
    flags.retry = true;
    uncertainty.push("retry-derived");
  }
  if (completed === null) {
    uncertainty.push("step-incomplete");
    return { status: "incomplete", flags, uncertainty };
  }
  if (content.length === 0) {
    uncertainty.push("empty-assistant-content");
  }
  return { status: finish ?? "completed", flags, uncertainty };
}

function provenanceEvent(
  session: SessionMeta,
  index: number,
): NormalizedEvent | null {
  const lines: string[] = [];
  const flags: Partial<EventFlags> = {};
  if (session.parentID) {
    lines.push(`Spawned by parent session ${session.parentID}.`);
  }
  if (session.fork) {
    lines.push(
      `Forked from ${session.fork.sessionID}${
        session.fork.boundary ? ` (boundary: ${safeStringify(session.fork.boundary)})` : ""
      }.`,
    );
    flags.uncertain = true;
  }
  if (session.revert) {
    lines.push(`Revert staged: ${safeStringify(session.revert)}.`);
    flags.uncertain = true;
  }
  if (session.resumeAttempts !== undefined && session.resumeAttempts > 0) {
    lines.push(`Resume attempts recorded: ${session.resumeAttempts}.`);
    flags.uncertain = true;
  }
  if (session.suspendedAt !== undefined && session.suspendedAt > 0) {
    lines.push(`Session was suspended at ${new Date(session.suspendedAt).toISOString()}.`);
    flags.uncertain = true;
  }
  if (lines.length === 0) return null;
  return {
    id: `session:${session.id}:${index}`,
    messageID: `session:${session.id}`,
    sessionID: session.id,
    seq: 0,
    order: -10 + index,
    orderKey: orderKey(0, -10 + index, `session:${session.id}`),
    timestamp: session.time.created,
    endTimestamp: null,
    kind: "session",
    actor: "session",
    title: "Session provenance",
    text: lines.join("\n"),
    textPreview: preview(lines.join(" "), 240),
    agent: session.agent ?? null,
    model: session.model ?? null,
    provider: session.model?.providerID ?? null,
    status: session.outcome ?? null,
    tool: null,
    tokens: null,
    cost: null,
    stepID: null,
    turnID: null,
    flags: { ...EMPTY_FLAGS, ...flags, uncertain: true },
    uncertainty: ["derived-from-session-metadata"],
    payload: {
      parentID: session.parentID,
      fork: session.fork,
      revert: session.revert,
      resumeAttempts: session.resumeAttempts,
      suspendedAt: session.suspendedAt,
    },
    meta: { derived: true },
  };
}

/**
 * Normalizes persisted OpenCode messages into a single ordered event stream.
 * The recorded `seq` order is authoritative; timestamps that regress are
 * flagged, never re-sorted.
 */
export function normalizeMessages(
  messages: readonly RawMessage[],
  options: NormalizeOptions = {},
): NormalizedEvent[] {
  const sorted = [...messages].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    if (a.timeCreated !== b.timeCreated) return a.timeCreated - b.timeCreated;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const events: NormalizedEvent[] = [];
  const session = options.session ?? null;
  if (session) {
    let marker = 0;
    const provenance = provenanceEvent(session, marker++);
    if (provenance) events.push(provenance);
  }

  let previousMessageTime: number | null = null;
  for (const message of sorted) {
    const data = asRecord(parseJson(message.data));
    const type = str(data.type) ?? message.type ?? "unknown";
    const time = timeRecord(data);
    const messageTime = messageTimestamp(data, message.timeCreated);
    const timestampMissing = !Number.isFinite(messageTime) || messageTime <= 0;
    const regression =
      previousMessageTime !== null && messageTime + 1000 < previousMessageTime;
    previousMessageTime = messageTime;

    const baseUncertainty: string[] = [];
    if (regression) baseUncertainty.push("timestamp-regression");
    if (timestampMissing) baseUncertainty.push("timestamp-missing");

    const add = (event: NormalizedEvent): void => {
      const withBase = baseUncertainty.length
        ? withUncertainty({
            ...event,
            uncertainty: [...event.uncertainty, ...baseUncertainty],
          })
        : event;
      events.push(withBase);
    };

    switch (type) {
      case "user": {
        const text = str(data.text) ?? "";
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            kind: "user",
            actor: "user",
            title: session?.parentID ? "Subagent prompt" : "User message",
            text,
            agent: null,
            model: null,
            flags: EMPTY_FLAGS,
            payload: data,
            meta: {
              files: asArray(data.files).length,
              agents: asArray(data.agents).map((item) => str(asRecord(item).name)).filter(Boolean),
              skills: asArray(data.skills).map((item) => str(asRecord(item).name)).filter(Boolean),
            },
          }),
        );
        break;
      }
      case "assistant": {
        const content = asArray<unknown>(data.content);
        const agent = str(data.agent);
        const model = normalizeModel(data.model);
        const tokens = normalizeTokens(data.tokens);
        const cost = num(data.cost);
        const status = assistantStatus(data, content);
        const responseText = content
          .map((item) => {
            const block = asRecord(item);
            return str(block.type) === "text" ? str(block.text) : null;
          })
          .filter((value): value is string => value !== null)
          .join("\n\n");
        const reasoningText = content
          .map((item) => {
            const block = asRecord(item);
            return str(block.type) === "reasoning" ? str(block.text) : null;
          })
          .filter((value): value is string => value !== null)
          .join("\n\n");
        const flags = flag(EMPTY_FLAGS, status.flags);
        const end = toMillis(time.completed) ?? toMillis(time.streamed) ?? null;
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            endTimestamp: end,
            kind: "assistant",
            actor: "assistant",
            title: `Assistant step${status.flags.error ? " (error)" : ""}`,
            text: reasoningText || responseText || null,
            agent,
            model,
            status: status.status,
            tokens,
            cost,
            stepID: message.id,
            flags,
            uncertainty: status.uncertainty,
            payload: data,
            meta: {
              finish: str(data.finish),
              rawFinish: str(data.rawFinish),
              blockCount: content.length,
              responseText,
              reasoningText,
            },
          }),
        );

        content.forEach((item, index) => {
          const block = asRecord(item);
          const blockType = str(block.type);
          const blockTime = asRecord(block.time);
          const blockCreated = toMillis(blockTime.created);
          const blockCompleted = toMillis(blockTime.completed);
          if (blockType === "reasoning") {
            const text = str(block.text) ?? "";
            add(
              eventBase(message, {
                id: `${message.id}:${index}`,
                order: index,
                timestamp: blockCreated ?? messageTime,
                endTimestamp: blockCompleted,
                kind: "reasoning",
                actor: "assistant",
                title: "Reasoning",
                text,
                agent,
                model,
                status: null,
                stepID: message.id,
                flags: EMPTY_FLAGS,
                uncertainty: blockCreated === null ? ["timestamp-approximate"] : [],
                payload: block,
              }),
            );
          } else if (blockType === "text") {
            const text = str(block.text) ?? "";
            add(
              eventBase(message, {
                id: `${message.id}:${index}`,
                order: index,
                timestamp: messageTime,
                kind: "text",
                actor: "assistant",
                title: "Assistant text",
                text,
                agent,
                model,
                status: null,
                stepID: message.id,
                flags: EMPTY_FLAGS,
                payload: block,
                meta: { timestampApproximate: true },
              }),
            );
          } else if (blockType === "tool") {
            const tool = toolDetail(block);
            const toolFlags = flag(EMPTY_FLAGS, {
              error: tool.status === "error" || tool.error !== null,
              subagent:
                tool.name === "subagent" ||
                tool.name === "task" ||
                tool.childSessionIDs.length > 0,
            });
            const uncertainty: string[] = [];
            if (tool.status === "running" || tool.status === "streaming") {
              uncertainty.push("tool-not-finished");
            }
            if (tool.createdAt === null && tool.ranAt === null) {
              uncertainty.push("tool-time-missing");
            }
            add(
              eventBase(message, {
                id: `${message.id}:${index}`,
                order: index,
                timestamp: tool.createdAt ?? messageTime,
                endTimestamp: tool.completedAt,
                kind: "tool",
                actor: "tool",
                title: `Tool: ${tool.name}`,
                text: tool.output,
                agent,
                model,
                status: tool.status,
                tool,
                stepID: message.id,
                flags: toolFlags,
                uncertainty,
                payload: block,
                meta: {
                  delegatedAgent: str(asRecord(tool.input).agent),
                  description: str(asRecord(tool.input).description),
                },
              }),
            );
          } else {
            add(
              eventBase(message, {
                id: `${message.id}:${index}`,
                order: index,
                timestamp: messageTime,
                kind: "unknown",
                actor: "assistant",
                title: `Unknown content block: ${blockType ?? "?"}`,
                text: safeStringify(block).slice(0, 400),
                agent,
                model,
                stepID: message.id,
                flags: EMPTY_FLAGS,
                uncertainty: ["unknown-content-block"],
                payload: block,
              }),
            );
          }
        });

        const retry = asRecord(data.retry);
        if (Object.keys(retry).length > 0) {
          const retryTime = toMillis(retry.at) ?? messageTime;
          const retryError = asRecord(retry.error);
          add(
            eventBase(message, {
              id: `${message.id}:retry`,
              order: 1000,
              timestamp: retryTime,
              kind: "retry",
              actor: "assistant",
              title: `Retry #${num(retry.attempt) ?? "?"}`,
              text: str(retryError.message) ?? null,
              agent,
              model,
              status: "retry",
              stepID: message.id,
              flags: flag(EMPTY_FLAGS, { retry: true, error: true }),
              payload: retry,
              meta: { attempt: num(retry.attempt), error: retryError, derived: true },
            }),
          );
        }
        const error = asRecord(data.error);
        if (Object.keys(error).length > 0) {
          add(
            eventBase(message, {
              id: `${message.id}:error`,
              order: 1001,
              timestamp: toMillis(time.streamed) ?? toMillis(time.completed) ?? messageTime,
              kind: "error",
              actor: "assistant",
              title:
                status.status === "interrupted"
                  ? `Step interruption: ${str(error.type) ?? "unknown"}`
                  : `Step error: ${str(error.type) ?? "unknown"}`,
              text: str(error.message) ?? null,
              agent,
              model,
              status: status.status,
              stepID: message.id,
              flags: flag(EMPTY_FLAGS, { error: true }),
              payload: error,
              meta: { error, derived: true },
            }),
          );
        }
        break;
      }
      case "synthetic": {
        const text = str(data.text) ?? "";
        const metadata = asRecord(data.metadata);
        const source = str(metadata.source);
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            kind: "synthetic",
            actor: "system",
            title: `Synthetic message${source ? ` (${source})` : ""}`,
            text,
            status: str(metadata.state),
            flags: EMPTY_FLAGS,
            payload: data,
            meta: metadata,
          }),
        );
        break;
      }
      case "system": {
        const text = str(data.text) ?? "";
        const metadata = asRecord(data.metadata);
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            kind: "system",
            actor: "system",
            title: str(data.description) ?? "System update",
            text,
            flags: flag(EMPTY_FLAGS, { context: true }),
            payload: data,
            meta: metadata,
          }),
        );
        break;
      }
      case "skill": {
        const text = str(data.text) ?? "";
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            kind: "skill",
            actor: "system",
            title: `Skill: ${str(data.name) ?? str(data.skill) ?? "unknown"}`,
            text,
            flags: flag(EMPTY_FLAGS, { context: true }),
            payload: data,
            meta: { skill: str(data.skill) },
          }),
        );
        break;
      }
      case "shell": {
        const output = asRecord(data.output);
        const text = str(output.output) ?? "";
        const status = str(data.status) ?? "unknown";
        const exit = num(data.exit);
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            endTimestamp: toMillis(time.completed),
            kind: "shell",
            actor: "tool",
            title: `Shell: ${truncate(str(data.command) ?? "unknown", 120)}`,
            text,
            status,
            flags: flag(EMPTY_FLAGS, {
              error: status === "timeout" || status === "killed",
            }),
            payload: data,
            meta: {
              shellID: str(data.shellID),
              exit,
              truncated: bool(output.truncated),
            },
          }),
        );
        break;
      }
      case "compaction": {
        const summary = str(data.summary) ?? "";
        const tokens = normalizeTokens(data.tokens);
        const model = normalizeModel(data.model);
        const reason = str(data.reason);
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            kind: "compaction",
            actor: "system",
            title: `Compaction (${reason ?? "unknown"})${str(data.status) ? ` · ${str(data.status)}` : ""}`,
            text: summary,
            model,
            status: str(data.status),
            tokens,
            cost: num(data.cost),
            flags: flag(EMPTY_FLAGS, { compaction: true, context: true }),
            payload: data,
            meta: {
              reason,
              summaryChars: summary.length,
              recentChars: (str(data.recent) ?? "").length,
              keepID: str(asRecord(data.metadata).keepID),
            },
          }),
        );
        break;
      }
      case "agent-switched": {
        const agent = str(data.agent);
        const previous = str(data.previous);
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            kind: "agent-switched",
            actor: "session",
            title: `Agent switched: ${previous ?? "?"} -> ${agent ?? "?"}`,
            agent,
            flags: EMPTY_FLAGS,
            payload: data,
            meta: { previous },
          }),
        );
        break;
      }
      case "model-switched": {
        const model = normalizeModel(data.model);
        const previous = normalizeModel(data.previous);
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            kind: "model-switched",
            actor: "session",
            title: `Model switched: ${modelLabel(model) ?? "?"}${
              previous ? ` (was ${modelLabel(previous)})` : ""
            }`,
            model,
            flags: EMPTY_FLAGS,
            payload: data,
            meta: { previous },
          }),
        );
        break;
      }
      case "location-switched": {
        const location = asRecord(data.location);
        const previous = asRecord(asRecord(data.previous).location);
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            kind: "location-switched",
            actor: "session",
            title: `Location changed: ${str(location.directory) ?? "?"}`,
            text: str(location.directory) ?? null,
            flags: EMPTY_FLAGS,
            payload: data,
            meta: {
              directory: str(location.directory),
              previous: str(previous.directory),
              projectID: str(data.projectID),
              subpath: str(data.subpath),
            },
          }),
        );
        break;
      }
      case "idle": {
        const outcome = str(data.outcome) ?? "unknown";
        const error = asRecord(data.error);
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            kind: "idle",
            actor: "session",
            title: `Idle: ${outcome}`,
            text: str(error.message) ?? null,
            status: outcome,
            flags: flag(EMPTY_FLAGS, {
              error: outcome === "failed" || outcome === "interrupted",
            }),
            payload: data,
            meta: { outcome, error },
          }),
        );
        break;
      }
      default: {
        add(
          eventBase(message, {
            id: message.id,
            order: -1,
            timestamp: messageTime,
            kind: "unknown",
            actor: "unknown",
            title: `Unknown message type: ${type}`,
            text: preview(data, 400),
            flags: EMPTY_FLAGS,
            uncertainty: ["unknown-message-type"],
            payload: data,
          }),
        );
      }
    }
  }

  return events;
}

export function eventSearchCorpus(event: NormalizedEvent): string {
  const parts: string[] = [
    event.title,
    event.kind,
    event.agent ?? "",
    event.model?.id ?? "",
    event.model?.providerID ?? "",
    event.status ?? "",
    event.tool?.name ?? "",
    typeof event.meta?.delegatedAgent === "string" ? event.meta.delegatedAgent : "",
    event.text ?? "",
  ];
  if (event.tool) {
    parts.push(safeStringify(event.tool.input));
    parts.push(event.tool.output ?? "");
  }
  parts.push(safeStringify(event.payload));
  return parts.join("\n").toLowerCase();
}
