import { eventSearchCorpus, normalizeMessages } from "./normalize.ts";
import { projectSession } from "./project.ts";
import { promptTokensMetric } from "./metrics.ts";
import { redactValue, truncate } from "./util.ts";
import { exportSession } from "./export.ts";
import type {
  Analysis,
  Coverage,
  EventFilter,
  EventIndexEntry,
  EventPage,
  ExportOptions,
  ExportResult,
  NormalizedEvent,
  ObservabilitySource,
  SessionFamily,
  SessionMeta,
  SessionSummary,
} from "./types.ts";

export class SessionNotFoundError extends Error {
  constructor(sessionID: string) {
    super(`Session not found: ${sessionID}`);
    this.name = "SessionNotFoundError";
  }
}

export class EventNotFoundError extends Error {
  constructor(eventID: string) {
    super(`Event not found: ${eventID}`);
    this.name = "EventNotFoundError";
  }
}

export interface Dataset {
  session: SessionMeta;
  family: SessionFamily;
  coverage: Coverage;
  events: NormalizedEvent[];
  analysis: Analysis;
}

interface CacheEntry {
  key: string;
  requestKey: string;
  at: number;
  sessionUpdated: number;
  dataset: Dataset;
}

export interface AnalyzeOptions {
  fromSeq?: number;
  toSeq?: number;
  reveal?: boolean;
  windowed?: boolean;
}

export interface EventsQuery extends EventFilter {
  sessionID: string;
  limit?: number;
  before?: string;
  after?: string;
  /** Event id or orderKey to center the page on (used by jump/deep links). */
  around?: string;
  direction?: "forward" | "backward";
  reveal?: boolean;
}

const CACHE_TTL_MS = 4_000;
const MAX_CACHE_ENTRIES = 8;

/**
 * Projection service shared by the HTTP server and the OpenCode 2 plugin RPC.
 * It is read-only: the source interface has no mutation methods.
 */
export class ObservabilityService {
  private readonly source: ObservabilitySource;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly redactedEvents = new WeakMap<Dataset, NormalizedEvent[]>();
  private readonly searchCorpora = new WeakMap<NormalizedEvent[], string[]>();

  constructor(source: ObservabilitySource) {
    this.source = source;
  }

  describe(): { source: ObservabilitySource["kind"]; cacheEntries: number } {
    return { source: this.source.kind, cacheEntries: this.cache.size };
  }

  async listSessions(options: {
    query?: string;
    limit?: number;
    reveal?: boolean;
  } = {}): Promise<SessionSummary[]> {
    const limit = Math.max(1, Math.min(1000, options.limit ?? 200));
    const query = options.query?.trim();
    if (options.reveal) {
      return this.source.listSessions({ query, limit });
    }
    if (!query) {
      const sessions = await this.source.listSessions({ limit });
      return redactValue(sessions) as SessionSummary[];
    }
    // Filtering in the source would run the query against unredacted columns,
    // turning match/no-match into an oracle under --no-reveal. Scan the visible
    // (redacted) set instead.
    const sessions = await this.source.listSessions({ limit: 1000 });
    const visible = redactValue(sessions) as SessionSummary[];
    const needle = query.toLowerCase();
    return visible
      .filter((session) =>
        [
          session.id,
          session.slug,
          session.title,
          session.directory,
          session.projectID,
          session.agent,
        ]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(needle)),
      )
      .slice(0, limit);
  }

  async getSession(
    sessionID: string,
    options: { reveal?: boolean } = {},
  ): Promise<{ session: SessionMeta; family: SessionFamily }> {
    const session = await this.source.getSession(sessionID);
    if (!session) throw new SessionNotFoundError(sessionID);
    const family = await this.source.getFamily(sessionID);
    if (options.reveal) return { session, family };
    return redactValue({ session, family }) as {
      session: SessionMeta;
      family: SessionFamily;
    };
  }

  async loadDataset(sessionID: string, options: AnalyzeOptions = {}): Promise<Dataset> {
    const session = await this.source.getSession(sessionID);
    if (!session) throw new SessionNotFoundError(sessionID);
    const sessionUpdated = session.time.updated ?? 0;
    const requestKey = [
      sessionUpdated,
      options.fromSeq ?? "",
      options.toSeq ?? "",
      options.windowed ? "window" : "full",
    ].join(":");
    const warm = this.cache.get(sessionID);
    if (
      warm &&
      warm.requestKey === requestKey &&
      Date.now() - warm.at < CACHE_TTL_MS
    ) {
      this.touchCache(sessionID, warm);
      return warm.dataset;
    }
    const bounds = await this.source.messageBounds(sessionID);
    const fromSeq = options.fromSeq ?? bounds.minSeq;
    const toSeq = options.toSeq ?? bounds.maxSeq;
    const key = [
      sessionUpdated,
      bounds.count,
      fromSeq,
      toSeq,
      options.windowed ? "window" : "full",
    ].join(":");
    const cached = this.cache.get(sessionID);
    if (cached && cached.key === key && Date.now() - cached.at < CACHE_TTL_MS) {
      this.touchCache(sessionID, cached);
      return cached.dataset;
    }

    const [family, messages] = await Promise.all([
      this.source.getFamily(sessionID),
      this.source.listMessages(sessionID, { fromSeq, toSeq }),
    ]);
    const coverage: Coverage = {
      fromSeq,
      toSeq,
      minSeq: bounds.minSeq,
      maxSeq: bounds.maxSeq,
      complete: fromSeq <= bounds.minSeq && toSeq >= bounds.maxSeq,
      messages: bounds.count,
      windowMessages: messages.length,
    };
    const events = normalizeMessages(messages, {
      session,
    });
    const analysis = projectSession(events, {
      session,
      family,
      coverage,
      sourceKind: this.source.kind,
      windowed: options.windowed === true,
    });
    // projectSession assigns turn ids to its own copies; mirror the assignment
    // onto the full event payload stream used by detail and list endpoints.
    const turnByEvent = new Map(
      analysis.events.map((event) => [event.id, event.turnID]),
    );
    const assignedEvents = events.map((event) => ({
      ...event,
      turnID: turnByEvent.get(event.id) ?? event.turnID,
    }));
    const dataset: Dataset = {
      session,
      family,
      coverage,
      events: assignedEvents,
      analysis,
    };
    this.cache.delete(sessionID);
    this.cache.set(sessionID, {
      key,
      requestKey,
      at: Date.now(),
      sessionUpdated,
      dataset,
    });
    this.evictCache();
    return dataset;
  }

  /** Marks a cache entry as recently used (the Map preserves insertion order). */
  private touchCache(sessionID: string, entry: CacheEntry): void {
    this.cache.delete(sessionID);
    this.cache.set(sessionID, entry);
  }

  /** Drops expired entries and keeps the dataset cache within a small bound. */
  private evictCache(): void {
    const now = Date.now();
    for (const [sessionID, entry] of this.cache) {
      if (now - entry.at >= CACHE_TTL_MS) this.cache.delete(sessionID);
    }
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private redactedFor(dataset: Dataset): NormalizedEvent[] {
    const cached = this.redactedEvents.get(dataset);
    if (cached) return cached;
    const redacted = redactValue(dataset.events) as NormalizedEvent[];
    this.redactedEvents.set(dataset, redacted);
    return redacted;
  }

  private corporaFor(events: NormalizedEvent[]): string[] {
    const cached = this.searchCorpora.get(events);
    if (cached) return cached;
    const built = events.map((event) => eventSearchCorpus(event));
    this.searchCorpora.set(events, built);
    return built;
  }

  async analyze(
    sessionID: string,
    options: AnalyzeOptions = {},
  ): Promise<{ analysis: Analysis; events: NormalizedEvent[]; redacted: boolean }> {
    const dataset = await this.loadDataset(sessionID, options);
    const reveal = options.reveal === true;
    const analysis = presentAnalysis(dataset.analysis, !reveal);
    return {
      analysis,
      events: reveal ? dataset.events : this.redactedFor(dataset),
      redacted: !reveal,
    };
  }

  async events(query: EventsQuery): Promise<EventPage> {
    const dataset = await this.loadDataset(query.sessionID, {
      reveal: query.reveal,
      windowed: false,
    });
    const reveal = query.reveal === true;
    const sanitized = reveal ? dataset.events : this.redactedFor(dataset);
    const corpora = query.q?.trim() ? this.corporaFor(sanitized) : null;
    const matched = filterEvents(sanitized, query, corpora);
    const sorted = [...matched].sort((a, b) =>
      a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0,
    );
    const limit = Math.max(1, Math.min(1000, query.limit ?? 200));
    const direction = query.direction ?? "backward";
    let start: number;
    let end: number;
    const anchor = query.around
      ? sorted.findIndex(
          (event) =>
            event.id === query.around || event.orderKey === query.around,
        )
      : -1;
    if (anchor >= 0) {
      start = Math.max(
        0,
        Math.min(sorted.length - limit, anchor - Math.floor(limit / 2)),
      );
      end = Math.min(sorted.length, start + limit);
    } else if (direction === "forward") {
      start = query.after
        ? sorted.findIndex((event) => event.orderKey > query.after!)
        : 0;
      if (start < 0) start = sorted.length;
      end = Math.min(sorted.length, start + limit);
    } else {
      end = query.before
        ? sorted.findIndex((event) => event.orderKey >= query.before!)
        : sorted.length;
      if (end < 0) end = sorted.length;
      start = Math.max(0, end - limit);
    }
    const slice = sorted.slice(start, end).map(toListEvent);
    return {
      events: slice,
      page: {
        limit,
        returned: slice.length,
        totalMatched: sorted.length,
        totalInSession: dataset.events.length,
        hasMoreBefore: start > 0,
        hasMoreAfter: end < sorted.length,
        before: slice[0]?.orderKey ?? null,
        after: slice[slice.length - 1]?.orderKey ?? null,
        direction,
      },
      coverage: dataset.coverage,
      capabilities: dataset.analysis.capabilities,
      redacted: !reveal,
    };
  }

  async eventDetail(
    sessionID: string,
    eventID: string,
    options: { reveal?: boolean } = {},
  ): Promise<NormalizedEvent> {
    const dataset = await this.loadDataset(sessionID);
    const event = dataset.events.find((item) => item.id === eventID);
    if (!event) throw new EventNotFoundError(eventID);
    return options.reveal === true
      ? event
      : (redactValue(event) as NormalizedEvent);
  }

  async export(
    sessionID: string,
    options: ExportOptions,
  ): Promise<ExportResult> {
    const dataset = await this.loadDataset(sessionID);
    const reveal = options.reveal === true;
    const analysis = reveal
      ? { ...dataset.analysis, redacted: false }
      : ({ ...(redactValue(dataset.analysis) as Analysis), redacted: true } satisfies Analysis);
    const events = reveal ? dataset.events : this.redactedFor(dataset);
    return exportSession({
      session: reveal
        ? dataset.session
        : (redactValue(dataset.session) as SessionMeta),
      analysis,
      events,
      format: options.format,
      includeEvents: options.includeEvents !== false,
      redacted: !reveal,
    });
  }

  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * The analysis endpoint returns step prose and tool previews only. Full tool
 * inputs/outputs and unbounded assistant text are available from the event
 * detail endpoint, which keeps the analysis payload small for long sessions.
 */
function presentAnalysis(analysis: Analysis, redacted: boolean): Analysis {
  const base = redacted
    ? (redactValue(analysis) as Analysis)
    : analysis;
  return {
    ...base,
    redacted,
    turns: base.turns.map((turn) => ({
      ...turn,
      steps: turn.steps.map((step) => {
        const responseText = truncate(step.responseText, 80_000);
        const reasoningText = truncate(step.reasoningText, 80_000);
        const trimmed =
          responseText.length < step.responseText.length ||
          reasoningText.length < step.reasoningText.length;
        return {
          ...step,
          responseText,
          reasoningText,
          toolCalls: step.toolCalls.map((tool) => ({
            ...tool,
            input: null,
            output: null,
            metadata: null,
          })),
          uncertainty: trimmed
            ? [...new Set([...step.uncertainty, "response-truncated-in-analysis"])]
            : step.uncertainty,
        };
      }),
    })),
  };
}

function toListEvent(event: NormalizedEvent): NormalizedEvent {
  const meta = event.meta ?? {};
  const smallMeta: Record<string, unknown> = {};
  for (const key of [
    "delegatedAgent",
    "description",
    "notice",
    "source",
    "state",
    "reason",
    "summaryChars",
    "recentChars",
    "keepID",
    "shellID",
    "exit",
    "truncated",
    "attempt",
    "previous",
    "directory",
    "projectID",
    "timestampApproximate",
  ]) {
    if (key in meta) smallMeta[key] = meta[key];
  }
  return {
    ...event,
    text: null,
    payload: null,
    tool: event.tool
      ? {
          ...event.tool,
          input: null,
          output: null,
          metadata: null,
        }
      : null,
    meta: Object.keys(smallMeta).length > 0 ? smallMeta : undefined,
  };
}

function filterEvents(
  events: readonly NormalizedEvent[],
  filter: EventFilter,
  corpora: readonly string[] | null = null,
): NormalizedEvent[] {
  const query = filter.q?.trim().toLowerCase();
  const kinds = filter.kinds?.length ? new Set(filter.kinds) : null;
  const agents = filter.agents?.length
    ? new Set(filter.agents.map((value) => value.toLowerCase()))
    : null;
  const models = filter.models?.length
    ? new Set(filter.models.map((value) => value.toLowerCase()))
    : null;
  const providers = filter.providers?.length
    ? new Set(filter.providers.map((value) => value.toLowerCase()))
    : null;
  const tools = filter.tools?.length
    ? new Set(filter.tools.map((value) => value.toLowerCase()))
    : null;
  const statuses = filter.statuses?.length
    ? new Set(filter.statuses.map((value) => value.toLowerCase()))
    : null;

  return events.filter((event, index) => {
    if (kinds && !kinds.has(event.kind)) return false;
    if (agents) {
      const values = [
        event.agent,
        typeof event.meta?.delegatedAgent === "string"
          ? event.meta.delegatedAgent
          : null,
      ]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase());
      if (!values.some((value) => agents.has(value))) return false;
    }
    if (models) {
      const value = event.model
        ? `${event.model.providerID}/${event.model.id}`.toLowerCase()
        : "";
      if (![...models].some((candidate) => value === candidate || value.endsWith(`/${candidate}`))) {
        return false;
      }
    }
    if (providers) {
      const value = event.provider?.toLowerCase() ?? "";
      if (!providers.has(value)) return false;
    }
    if (tools) {
      const value = event.tool?.name.toLowerCase() ?? "";
      if (!tools.has(value)) return false;
    }
    if (statuses) {
      const value = (event.tool?.status ?? event.status ?? "").toLowerCase();
      if (!statuses.has(value)) return false;
    }
    if (filter.errorsOnly && !event.flags.error) return false;
    if (filter.retriesOnly && event.kind !== "retry") return false;
    if (filter.compactionsOnly && event.kind !== "compaction") return false;
    if (filter.subagentsOnly && !event.flags.subagent) return false;
    if (filter.contextOnly && !event.flags.context) return false;
    if (filter.from !== undefined && event.timestamp < filter.from) return false;
    if (filter.to !== undefined && event.timestamp > filter.to) return false;
    if (
      filter.minPromptTokens !== undefined ||
      filter.maxPromptTokens !== undefined
    ) {
      const prompt = promptTokensMetric(event.tokens).value;
      if (prompt === null) return false;
      if (
        filter.minPromptTokens !== undefined &&
        prompt < filter.minPromptTokens
      ) {
        return false;
      }
      if (
        filter.maxPromptTokens !== undefined &&
        prompt > filter.maxPromptTokens
      ) {
        return false;
      }
    }
    if (query) {
      const corpus = corpora ? corpora[index]! : eventSearchCorpus(event);
      if (!corpus.includes(query)) return false;
    }
    return true;
  });
}

export type { EventIndexEntry };
