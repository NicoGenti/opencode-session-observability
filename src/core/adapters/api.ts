import type {
  ObservabilitySource,
  RawMessage,
  SessionFamily,
  SessionMeta,
  SessionSummary,
} from "../types.ts";
import {
  asArray,
  asRecord,
  normalizeModel,
  normalizeTokens,
  num,
  str,
} from "../util.ts";

export interface ApiClientLike {
  session: {
    list: (...args: any[]) => Promise<unknown>;
    get: (...args: any[]) => Promise<unknown>;
    context: (...args: any[]) => Promise<unknown>;
  };
}

export interface ApiSourceOptions {
  /** Cache lifetime for the session list. Defaults to 2000 ms. */
  cacheTtlMs?: number;
}

function unwrapData(value: unknown): unknown {
  const record = asRecord(value);
  if ("data" in record) return record.data;
  return value;
}

function apiSessionMeta(value: unknown): SessionMeta | null {
  const info = asRecord(unwrapData(value));
  const id = str(info.id);
  if (!id) return null;
  const time = asRecord(info.time);
  const location = asRecord(info.location);
  const meta: SessionMeta = {
    id,
    time: {
      created: num(time.created) ?? 0,
      ...(num(time.updated) !== null ? { updated: num(time.updated)! } : {}),
      ...(num(time.busy) !== null ? { busy: num(time.busy)! } : {}),
      ...(num(time.idle) !== null ? { idle: num(time.idle)! } : {}),
      ...(num(time.archived) !== null ? { archived: num(time.archived)! } : {}),
    },
  };
  const parentID = str(info.parentID);
  if (parentID) meta.parentID = parentID;
  const fork = asRecord(info.fork);
  const forkSessionID = str(fork.sessionID);
  if (forkSessionID) {
    meta.fork = {
      sessionID: forkSessionID,
      ...(fork.boundary !== undefined ? { boundary: fork.boundary } : {}),
    };
  }
  const projectID = str(info.projectID);
  if (projectID) meta.projectID = projectID;
  const title = str(info.title);
  if (title) meta.title = title;
  const directory = str(location.directory);
  if (directory) meta.directory = directory;
  const agent = str(info.agent);
  if (agent) meta.agent = agent;
  const model = normalizeModel(info.model);
  if (model) meta.model = model;
  const cost = num(info.cost);
  if (cost !== null) meta.cost = cost;
  const tokens = normalizeTokens(info.tokens);
  if (tokens) meta.tokens = tokens;
  const outcome = str(info.outcome);
  if (outcome === "succeeded" || outcome === "failed" || outcome === "interrupted") {
    meta.outcome = outcome;
  }
  if (info.revert !== undefined && info.revert !== null) meta.revert = info.revert;
  return meta;
}

function summary(meta: SessionMeta): SessionSummary {
  return {
    id: meta.id,
    ...(meta.parentID ? { parentID: meta.parentID } : {}),
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

/**
 * Converts the OpenCode 2 API message array into the storage-neutral raw
 * shape. The API does not expose `seq`; array position is used and flagged as
 * synthesized.
 */
export function apiMessagesToRaw(
  sessionID: string,
  value: unknown,
): RawMessage[] {
  const messages = unwrapData(value);
  return asArray<Record<string, unknown>>(messages).map((message, index) => {
    const time = asRecord(message.time);
    const created = num(time.created) ?? 0;
    return {
      id: str(message.id) ?? `api-message-${index}`,
      sessionID,
      type: str(message.type) ?? "unknown",
      seq: index,
      seqSynthetic: true,
      timeCreated: created,
      ...(num(time.completed) !== null ? { timeUpdated: num(time.completed)! } : {}),
      data: message,
    };
  });
}

/**
 * Source over the OpenCode 2 server API. The plugin's context is a server
 * client, so `ctx` can be passed directly (structurally) to this adapter.
 */
export class ApiSource implements ObservabilitySource {
  readonly kind = "api" as const;
  private readonly client: ApiClientLike;
  private readonly cacheTtlMs: number;
  private cachedSessions: { at: number; sessions: SessionMeta[] } | null = null;
  private readonly cachedMessages = new Map<
    string,
    { at: number; messages: RawMessage[] }
  >();

  constructor(client: ApiClientLike, options: ApiSourceOptions = {}) {
    this.client = client;
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000;
  }

  private async rawSessions(): Promise<SessionMeta[]> {
    if (
      this.cachedSessions &&
      Date.now() - this.cachedSessions.at < this.cacheTtlMs
    ) {
      return this.cachedSessions.sessions;
    }
    const value = await this.client.session.list();
    const sessions = asArray(unwrapData(value))
      .map(apiSessionMeta)
      .filter((item): item is SessionMeta => item !== null);
    this.cachedSessions = { at: Date.now(), sessions };
    return sessions;
  }

  async listSessions(
    options: { query?: string; limit?: number } = {},
  ): Promise<SessionSummary[]> {
    const query = options.query?.trim().toLowerCase();
    return (await this.rawSessions())
      .filter((session) => {
        if (!query) return true;
        return [session.title, session.directory, session.id, session.agent]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(query));
      })
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, Math.max(1, Math.min(1000, options.limit ?? 100)))
      .map(summary);
  }

  async getSession(sessionID: string): Promise<SessionMeta | null> {
    try {
      const value = await this.client.session.get({ sessionID });
      const meta = apiSessionMeta(value);
      if (meta) return meta;
    } catch {
      // Fall through to the list, which may still contain the session.
    }
    return (await this.rawSessions()).find((session) => session.id === sessionID) ?? null;
  }

  private async allMessages(sessionID: string): Promise<RawMessage[]> {
    const cached = this.cachedMessages.get(sessionID);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.messages;
    }
    const value = await this.client.session.context({ sessionID });
    const messages = apiMessagesToRaw(sessionID, value);
    this.cachedMessages.set(sessionID, { at: Date.now(), messages });
    return messages;
  }

  async listMessages(
    sessionID: string,
    options: { fromSeq?: number; toSeq?: number } = {},
  ): Promise<RawMessage[]> {
    const messages = await this.allMessages(sessionID);
    return messages.filter(
      (message) =>
        (options.fromSeq === undefined || message.seq >= options.fromSeq) &&
        (options.toSeq === undefined || message.seq <= options.toSeq),
    );
  }

  async messageBounds(
    sessionID: string,
  ): Promise<{ minSeq: number; maxSeq: number; count: number }> {
    const messages = await this.allMessages(sessionID);
    if (messages.length === 0) return { minSeq: 0, maxSeq: 0, count: 0 };
    return {
      minSeq: messages[0]!.seq,
      maxSeq: messages[messages.length - 1]!.seq,
      count: messages.length,
    };
  }

  async getFamily(sessionID: string): Promise<SessionFamily> {
    const sessions = await this.rawSessions();
    const session = sessions.find((item) => item.id === sessionID);
    if (!session) return { rootID: sessionID, parent: null, children: [] };
    const chain: SessionMeta[] = [];
    const seen = new Set<string>();
    let cursor: SessionMeta | null = session;
    while (cursor && !seen.has(cursor.id) && chain.length < 64) {
      seen.add(cursor.id);
      chain.push(cursor);
      cursor = cursor.parentID
        ? sessions.find((item) => item.id === cursor!.parentID) ?? null
        : null;
    }
    const root = chain[chain.length - 1] ?? session;
    const parent = chain.length > 1 ? chain[1] ?? null : null;
    const children = sessions
      .filter((item) => item.parentID === sessionID)
      .sort((a, b) => a.time.created - b.time.created)
      .map(summary);
    return {
      rootID: root.id,
      parent: parent ? summary(parent) : null,
      children,
    };
  }
}
