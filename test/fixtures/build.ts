import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ModelRef,
  RawMessage,
  SessionMeta,
  TokenUsage,
} from "../../src/core/types.ts";
import { MemorySource } from "../../src/core/adapters/memory.ts";

export const BASE = 1_700_000_000_000;
export const MODEL: ModelRef = { providerID: "test-provider", id: "test-model" };

export const ZERO: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export interface Fixture {
  sessions: Array<{ meta: SessionMeta; messages: RawMessage[] }>;
}

export function session(
  id: string,
  overrides: Partial<SessionMeta> = {},
): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    directory: "C:/fixtures/project",
    agent: "build",
    model: MODEL,
    cost: 0.01,
    tokens: { ...ZERO, input: 100, output: 20 },
    outcome: "succeeded",
    time: { created: BASE, updated: BASE + 10_000, busy: BASE, idle: BASE + 9_000 },
    ...overrides,
  };
}

export function user(
  id: string,
  seq: number,
  created: number,
  text = "Hello",
): RawMessage {
  return {
    id,
    sessionID: "unset",
    type: "user",
    seq,
    timeCreated: created,
    data: { time: { created }, text, files: [] },
  };
}

export interface AssistantOptions {
  id: string;
  seq: number;
  created: number;
  streamed?: number | null;
  completed?: number | null;
  agent?: string;
  model?: ModelRef;
  content?: unknown[];
  tokens?: TokenUsage | null;
  cost?: number | null;
  finish?: string;
  error?: Record<string, unknown>;
  retry?: Record<string, unknown>;
}

export function assistant(options: AssistantOptions): RawMessage {
  const time: Record<string, number> = { created: options.created };
  if (options.streamed !== null && options.streamed !== undefined) {
    time.streamed = options.streamed;
  }
  if (options.completed !== null && options.completed !== undefined) {
    time.completed = options.completed;
  }
  const data: Record<string, unknown> = {
    time,
    agent: options.agent ?? "build",
    model: options.model ?? MODEL,
    content: options.content ?? [{ type: "text", text: "ok" }],
    finish: options.finish ?? "stop",
  };
  if (options.tokens !== null && options.tokens !== undefined) {
    data.tokens = {
      input: options.tokens.input,
      output: options.tokens.output,
      reasoning: options.tokens.reasoning,
      cache: { read: options.tokens.cacheRead, write: options.tokens.cacheWrite },
    };
  }
  if (options.cost !== null && options.cost !== undefined) data.cost = options.cost;
  if (options.error) data.error = options.error;
  if (options.retry) data.retry = options.retry;
  return {
    id: options.id,
    sessionID: "unset",
    type: "assistant",
    seq: options.seq,
    timeCreated: options.created,
    data,
  };
}

export function textBlock(text: string): unknown {
  return { type: "text", text };
}

export function reasoningBlock(
  text: string,
  created: number,
  completed: number,
): unknown {
  return { type: "reasoning", text, time: { created, completed } };
}

export interface ToolOptions {
  id?: string;
  callID?: string;
  name: string;
  created: number;
  ran?: number | null;
  completed?: number | null;
  status?: "streaming" | "running" | "completed" | "error";
  input?: unknown;
  output?: string;
  error?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  executed?: boolean;
}

export function toolBlock(options: ToolOptions): unknown {
  const time: Record<string, number> = { created: options.created };
  if (options.ran !== null && options.ran !== undefined) time.ran = options.ran;
  if (options.completed !== null && options.completed !== undefined) {
    time.completed = options.completed;
  }
  const status = options.status ?? "completed";
  const state: Record<string, unknown> = {
    status,
    input: options.input ?? {},
    metadata: options.metadata ?? { truncated: false },
  };
  if (status === "completed" || status === "error") {
    state.content = [
      { type: "text", text: options.output ?? "(no output)" },
    ];
  }
  if (status === "error") {
    state.error =
      options.error ?? { type: "tool-error", message: "tool failed" };
  }
  return {
    type: "tool",
    id: options.callID ?? options.id ?? "call_1",
    name: options.name,
    executed: options.executed ?? false,
    state,
    time,
  };
}

export function idle(
  id: string,
  seq: number,
  created: number,
  outcome: "succeeded" | "failed" | "interrupted",
  error?: Record<string, unknown>,
): RawMessage {
  return {
    id,
    sessionID: "unset",
    type: "idle",
    seq,
    timeCreated: created,
    data: { time: { created }, outcome, ...(error ? { error } : {}) },
  };
}

export function system(
  id: string,
  seq: number,
  created: number,
  text: string,
  description = "Instructions updated",
): RawMessage {
  return {
    id,
    sessionID: "unset",
    type: "system",
    seq,
    timeCreated: created,
    data: {
      time: { created },
      text,
      description,
      metadata: { notice: "instructions" },
    },
  };
}

export function synthetic(
  id: string,
  seq: number,
  created: number,
  text: string,
  metadata: Record<string, unknown> = { source: "shell", state: "completed" },
): RawMessage {
  return {
    id,
    sessionID: "unset",
    type: "synthetic",
    seq,
    timeCreated: created,
    data: { time: { created }, text, metadata },
  };
}

export function compaction(
  id: string,
  seq: number,
  created: number,
  options: {
    tokens?: TokenUsage;
    summary?: string;
    cost?: number;
    status?: string;
    reason?: string;
    recent?: string;
  } = {},
): RawMessage {
  return {
    id,
    sessionID: "unset",
    type: "compaction",
    seq,
    timeCreated: created,
    data: {
      time: { created },
      status: options.status ?? "completed",
      reason: options.reason ?? "manual",
      model: MODEL,
      summary:
        options.summary ??
        "## Objective\nSummarized context for the next turn.",
      tokens: options.tokens
        ? {
            input: options.tokens.input,
            output: options.tokens.output,
            reasoning: options.tokens.reasoning,
            cache: {
              read: options.tokens.cacheRead,
              write: options.tokens.cacheWrite,
            },
          }
        : undefined,
      cost: options.cost ?? 0.02,
      recent: options.recent ?? "recent context before compaction",
      metadata: { keepID: "msg_keep" },
    },
  };
}

export function switchModel(
  id: string,
  seq: number,
  created: number,
  model: ModelRef,
): RawMessage {
  return {
    id,
    sessionID: "unset",
    type: "model-switched",
    seq,
    timeCreated: created,
    data: { time: { created }, model },
  };
}

export function switchAgent(
  id: string,
  seq: number,
  created: number,
  agent: string,
  previous = "build",
): RawMessage {
  return {
    id,
    sessionID: "unset",
    type: "agent-switched",
    seq,
    timeCreated: created,
    data: { time: { created }, agent, previous },
  };
}

export function withSessionID(
  messages: RawMessage[],
  sessionID: string,
): RawMessage[] {
  return messages.map((message) => ({ ...message, sessionID }));
}

export function fixture(
  sessions: Array<{ meta: SessionMeta; messages: RawMessage[] }>,
): Fixture {
  return {
    sessions: sessions.map((entry) => ({
      meta: entry.meta,
      messages: withSessionID(entry.messages, entry.meta.id),
    })),
  };
}

/** Writes a fixture to a real OpenCode-2-shaped SQLite database. */
export function writeFixtureDb(data: Fixture): {
  path: string;
  directory: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "opencode-observability-"));
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session_v2 (
      id text PRIMARY KEY,
      project_id text,
      parent_id text,
      fork_session_id text,
      fork_boundary text,
      slug text,
      directory text,
      title text,
      version text,
      cost real DEFAULT 0 NOT NULL,
      tokens_input integer DEFAULT 0 NOT NULL,
      tokens_output integer DEFAULT 0 NOT NULL,
      tokens_reasoning integer DEFAULT 0 NOT NULL,
      tokens_cache_read integer DEFAULT 0 NOT NULL,
      tokens_cache_write integer DEFAULT 0 NOT NULL,
      revert text,
      idle_outcome text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      time_busy integer,
      time_idle integer,
      time_archived integer,
      resume_attempts integer DEFAULT 0 NOT NULL,
      time_suspended integer,
      agent text,
      model text
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      type text NOT NULL,
      seq integer NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  const insertSession = db.prepare(`
    INSERT INTO session_v2 (
      id, project_id, parent_id, fork_session_id, fork_boundary, slug, directory,
      title, version, cost, tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write, revert, idle_outcome, time_created,
      time_updated, time_busy, time_idle, time_archived, resume_attempts,
      time_suspended, agent, model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entry of data.sessions) {
    const meta = entry.meta;
    insertSession.run(
      meta.id,
      meta.projectID ?? "proj_test",
      meta.parentID ?? null,
      meta.fork?.sessionID ?? null,
      meta.fork?.boundary !== undefined ? JSON.stringify(meta.fork.boundary) : null,
      meta.slug ?? "fixture-session",
      meta.directory ?? "C:/fixtures/project",
      meta.title ?? null,
      meta.version ?? "2.2.5",
      meta.cost ?? 0,
      meta.tokens?.input ?? 0,
      meta.tokens?.output ?? 0,
      meta.tokens?.reasoning ?? 0,
      meta.tokens?.cacheRead ?? 0,
      meta.tokens?.cacheWrite ?? 0,
      meta.revert !== undefined ? JSON.stringify(meta.revert) : null,
      meta.outcome ?? null,
      meta.time.created,
      meta.time.updated ?? meta.time.created,
      meta.time.busy ?? null,
      meta.time.idle ?? null,
      meta.time.archived ?? null,
      meta.resumeAttempts ?? 0,
      meta.suspendedAt ?? null,
      meta.agent ?? null,
      meta.model ? JSON.stringify(meta.model) : null,
    );
    for (const message of entry.messages) {
      insertMessage.run(
        message.id,
        message.sessionID,
        message.type,
        message.seq,
        message.timeCreated,
        message.timeUpdated ?? message.timeCreated,
        JSON.stringify(message.data),
      );
    }
  }
  db.close();
  return { path, directory };
}

export function memorySource(data: Fixture): MemorySource {
  return new MemorySource({
    kind: "jsonl",
    sessions: data.sessions.map((entry) => entry.meta),
    messages: new Map(
      data.sessions.map((entry) => [entry.meta.id, entry.messages]),
    ),
  });
}

// ---------------------------------------------------------------------------
// Named fixtures
// ---------------------------------------------------------------------------

export function simpleFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 600,
      content: [textBlock("Hello!")],
      tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 50, cacheWrite: 0 },
      cost: 0.01,
    }),
    idle("msg_i1", 3, BASE + 700, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_simple", {
        tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 50, cacheWrite: 0 },
        cost: 0.01,
        time: { created: BASE, updated: BASE + 700, busy: BASE, idle: BASE + 700 },
      }),
      messages,
    },
  ]);
}

export function toolsFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 1_400,
      content: [
        reasoningBlock("Need to inspect files.", BASE + 150, BASE + 350),
        toolBlock({
          name: "read",
          created: BASE + 400,
          ran: BASE + 600,
          completed: BASE + 800,
          input: { path: "src/index.ts" },
          output: "export const x = 1;",
        }),
        toolBlock({
          name: "grep",
          created: BASE + 700,
          ran: BASE + 900,
          completed: BASE + 1_400,
          status: "error",
          input: { pattern: "TODO" },
          output: "",
          error: { type: "tool.invalid", message: "invalid regex", status: 400 },
        }),
      ],
      tokens: { input: 1_000, output: 100, reasoning: 10, cacheRead: 3_000, cacheWrite: 500 },
      cost: 0.02,
    }),
    assistant({
      id: "msg_a2",
      seq: 3,
      created: BASE + 1_500,
      streamed: BASE + 1_900,
      completed: BASE + 2_000,
      content: [textBlock("Done.")],
      tokens: { input: 2_000, output: 50, reasoning: 0, cacheRead: 1_000, cacheWrite: 0 },
      cost: 0.03,
    }),
    idle("msg_i1", 4, BASE + 2_100, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_tools", {
        tokens: { input: 3_000, output: 150, reasoning: 10, cacheRead: 4_000, cacheWrite: 500 },
        cost: 0.05,
        time: { created: BASE, updated: BASE + 2_100, busy: BASE, idle: BASE + 2_100 },
      }),
      messages,
    },
  ]);
}

export function subagentFixture(): Fixture {
  const parentMessages = [
    user("msg_pu", 1, BASE),
    assistant({
      id: "msg_pa",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 400,
      completed: BASE + 500,
      content: [
        toolBlock({
          name: "subagent",
          created: BASE + 200,
          ran: BASE + 250,
          completed: BASE + 450,
          input: { agent: "explorer", description: "Find files", prompt: "Read the repo" },
          output: '<subagent sessionID="ses_child" state="completed">found 3 files</subagent>',
        }),
      ],
      tokens: { input: 500, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.004,
    }),
    idle("msg_pi", 3, BASE + 600, "succeeded"),
  ];
  const childMessages = [
    user("msg_cu", 1, BASE + 700, "Read the repo"),
    assistant({
      id: "msg_ca",
      seq: 2,
      created: BASE + 800,
      streamed: BASE + 1_000,
      completed: BASE + 1_100,
      content: [textBlock("found 3 files")],
      tokens: { input: 300, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.002,
    }),
    idle("msg_ci", 3, BASE + 1_200, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_parent", {
        time: { created: BASE, updated: BASE + 600, busy: BASE, idle: BASE + 600 },
      }),
      messages: parentMessages,
    },
    {
      meta: session("ses_child", {
        parentID: "ses_parent",
        title: "Child session",
        agent: "explorer",
        time: { created: BASE + 700, updated: BASE + 1_200, busy: BASE + 700, idle: BASE + 1_200 },
      }),
      messages: childMessages,
    },
  ]);
}

export function retryFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 900,
      completed: BASE + 1_000,
      content: [reasoningBlock("Trying.", BASE + 150, BASE + 800)],
      tokens: { input: 100, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.001,
      finish: "error",
      error: { type: "provider.invalid-output", message: "stream ended", status: 200 },
      retry: {
        attempt: 2,
        at: BASE + 1_100,
        error: { type: "provider.invalid-output", message: "stream ended", status: 200 },
      },
    }),
    assistant({
      id: "msg_a2",
      seq: 3,
      created: BASE + 1_200,
      streamed: BASE + 1_500,
      completed: BASE + 1_600,
      content: [textBlock("Recovered.")],
      tokens: { input: 120, output: 8, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.001,
    }),
    idle("msg_i1", 4, BASE + 1_700, "failed", {
      type: "provider.invalid-output",
      message: "stream ended",
    }),
  ];
  return fixture([
    {
      meta: session("ses_retry", {
        outcome: "failed",
        tokens: { input: 220, output: 13, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0.002,
        time: { created: BASE, updated: BASE + 1_700, busy: BASE, idle: BASE + 1_700 },
      }),
      messages,
    },
  ]);
}

export function compactionFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 600,
      content: [textBlock("First answer")],
      tokens: { input: 1_000, output: 100, reasoning: 0, cacheRead: 3_000, cacheWrite: 0 },
      cost: 0.01,
    }),
    idle("msg_i1", 3, BASE + 700, "succeeded"),
    compaction("msg_c1", 4, BASE + 800, {
      tokens: { input: 8_000, output: 400, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      summary: "A compact summary.",
      cost: 0.02,
    }),
    idle("msg_i2", 5, BASE + 900, "succeeded"),
    user("msg_u2", 6, BASE + 1_000),
    assistant({
      id: "msg_a2",
      seq: 7,
      created: BASE + 1_100,
      streamed: BASE + 1_500,
      completed: BASE + 1_600,
      content: [textBlock("Second answer")],
      tokens: { input: 2_000, output: 50, reasoning: 0, cacheRead: 500, cacheWrite: 0 },
      cost: 0.005,
    }),
    idle("msg_i3", 8, BASE + 1_700, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_compaction", {
        tokens: { input: 11_000, output: 550, reasoning: 0, cacheRead: 3_500, cacheWrite: 0 },
        cost: 0.035,
        time: { created: BASE, updated: BASE + 1_700, busy: BASE, idle: BASE + 1_700 },
      }),
      messages,
    },
  ]);
}

export function incompleteFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 400,
      completed: null,
      content: [
        toolBlock({
          name: "shell",
          created: BASE + 200,
          ran: BASE + 300,
          completed: null,
          status: "running",
          input: { command: "sleep 100" },
        }),
      ],
      tokens: { input: 100, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.001,
    }),
  ];
  return fixture([
    {
      meta: session("ses_incomplete", {
        outcome: undefined,
        time: { created: BASE, updated: BASE + 500, busy: BASE + 500, idle: BASE - 1 },
      }),
      messages,
    },
  ]);
}

export function outOfOrderFixture(): Fixture {
  const messages = [
    user("msg_u1", 1, BASE + 5_000),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 1_000,
      streamed: BASE + 1_500,
      completed: BASE + 1_600,
      content: [textBlock("late record, early timestamp")],
      tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.001,
    }),
    idle("msg_i1", 3, BASE + 1_700, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_out_of_order"),
      messages,
    },
  ]);
}

export function secretsFixture(): Fixture {
  const messages = [
    user(
      "msg_u1",
      1,
      BASE,
      "Use key sk-abcdefghijklmnopqrstuvwxyz and Authorization: Bearer abcdefghijklmnop",
    ),
    assistant({
      id: "msg_a1",
      seq: 2,
      created: BASE + 100,
      streamed: BASE + 500,
      completed: BASE + 600,
      content: [
        toolBlock({
          name: "shell",
          created: BASE + 200,
          ran: BASE + 300,
          completed: BASE + 500,
          input: {
            command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x",
            api_key: "sk-supersecretvalue12345",
            env: { PASSWORD: "hunter2" },
          },
          output:
            "response with ghp_abcdefghijklmnopqrstuvwxyz0123456789 token=abcdef1234567890",
        }),
      ],
      tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0.001,
    }),
    idle("msg_i1", 3, BASE + 700, "succeeded"),
  ];
  return fixture([
    {
      meta: session("ses_secrets", { title: "Secrets sk-testvalue1234567890" }),
      messages,
    },
  ]);
}

export function longFixture(turns = 300): Fixture {
  const messages: RawMessage[] = [];
  let seq = 1;
  for (let index = 0; index < turns; index++) {
    const created = BASE + index * 10_000;
    messages.push(user(`msg_u${index}`, seq++, created, `Prompt ${index}`));
    messages.push(
      assistant({
        id: `msg_a${index}`,
        seq: seq++,
        created: created + 100,
        streamed: created + 500,
        completed: created + 600,
        content: [textBlock(`Answer ${index}`)],
        tokens: {
          input: 100 + index,
          output: 10,
          reasoning: 0,
          cacheRead: index * 10,
          cacheWrite: 0,
        },
        cost: 0.001,
      }),
    );
    messages.push(idle(`msg_i${index}`, seq++, created + 700, "succeeded"));
  }
  return fixture([
    {
      meta: session("ses_long", {
        time: { created: BASE, updated: BASE + turns * 10_000, busy: BASE, idle: BASE + turns * 10_000 },
      }),
      messages,
    },
  ]);
}
