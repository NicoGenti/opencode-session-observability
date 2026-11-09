import { DatabaseSync } from "node:sqlite";
import type {
  ModelRef,
  ObservabilitySource,
  RawMessage,
  SessionFamily,
  SessionMeta,
  SessionSummary,
  TokenUsage,
} from "../types.ts";
import { normalizeModel, num, parseJson, str } from "../util.ts";


export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSchemaError";
  }
}

export class DatabaseBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseBusyError";
  }
}

export type SchemaKind = "v2" | "v1" | "unknown";

export function detectSchema(db: DatabaseSync): SchemaKind {
  const rows = db
    .prepare(
      "select name from sqlite_master where type = 'table' and name in ('session_v2','session_message','session','message','part')",
    )
    .all() as Array<{ name: string }>;
  const names = new Set(rows.map((row) => row.name));
  if (names.has("session_v2") && names.has("session_message")) return "v2";
  if (names.has("session") && names.has("message")) return "v1";
  return "unknown";
}

function rowRecord(row: unknown): Record<string, unknown> {
  return row && typeof row === "object" ? (row as Record<string, unknown>) : {};
}

function tokensFromRow(row: Record<string, unknown>): TokenUsage | undefined {
  const values = [
    row.tokens_input,
    row.tokens_output,
    row.tokens_reasoning,
    row.tokens_cache_read,
    row.tokens_cache_write,
  ];
  if (!values.some((value) => typeof value === "number")) return undefined;
  return {
    input: num(row.tokens_input) ?? 0,
    output: num(row.tokens_output) ?? 0,
    reasoning: num(row.tokens_reasoning) ?? 0,
    cacheRead: num(row.tokens_cache_read) ?? 0,
    cacheWrite: num(row.tokens_cache_write) ?? 0,
  };
}

function modelFromRow(row: Record<string, unknown>): ModelRef | undefined {
  const model = normalizeModel(row.model);
  return model ?? undefined;
}

function sessionMetaFromRow(row: Record<string, unknown>): SessionMeta {
  const forkSessionID = str(row.fork_session_id);
  const forkBoundary = row.fork_boundary;
  const meta: SessionMeta = {
    id: str(row.id) ?? "",
    time: {
      created: num(row.time_created) ?? 0,
      ...(num(row.time_updated) !== null ? { updated: num(row.time_updated)! } : {}),
      ...(num(row.time_busy) !== null ? { busy: num(row.time_busy)! } : {}),
      ...(num(row.time_idle) !== null ? { idle: num(row.time_idle)! } : {}),
      ...(num(row.time_archived) !== null ? { archived: num(row.time_archived)! } : {}),
    },
  };
  const parentID = str(row.parent_id);
  if (parentID) meta.parentID = parentID;
  if (forkSessionID) {
    meta.fork = {
      sessionID: forkSessionID,
      ...(forkBoundary !== null && forkBoundary !== undefined
        ? { boundary: parseJson(forkBoundary) }
        : {}),
    };
  }
  const projectID = str(row.project_id);
  if (projectID) meta.projectID = projectID;
  const title = str(row.title);
  if (title) meta.title = title;
  const directory = str(row.directory);
  if (directory) meta.directory = directory;
  const agent = str(row.agent);
  if (agent) meta.agent = agent;
  const model = modelFromRow(row);
  if (model) meta.model = model;
  const cost = num(row.cost);
  if (cost !== null) meta.cost = cost;
  const tokens = tokensFromRow(row);
  if (tokens) meta.tokens = tokens;
  const outcome = str(row.idle_outcome);
  if (outcome === "succeeded" || outcome === "failed" || outcome === "interrupted") {
    meta.outcome = outcome;
  }
  const revert = row.revert;
  if (revert !== null && revert !== undefined && revert !== "") {
    meta.revert = parseJson(revert);
  }
  const resumeAttempts = num(row.resume_attempts);
  if (resumeAttempts !== null) meta.resumeAttempts = resumeAttempts;
  const suspended = num(row.time_suspended);
  if (suspended !== null) meta.suspendedAt = suspended;
  const version = str(row.version);
  if (version) meta.version = version;
  const slug = str(row.slug);
  if (slug) meta.slug = slug;
  return meta;
}

function summaryFromMeta(meta: SessionMeta): SessionSummary {
  return {
    id: meta.id,
    ...(meta.parentID ? { parentID: meta.parentID } : {}),
    ...(meta.projectID ? { projectID: meta.projectID } : {}),
    ...(meta.slug ? { slug: meta.slug } : {}),
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.directory ? { directory: meta.directory } : {}),
    ...(meta.agent ? { agent: meta.agent } : {}),
    ...(meta.model ? { model: meta.model } : {}),
    timeCreated: meta.time.created,
    ...(meta.time.updated ? { timeUpdated: meta.time.updated } : {}),
    ...(meta.cost !== undefined ? { cost: meta.cost } : {}),
    ...(meta.tokens ? { tokens: meta.tokens } : {}),
    ...(meta.outcome ? { outcome: meta.outcome } : {}),
  };
}

const SESSION_COLUMNS = `
  id, project_id, parent_id, fork_session_id, fork_boundary, slug, directory, title,
  version, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
  tokens_cache_write, revert, idle_outcome, time_created, time_updated, time_busy,
  time_idle, time_archived, resume_attempts, time_suspended, agent, model
`;

/**
 * Read-only adapter over the OpenCode 2 SQLite database.
 *
 * The connection is opened with SQLITE_OPEN_READONLY and `PRAGMA query_only`
 * is enabled, so no statement can mutate the session store.
 */
export class SqliteSource implements ObservabilitySource {
  readonly kind = "sqlite" as const;
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    try {
      this.db = new DatabaseSync(path, {
        readOnly: true,
        enableForeignKeyConstraints: false,
      });
      this.db.exec("PRAGMA query_only = ON");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/busy|locked/i.test(message)) {
        throw new DatabaseBusyError(
          `OpenCode database is locked: ${path}. The analysis is read-only; retry when the session is idle. (${message})`,
        );
      }
      throw error;
    }
    const schema = detectSchema(this.db);
    if (schema !== "v2") {
      this.db.close();
      throw new UnsupportedSchemaError(
        schema === "v1"
          ? `OpenCode 1 database detected at ${path}. This build reads OpenCode 2 (session_v2/session_message).`
          : `Unrecognized database at ${path}. Expected OpenCode 2 tables session_v2 and session_message.`,
      );
    }
  }

  async listSessions(options: { query?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    const limit = Math.max(1, Math.min(1000, options.limit ?? 100));
    const query = options.query?.trim();
    const rows = query
      ? (this.db
          .prepare(
            `select ${SESSION_COLUMNS} from session_v2
             where title like ? or directory like ? or id like ? or slug like ? or agent like ?
             order by time_updated desc limit ?`,
          )
          .all(
            `%${query}%`,
            `%${query}%`,
            `%${query}%`,
            `%${query}%`,
            `%${query}%`,
            limit,
          ) as unknown[])
      : (this.db
          .prepare(
            `select ${SESSION_COLUMNS} from session_v2 order by time_updated desc limit ?`,
          )
          .all(limit) as unknown[]);
    return rows.map((row) => summaryFromMeta(sessionMetaFromRow(rowRecord(row))));
  }

  async getSession(sessionID: string): Promise<SessionMeta | null> {
    const row = this.db
      .prepare(`select ${SESSION_COLUMNS} from session_v2 where id = ?`)
      .get(sessionID);
    return row ? sessionMetaFromRow(rowRecord(row)) : null;
  }

  async listMessages(
    sessionID: string,
    options: { fromSeq?: number; toSeq?: number } = {},
  ): Promise<RawMessage[]> {
    const conditions = ["session_id = ?"];
    const params: Array<string | number> = [sessionID];
    if (options.fromSeq !== undefined) {
      conditions.push("seq >= ?");
      params.push(options.fromSeq);
    }
    if (options.toSeq !== undefined) {
      conditions.push("seq <= ?");
      params.push(options.toSeq);
    }
    const rows = this.db
      .prepare(
        `select id, session_id, type, seq, time_created, time_updated, data
         from session_message where ${conditions.join(" and ")}
         order by seq asc, time_created asc, id asc`,
      )
      .all(...params) as unknown[];
    return rows.map((row) => {
      const record = rowRecord(row);
      const raw = str(record.data) ?? "";
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { __parseError: true, __raw: raw };
      }
      return {
        id: str(record.id) ?? "",
        sessionID: str(record.session_id) ?? sessionID,
        type: str(record.type) ?? "unknown",
        seq: num(record.seq) ?? 0,
        timeCreated: num(record.time_created) ?? 0,
        ...(num(record.time_updated) !== null
          ? { timeUpdated: num(record.time_updated)! }
          : {}),
        data,
      };
    });
  }

  async messageBounds(
    sessionID: string,
  ): Promise<{ minSeq: number; maxSeq: number; count: number }> {
    const row = rowRecord(
      this.db
        .prepare(
          "select min(seq) as minSeq, max(seq) as maxSeq, count(*) as count from session_message where session_id = ?",
        )
        .get(sessionID),
    );
    return {
      minSeq: num(row.minSeq) ?? 0,
      maxSeq: num(row.maxSeq) ?? 0,
      count: num(row.count) ?? 0,
    };
  }

  async getFamily(sessionID: string): Promise<SessionFamily> {
    const chain: SessionMeta[] = [];
    const seen = new Set<string>();
    let cursor: SessionMeta | null = await this.getSession(sessionID);
    while (cursor && !seen.has(cursor.id) && chain.length < 64) {
      seen.add(cursor.id);
      chain.push(cursor);
      cursor = cursor.parentID ? await this.getSession(cursor.parentID) : null;
    }
    if (chain.length === 0) {
      return { rootID: sessionID, parent: null, children: [] };
    }
    const root = chain[chain.length - 1]!;
    const parentMeta = chain.length > 1 ? chain[1]! : null;
    const childRows = this.db
      .prepare(
        `select ${SESSION_COLUMNS} from session_v2 where parent_id = ? order by time_created asc limit 500`,
      )
      .all(sessionID) as unknown[];
    return {
      rootID: root.id,
      parent: parentMeta ? summaryFromMeta(parentMeta) : null,
      children: childRows.map((row) => summaryFromMeta(sessionMetaFromRow(rowRecord(row)))),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Closing a read-only connection never needs to affect the caller.
    }
  }
}

export function openSqliteSource(path: string): SqliteSource {
  return new SqliteSource(path);
}
