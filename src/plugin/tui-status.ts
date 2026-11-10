import {
  baseUrl,
  pluginToken,
  reachable,
  tokenFromFile,
  type Reachability,
} from "./tui-net.ts";

/**
 * Status badge seam (issue #9, phase 3).
 *
 * The `prompt.footer.status` slot is owned by sibling issue #6; this module only
 * owns the pure presentation and the cached data fetch the slot will call. It is
 * pure `.ts`: no JSX, no `@opentui/*`. Every failure path resolves to `null`
 * data, and nothing here shows a toast or writes to the session.
 */

/** The badge text shown when a value is missing or out of its domain. */
const NOT_AVAILABLE = "n/a";

/** Field separator: one space, U+00B7 MIDDLE DOT, one space. */
const SEPARATOR = " \u00b7 ";

/** Minimum cache lifetime for one session's analysis-derived cache hit rate. */
const MIN_TTL_MS = 15_000;

/** One session's analysis fetch outcome, cached for the TTL. */
export type SessionStatus = {
  readonly cost: number | null;
  readonly cacheHitRate: number | null;
};

/** The slice of the TUI plugin context this seam reads. */
export type StatusContext = {
  readonly options: Readonly<Record<string, unknown>>;
  readonly data: {
    readonly session: {
      cost(sessionID: string): number;
    };
  };
};

/** Test seams: inject the fetch/clock so no test needs a network or a timer. */
export type SessionStatusOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly health?: (url: string) => Promise<Reachability>;
};

type CacheEntry = {
  readonly cacheHitRate: number | null;
  readonly expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<number | null>>();

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatCost(cost: number | null): string {
  return isFiniteNumber(cost) ? `$${cost.toFixed(2)}` : NOT_AVAILABLE;
}

function formatCacheHitRate(rate: number | null): string {
  if (!isFiniteNumber(rate) || rate < 0 || rate > 1) return NOT_AVAILABLE;
  return `${Math.round(rate * 100)}%`;
}

/**
 * Formats the one-line status badge: `"$0.12 · cache 38%"`. A missing,
 * non-finite or out-of-domain value renders `n/a` for that field only.
 */
export function formatStatusBadge(input: {
  cost: number | null;
  cacheHitRate: number | null;
}): string {
  return `${formatCost(input.cost)}${SEPARATOR}cache ${formatCacheHitRate(
    input.cacheHitRate,
  )}`;
}

function sessionCost(context: StatusContext, sessionID: string): number | null {
  try {
    const session = context.data.session;
    if (!session || typeof session.cost !== "function") return null;
    const cost = session.cost(sessionID);
    return isFiniteNumber(cost) ? cost : null;
  } catch {
    return null;
  }
}

/** Reads `analysis.totals.cacheHitRate.value`, rejecting anything off-domain. */
function parseCacheHitRate(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const analysis = (body as { analysis?: unknown }).analysis;
  if (!analysis || typeof analysis !== "object") return null;
  const totals = (analysis as { totals?: unknown }).totals;
  if (!totals || typeof totals !== "object") return null;
  const metric = (totals as { cacheHitRate?: unknown }).cacheHitRate;
  if (!metric || typeof metric !== "object") return null;
  const value = (metric as { value?: unknown }).value;
  if (!isFiniteNumber(value) || value < 0 || value > 1) return null;
  return value;
}

function resolveTtl(ttlMs: number | undefined): number {
  return isFiniteNumber(ttlMs) ? Math.max(MIN_TTL_MS, ttlMs) : MIN_TTL_MS;
}

/**
 * Probes health, then reads one analysis response. Resolves to the cache hit
 * rate, or `null` for every failure shape (offline, auth gap, non-2xx,
 * unparsable body). Never rejects.
 */
async function loadCacheHitRate(
  context: StatusContext,
  sessionID: string,
  options: SessionStatusOptions,
): Promise<number | null> {
  const fetchImpl = options.fetch ?? fetch;
  const base = baseUrl(context.options.url);
  const probe = options.health ?? ((url: string) => reachable(url, fetchImpl));

  let status: Reachability;
  try {
    status = await probe(base);
  } catch {
    return null;
  }
  if (status === "down") return null;

  let token: string | null = null;
  if (status === "auth") {
    try {
      token = pluginToken(context.options.token) ?? (await tokenFromFile(base));
    } catch {
      return null;
    }
    // The server compares every data route, so a missing token is a known 401.
    if (!token) return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetchImpl(
        `${base}/api/sessions/${encodeURIComponent(sessionID)}/analysis`,
        { headers, signal: controller.signal },
      );
      if (!response.ok) return null;
      const body: unknown = await response.json().catch(() => null);
      return parseCacheHitRate(body);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Returns the current session's cost and cache hit rate for the status badge.
 * The cost comes from the SDK (`context.data.session.cost`); the cache hit rate
 * comes from the local analysis route and is cached per session for at least
 * 15 s, with one in-flight request shared by concurrent callers. Negative
 * results are cached the same way. Never throws and never toasts.
 *
 * A missing or blank session id yields no data and touches neither the cache nor
 * the network: there is nothing to key on and nothing to probe.
 */
export async function fetchSessionStatus(
  context: StatusContext,
  sessionID: string,
  options: SessionStatusOptions = {},
): Promise<SessionStatus> {
  if (typeof sessionID !== "string" || sessionID.trim().length === 0) {
    return { cost: null, cacheHitRate: null };
  }

  const cost = sessionCost(context, sessionID);
  const now = options.now ?? Date.now;
  const ttl = resolveTtl(options.ttlMs);

  const cached = cache.get(sessionID);
  if (cached) {
    if (cached.expiresAt > now()) {
      return { cost, cacheHitRate: cached.cacheHitRate };
    }
    // Housekeeping on the expired-miss path: drop the stale entry before the
    // refresh starts, so an expired value is never held while its replacement is
    // in flight (or abandoned).
    cache.delete(sessionID);
  }

  let pending = inflight.get(sessionID);
  if (!pending) {
    pending = loadCacheHitRate(context, sessionID, options)
      .then((cacheHitRate) => {
        cache.set(sessionID, { cacheHitRate, expiresAt: now() + ttl });
        return cacheHitRate;
      })
      .finally(() => {
        inflight.delete(sessionID);
      });
    inflight.set(sessionID, pending);
  }

  const cacheHitRate = await pending;
  return { cost, cacheHitRate };
}

/**
 * Test seam: the cached entry for one session, copied so callers cannot mutate
 * the cache. `null` means no entry is retained for that session.
 */
export function peekStatusCache(
  sessionID: string,
): { readonly cacheHitRate: number | null; readonly expiresAt: number } | null {
  const entry = cache.get(sessionID);
  return entry ? { ...entry } : null;
}

/** Drops the cached status for one session, or for every session. */
export function clearStatusCache(sessionID?: string): void {
  if (sessionID === undefined) cache.clear();
  else cache.delete(sessionID);
}
