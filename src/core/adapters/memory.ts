import type {
  ObservabilitySource,
  RawMessage,
  SessionFamily,
  SessionMeta,
  SessionSummary,
} from "../types.ts";

export interface MemorySourceOptions {
  sessions: SessionMeta[];
  messages: Map<string, RawMessage[]>;
  kind?: "api" | "jsonl" | "sqlite";
}

function summary(session: SessionMeta): SessionSummary {
  return {
    id: session.id,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    ...(session.projectID ? { projectID: session.projectID } : {}),
    ...(session.slug ? { slug: session.slug } : {}),
    ...(session.title ? { title: session.title } : {}),
    ...(session.directory ? { directory: session.directory } : {}),
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.model ? { model: session.model } : {}),
    timeCreated: session.time.created,
    ...(session.time.updated ? { timeUpdated: session.time.updated } : {}),
    ...(session.cost !== undefined ? { cost: session.cost } : {}),
    ...(session.tokens ? { tokens: session.tokens } : {}),
    ...(session.outcome ? { outcome: session.outcome } : {}),
  };
}

/** In-memory source used by tests and by callers that already hold messages. */
export class MemorySource implements ObservabilitySource {
  readonly kind: "api" | "jsonl" | "sqlite";
  private readonly sessions: SessionMeta[];
  private readonly messages: Map<string, RawMessage[]>;

  constructor(options: MemorySourceOptions) {
    this.kind = options.kind ?? "jsonl";
    this.sessions = options.sessions;
    this.messages = options.messages;
  }

  async listSessions(
    options: { query?: string; limit?: number } = {},
  ): Promise<SessionSummary[]> {
    const query = options.query?.trim().toLowerCase();
    const filtered = this.sessions.filter((session) => {
      if (!query) return true;
      return [session.title, session.directory, session.id, session.agent, session.slug]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(query));
    });
    return filtered
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, Math.max(1, Math.min(1000, options.limit ?? 100)))
      .map(summary);
  }

  async getSession(sessionID: string): Promise<SessionMeta | null> {
    return this.sessions.find((session) => session.id === sessionID) ?? null;
  }

  async listMessages(
    sessionID: string,
    options: { fromSeq?: number; toSeq?: number } = {},
  ): Promise<RawMessage[]> {
    const messages = [...(this.messages.get(sessionID) ?? [])].sort((a, b) => a.seq - b.seq);
    return messages.filter(
      (message) =>
        (options.fromSeq === undefined || message.seq >= options.fromSeq) &&
        (options.toSeq === undefined || message.seq <= options.toSeq),
    );
  }

  async messageBounds(
    sessionID: string,
  ): Promise<{ minSeq: number; maxSeq: number; count: number }> {
    const messages = this.messages.get(sessionID) ?? [];
    if (messages.length === 0) return { minSeq: 0, maxSeq: 0, count: 0 };
    const seqs = messages.map((message) => message.seq);
    return {
      minSeq: Math.min(...seqs),
      maxSeq: Math.max(...seqs),
      count: messages.length,
    };
  }

  async getFamily(sessionID: string): Promise<SessionFamily> {
    const session = await this.getSession(sessionID);
    if (!session) return { rootID: sessionID, parent: null, children: [] };
    const chain: SessionMeta[] = [];
    const seen = new Set<string>();
    let cursor: SessionMeta | null = session;
    while (cursor && !seen.has(cursor.id) && chain.length < 64) {
      seen.add(cursor.id);
      chain.push(cursor);
      cursor = cursor.parentID
        ? this.sessions.find((item) => item.id === cursor!.parentID) ?? null
        : null;
    }
    const root = chain[chain.length - 1] ?? session;
    const parent = chain.length > 1 ? chain[1] ?? null : null;
    const children = this.sessions
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
