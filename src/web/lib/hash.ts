/**
 * The route fragment grammar, a strict port of `parseHash` / `updateHash` /
 * `onHashChange` in `src/ui/app.js:4214-4271`.
 *
 * Grammar:
 *
 * ```text
 * #/s/<sessionID>/<trajectory|statistics>?event=<eventID>
 * #/benchmark?<filters>
 * ```
 *
 * Every other fragment falls back to the empty trajectory route, exactly as the
 * legacy parser does. The router is intentionally unchanged:
 *
 * - `parts[2] === "statistics"` is the only way to reach the Statistics view; a
 *   missing or unknown segment is the Trajectory view.
 * - `?event=` is the only query parameter a session route understands. One-shot
 *   parameters (`token`, `theme`, `palette`) are read elsewhere (`auth.ts`,
 *   `theme.ts`) and are not preserved by a route write, matching legacy.
 * - Writes go through `history.replaceState`, so navigating never adds history
 *   entries and never reloads the document.
 *
 * `parseHash` throws on a malformed percent escape, as the legacy parser does.
 * `readRoute` is the app-level guard that keeps a hand-edited fragment from
 * blanking the screen; it is the only deviation and it does not change the
 * grammar.
 */

export type SessionView = "trajectory" | "statistics";
export type RouteView = SessionView | "benchmark";
export type RouteKind = "session" | "benchmark" | "empty";

export interface Route {
  kind: RouteKind;
  sessionID: string | null;
  view: RouteView;
  eventID: string | null;
  /** The raw `#/benchmark` query string; Phase 6 owns its parsed shape. */
  benchmarkQuery: string;
}

export const EMPTY_ROUTE: Readonly<Route> = Object.freeze({
  kind: "empty",
  sessionID: null,
  view: "trajectory",
  eventID: null,
  benchmarkQuery: "",
});

export function routeKind(route: {
  sessionID: string | null;
  view: RouteView;
}): RouteKind {
  if (route.sessionID) return "session";
  return route.view === "benchmark" ? "benchmark" : "empty";
}

/** The pure port of `parseHash()` (`src/ui/app.js:4214-4237`). */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === "s" && parts[1]) {
    return {
      kind: "session",
      sessionID: decodeURIComponent(parts[1]),
      view: parts[2] === "statistics" ? "statistics" : "trajectory",
      eventID: params.get("event"),
      benchmarkQuery: "",
    };
  }
  if (parts[0] === "benchmark") {
    return {
      kind: "benchmark",
      sessionID: null,
      view: "benchmark",
      eventID: null,
      benchmarkQuery: params.toString(),
    };
  }
  return { ...EMPTY_ROUTE };
}

/** `parseHash` with the malformed-escape guard the app needs to stay usable. */
export function readRoute(hash: string | null | undefined): Route {
  if (!hash) return { ...EMPTY_ROUTE };
  try {
    return parseHash(hash);
  } catch {
    return { ...EMPTY_ROUTE };
  }
}

/** Applies a patch and recomputes the route kind; the state stays one object. */
export function withRoute(route: Route, patch: Partial<Omit<Route, "kind">>): Route {
  const next = { ...route, ...patch };
  return { ...next, kind: routeKind(next) };
}

export interface SessionRouteTarget {
  sessionID: string;
  view: SessionView;
  eventID: string | null;
}

/** The fragment `updateHash()` would write for a session route. */
export function sessionFragment(target: SessionRouteTarget): string {
  const base = `#/s/${encodeURIComponent(target.sessionID)}/${target.view}`;
  return target.eventID
    ? `${base}?event=${encodeURIComponent(target.eventID)}`
    : base;
}

/** The fragment the benchmark link and Phase 6 filter form use. */
export function benchmarkFragment(query = ""): string {
  return query ? `#/benchmark?${query}` : "#/benchmark";
}

export interface RouteHistory {
  replaceState(state: unknown, title: string, url: string): void;
}

/**
 * The pure port of `updateHash()`: no session, no write; identical fragment, no
 * write; otherwise one `replaceState` with the session fragment. Returns whether
 * the address bar changed.
 */
export function writeSessionRoute(
  history: RouteHistory | null | undefined,
  currentHash: string | null | undefined,
  route: Route,
): boolean {
  if (!route.sessionID) return false;
  const view: SessionView = route.view === "statistics" ? "statistics" : "trajectory";
  const next = sessionFragment({
    sessionID: route.sessionID,
    view,
    eventID: route.eventID,
  });
  if (currentHash === next) return false;
  try {
    history?.replaceState(null, "", next);
  } catch {
    return false;
  }
  return true;
}
