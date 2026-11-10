import { eventSearchCorpus, normalizeMessages } from "./normalize.ts";
import { projectSession } from "./project.ts";
import { promptTokensMetric } from "./metrics.ts";
import { evaluateDiagnostics } from "./diagnostics.ts";
import { redactValue, truncate } from "./util.ts";
import { exportSession } from "./export.ts";
import { listDiagnosticEpisodes } from "./episodes.ts";
import { compareEpisodeData } from "./episodeCompare.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { DiagnosticEpisode } from "./episodes.ts";
import type {
  AttemptSummary,
  EpisodeCompareInput,
  EpisodeComparison,
  EpisodeTotals,
  TurnSummary,
} from "./episodeCompare.ts";
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
  Totals,
  Turn,
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

export class EpisodeNotFoundError extends Error {
  constructor(episodeID: string) {
    super(`Episode not found: ${episodeID}`);
    this.name = "EpisodeNotFoundError";
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
    // Diagnostics are engine-owned and pure: compute them exactly once here,
    // against the full recorded-order event stream of this dataset, so every
    // downstream path (analysis, export, UI) reads the same object verbatim.
    // Sessions without incidents keep the field absent instead of an empty
    // placeholder, letting the UI render its empty state.
    const diagnostics = evaluateDiagnostics(assignedEvents, analysis);
    if (diagnostics.incidents.length > 0) {
      analysis.diagnostics = diagnostics;
    }
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

  /** Diagnostics over the stream the caller is allowed to see. */
  private diagnosticsFor(dataset: Dataset, reveal: boolean): Diagnostics {
    const events = reveal ? dataset.events : this.redactedFor(dataset);
    return evaluateDiagnostics(events, dataset.analysis);
  }

  /**
   * Resolves one side of a comparison. The episode is re-derived from the same
   * event stream that supplies its attempts, so an unknown id always fails
   * instead of matching a stale incident.
   */
  private episodeSide(
    dataset: Dataset,
    sessionID: string,
    episodeID: string,
    reveal: boolean,
  ): EpisodeCompareInput {
    const events = reveal ? dataset.events : this.redactedFor(dataset);
    const diagnostics = this.diagnosticsFor(dataset, reveal);
    const episode = listDiagnosticEpisodes(diagnostics, sessionID).find(
      (item) => item.id === episodeID,
    );
    if (!episode) throw new EpisodeNotFoundError(episodeID);

    const byID = new Map(events.map((event) => [event.id, event]));
    const attempts: AttemptSummary[] = [];
    for (const eventID of episode.failureEventIDs) {
      const attempt = attemptFor(byID, eventID);
      if (!attempt) throw new EpisodeNotFoundError(episodeID);
      attempts.push(attempt);
    }
    const recovery =
      episode.recoveryEventID === null
        ? null
        : attemptFor(byID, episode.recoveryEventID);

    const turn = dataset.analysis.turns.find(
      (item) => item.id === episode.turnID,
    );
    if (!turn) throw new EpisodeNotFoundError(episodeID);
    return {
      episode,
      attempts,
      recovery,
      totals: totalsSubset(dataset.analysis.totals),
      turn: turnSubset(turn),
      redacted: !reveal,
    };
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

  /**
   * Diagnostics plus the episodes derived from them.
   *
   * Without `reveal: true` the rule runs on the redacted event stream, so an
   * input that was credential-redacted classifies as `"redacted"` instead of
   * being silently reported as comparable. Episodes are a pure projection of
   * the same diagnostics; their ids are identical in both modes because event
   * ids are not payload data.
   */
  async diagnostics(
    sessionID: string,
    options: { reveal?: boolean } = {},
  ): Promise<{
    diagnostics: Diagnostics;
    episodes: DiagnosticEpisode[];
    redacted: boolean;
  }> {
    const dataset = await this.loadDataset(sessionID);
    const reveal = options.reveal === true;
    const diagnostics = this.diagnosticsFor(dataset, reveal);
    return {
      diagnostics,
      episodes: listDiagnosticEpisodes(diagnostics, sessionID),
      redacted: !reveal,
    };
  }

  /**
   * Aligns two episodes by recorded ordinal, or throws when either id does not
   * name an episode of its session. Inputs come from the raw dataset under
   * reveal and from the redacted event stream otherwise; totals and turn
   * metrics are the structural numeric subsets of `Analysis`.
   */
  async compareEpisodes(input: {
    leftSessionID: string;
    leftEpisodeID: string;
    rightSessionID: string;
    rightEpisodeID: string;
    reveal?: boolean;
  }): Promise<EpisodeComparison> {
    const reveal = input.reveal === true;
    const datasets = new Map<string, Dataset>();
    const load = async (sessionID: string): Promise<Dataset> => {
      const warm = datasets.get(sessionID);
      if (warm) return warm;
      const dataset = await this.loadDataset(sessionID);
      datasets.set(sessionID, dataset);
      return dataset;
    };
    const leftDataset = await load(input.leftSessionID);
    const rightDataset = await load(input.rightSessionID);
    return compareEpisodeData(
      this.episodeSide(
        leftDataset,
        input.leftSessionID,
        input.leftEpisodeID,
        reveal,
      ),
      this.episodeSide(
        rightDataset,
        input.rightSessionID,
        input.rightEpisodeID,
        reveal,
      ),
    );
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

/**
 * Reads one attempt off the resolved event stream. Under no reveal the stream
 * is already redacted, so the input here is the redacted value: the comparison
 * layer classifies it as `"redacted"` rather than assuming it is comparable.
 */
function attemptFor(
  events: ReadonlyMap<string, NormalizedEvent>,
  eventID: string,
): AttemptSummary | null {
  const tool = events.get(eventID)?.tool;
  if (!tool) return null;
  return {
    eventID,
    tool: tool.name,
    status: tool.status,
    input: tool.input,
    duration: tool.duration,
  };
}

/** The numeric totals subset `compareEpisodeData` accepts. */
function totalsSubset(totals: Totals): EpisodeTotals {
  return {
    tokens: totals.tokens,
    tokensComplete: totals.tokensComplete,
    cost: totals.cost,
    modelTime: totals.modelTime,
    toolTime: totals.toolTime,
    // Session scope has no single span: the idle-free aggregate of turn spans
    // is the same quantity family as a turn's `totalTime`, whereas wall clock
    // would add inter-turn idle to an episode-scoped comparison.
    totalTime: totals.activeTurnTime,
    outputSpeed: totals.outputSpeed,
    cacheHitRate: totals.cacheHitRate,
  };
}

/** The numeric turn subset `compareEpisodeData` accepts. */
function turnSubset(turn: Turn): TurnSummary {
  return {
    tokens: turn.tokens,
    tokensComplete: turn.tokensComplete,
    cost: turn.cost,
    modelTime: turn.modelTime,
    toolTime: turn.toolTime,
    totalTime: turn.totalTime,
    outputSpeed: turn.outputSpeed,
    cacheHitRate: turn.cacheHitRate,
    index: turn.index,
    promptTokensLatest: turn.promptTokensLatest,
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
