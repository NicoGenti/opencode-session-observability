/**
 * Normalized, storage-agnostic model for OpenCode 2 session observability.
 *
 * The UI and the metrics layer consume these types only. Adapters (SQLite,
 * OpenCode server API, JSONL fixtures) are responsible for producing
 * `RawMessage` values; nothing below this line is coupled to a storage
 * format.
 */

export type Basis = "measured" | "derived" | "estimated" | "unavailable";

/** A number plus the epistemic status of that number. */
export interface Metric {
  value: number | null;
  basis: Basis;
  note?: string;
}

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenUsagePartial {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** One persisted OpenCode message, before type-specific interpretation. */
export interface RawMessage {
  id: string;
  sessionID: string;
  type: string;
  /** Recorded per-session sequence. For API sources without seq, the position. */
  seq: number;
  /** True when `seq` was synthesized from array position (API source). */
  seqSynthetic?: boolean;
  timeCreated: number;
  timeUpdated?: number;
  /** The message body, already parsed. Shape depends on `type`. */
  data: unknown;
}

export interface SessionMeta {
  id: string;
  parentID?: string;
  fork?: {
    sessionID: string;
    boundary?: unknown;
  };
  projectID?: string;
  title?: string;
  directory?: string;
  agent?: string;
  model?: ModelRef;
  cost?: number;
  tokens?: TokenUsage;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: {
    created: number;
    updated?: number;
    busy?: number;
    idle?: number;
    archived?: number;
  };
  revert?: unknown;
  resumeAttempts?: number;
  suspendedAt?: number;
  version?: string;
  slug?: string;
}

export interface SessionSummary {
  id: string;
  parentID?: string;
  title?: string;
  directory?: string;
  agent?: string;
  model?: ModelRef;
  timeCreated: number;
  timeUpdated?: number;
  cost?: number;
  tokens?: TokenUsage;
  outcome?: "succeeded" | "failed" | "interrupted";
  messageCount?: number;
  lastMessageAt?: number;
}

export interface SessionFamily {
  rootID: string;
  parent: SessionSummary | null;
  children: SessionSummary[];
}

export type EventKind =
  | "session"
  | "user"
  | "assistant"
  | "reasoning"
  | "text"
  | "tool"
  | "synthetic"
  | "system"
  | "skill"
  | "shell"
  | "compaction"
  | "agent-switched"
  | "model-switched"
  | "location-switched"
  | "idle"
  | "retry"
  | "error"
  | "permission"
  | "unknown";

export type EventActor =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "session"
  | "subagent"
  | "unknown";

export interface ToolError {
  type: string;
  message: string;
  status?: number;
  retryAfterMs?: number;
}

export type ToolStatus =
  | "streaming"
  | "running"
  | "completed"
  | "error"
  | "unknown";

export interface ToolCallDetail {
  callID: string;
  name: string;
  status: ToolStatus;
  input: unknown;
  inputPreview: string;
  output: string | null;
  outputPreview: string | null;
  error: ToolError | null;
  metadata: Record<string, unknown> | null;
  createdAt: number | null;
  ranAt: number | null;
  completedAt: number | null;
  duration: Metric;
  childSessionIDs: string[];
  executed: boolean | null;
  outputTruncated?: boolean;
}

export interface EventFlags {
  error: boolean;
  retry: boolean;
  compaction: boolean;
  context: boolean;
  subagent: boolean;
  approval: boolean;
  uncertain: boolean;
}

export interface NormalizedEvent {
  id: string;
  messageID: string;
  sessionID: string;
  seq: number;
  /** Message-level = -1, otherwise the content-block index. */
  order: number;
  /** Stable lexicographic ordering key: `<seq>:<order>`. */
  orderKey: string;
  timestamp: number;
  endTimestamp: number | null;
  kind: EventKind;
  actor: EventActor;
  title: string;
  text: string | null;
  textPreview: string | null;
  agent: string | null;
  model: ModelRef | null;
  provider: string | null;
  status: string | null;
  tool: ToolCallDetail | null;
  tokens: TokenUsage | null;
  cost: number | null;
  stepID: string | null;
  turnID: string | null;
  flags: EventFlags;
  uncertainty: string[];
  /** Redacted-by-caller source payload, used only by detail endpoints. */
  payload: unknown;
  meta?: Record<string, unknown>;
}

/** Compact event row returned by analysis endpoints (no payloads). */
export interface EventIndexEntry {
  id: string;
  messageID: string;
  sessionID: string;
  seq: number;
  orderKey: string;
  timestamp: number;
  kind: EventKind;
  actor: EventActor;
  title: string;
  preview: string;
  agent: string | null;
  model: ModelRef | null;
  provider: string | null;
  status: string | null;
  toolName: string | null;
  toolStatus: ToolStatus | null;
  tokens: TokenUsage | null;
  cost: number | null;
  stepID: string | null;
  turnID: string | null;
  flags: EventFlags;
  uncertainty: string[];
}

export type TurnTriggerKind =
  | "user"
  | "synthetic"
  | "delegation"
  | "retry"
  | "resume"
  | "orphan";

export interface TurnTrigger {
  kind: TurnTriggerKind;
  eventID: string | null;
  label: string;
}

export type TurnStatus =
  | "completed"
  | "interrupted"
  | "error"
  | "running"
  | "incomplete"
  | "unknown";

export type StepStatus =
  | "completed"
  | "error"
  | "interrupted"
  | "running"
  | "incomplete"
  | "unknown";

export interface Step {
  id: string;
  turnID: string;
  index: number;
  /** Projected trigger, e.g. "User message" or "After tool results". */
  trigger: string;
  startTime: number;
  endTime: number | null;
  startUnknown: boolean;
  agent: string | null;
  model: ModelRef | null;
  provider: string | null;
  finish: string | null;
  toolNames: string[];
  toolCalls: ToolCallDetail[];
  tokens: TokenUsage | null;
  cost: number | null;
  promptTokens: Metric;
  cacheHitRate: Metric;
  /** OpenCode 2 does not persist a first-token timestamp. Always unavailable. */
  ttft: Metric;
  modelTime: Metric;
  toolTime: Metric;
  totalTime: Metric;
  residualTime: Metric;
  outputSpeed: Metric;
  status: StepStatus;
  subagentSessionIDs: string[];
  eventIDs: string[];
  responseText: string;
  reasoningText: string;
  uncertainty: string[];
}

export interface Turn {
  id: string;
  index: number;
  trigger: TurnTrigger;
  startTime: number;
  endTime: number | null;
  status: TurnStatus;
  steps: Step[];
  eventIDs: string[];
  nonStepEventIDs: string[];
  firstStepStart: number | null;
  lastStepEnd: number | null;
  tokens: TokenUsage;
  tokensComplete: boolean;
  promptTokensLatest: Metric;
  promptTokensCumulative: Metric;
  cacheHitRate: Metric;
  contextDelta: Metric;
  cost: Metric;
  modelTime: Metric;
  toolTime: Metric;
  totalTime: Metric;
  residualTime: Metric;
  outputSpeed: Metric;
  uncertainty: string[];
}

export interface CompactionTransaction {
  eventID: string;
  turnID: string | null;
  timestamp: number;
  status: string;
  reason: string | null;
  model: ModelRef | null;
  provider: string | null;
  tokens: TokenUsage | null;
  cost: number | null;
  summaryChars: number;
  summaryPreview: string;
  contextBefore: Metric;
  contextAfter: Metric;
  contextDelta: Metric;
  removedTokens: Metric;
  duration: Metric;
  uncertainty: string[];
}

export interface ErrorCounts {
  total: number;
  tool: number;
  step: number;
  session: number;
}

export interface Totals {
  scope: "session" | "window";
  turns: number;
  steps: number;
  toolCalls: number;
  subagentCalls: number;
  errors: ErrorCounts;
  retries: number;
  compactions: number;
  tokens: TokenUsage;
  tokensComplete: boolean;
  stepTokens: TokenUsage;
  compactionTokens: TokenUsage;
  cacheHitRate: Metric;
  cost: Metric;
  modelTime: Metric;
  toolTime: Metric;
  activeTurnTime: Metric;
  wallClockTime: Metric;
  outputSpeed: Metric;
  finalContext: Metric;
  cumulativePrompt: Metric;
  /** Totals as stored on the OpenCode session row, when available. */
  recorded?: {
    tokens?: TokenUsage;
    cost?: number;
    note: string;
  };
}

export interface Coverage {
  fromSeq: number;
  toSeq: number;
  minSeq: number;
  maxSeq: number;
  complete: boolean;
  messages: number;
  windowMessages: number;
}

export interface Capabilities {
  source: "sqlite" | "api" | "jsonl";
  ttft: boolean;
  approvals: boolean;
  requestHeaders: boolean;
  toolSetChanges: boolean;
  tokenUsage: boolean;
  reasoning: boolean;
  cacheUsage: boolean;
  cost: boolean;
  retries: boolean;
  compactions: boolean;
  subagents: boolean;
  contextNotices: boolean;
  modelSwitches: boolean;
  routeChanges: boolean;
  forkResumeMarkers: boolean;
  toolDurations: boolean;
  promptTokenBreakdown: string;
  notes: string[];
}

export interface Analysis {
  version: 1;
  session: SessionMeta;
  family: SessionFamily;
  capabilities: Capabilities;
  coverage: Coverage;
  events: EventIndexEntry[];
  turns: Turn[];
  compactions: CompactionTransaction[];
  totals: Totals;
  unattachedEventIDs: string[];
  generatedAt: number;
  redacted: boolean;
}

export interface EventPage {
  events: NormalizedEvent[];
  page: {
    limit: number;
    returned: number;
    totalMatched: number;
    totalInSession: number;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    before: string | null;
    after: string | null;
    direction: "forward" | "backward";
  };
  coverage: Coverage;
  capabilities: Capabilities;
  redacted: boolean;
}

export interface EventFilter {
  q?: string;
  kinds?: EventKind[];
  agents?: string[];
  models?: string[];
  providers?: string[];
  tools?: string[];
  statuses?: string[];
  errorsOnly?: boolean;
  retriesOnly?: boolean;
  compactionsOnly?: boolean;
  subagentsOnly?: boolean;
  contextOnly?: boolean;
  from?: number;
  to?: number;
  minPromptTokens?: number;
  maxPromptTokens?: number;
}

export interface EventQuery extends EventFilter {
  sessionID: string;
  limit?: number;
  before?: string;
  after?: string;
  direction?: "forward" | "backward";
  reveal?: boolean;
}

export interface ExportOptions {
  format: "json" | "markdown" | "html";
  reveal?: boolean;
  includeEvents?: boolean;
}

export interface ExportResult {
  filename: string;
  mime: string;
  content: string;
  redacted: boolean;
}

export interface ObservabilitySource {
  readonly kind: "sqlite" | "api" | "jsonl";
  listSessions(options?: { query?: string; limit?: number }): Promise<SessionSummary[]>;
  getSession(sessionID: string): Promise<SessionMeta | null>;
  listMessages(sessionID: string, options?: { fromSeq?: number; toSeq?: number }): Promise<RawMessage[]>;
  getFamily(sessionID: string): Promise<SessionFamily>;
  messageBounds(sessionID: string): Promise<{ minSeq: number; maxSeq: number; count: number }>;
  close?(): void;
}

export const EMPTY_TOKENS: TokenUsage = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const UNAVAILABLE: Metric = { value: null, basis: "unavailable" };

export function metric(
  value: number | null,
  basis: Basis,
  note?: string,
): Metric {
  return value === null || !Number.isFinite(value)
    ? note
      ? { value: null, basis: "unavailable", note }
      : { value: null, basis: "unavailable" }
    : note
      ? { value, basis, note }
      : { value, basis };
}
