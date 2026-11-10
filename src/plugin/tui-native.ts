import type { Plugin as TuiSDK } from "@opencode/plugin/tui";

/**
 * Native TUI routing seam (issue #9, phase 2).
 *
 * The Statistics and Trajectory pages are owned by sibling issues (#6 ships
 * the slot/render wiring, #8 the Statistics view). This module only owns the
 * registry they announce themselves through and the navigation call
 * `/statistics` uses to reach them. It is pure `.ts`: no JSX, no `@opentui/*`,
 * and the SDK is imported for types only.
 */

/**
 * Plugin `Page.name` reserved for the Statistics view.
 *
 * @deprecated Router-page seam (issue #6, decision D1). `/statistics` ships as
 * the `session.panel` fullscreen panel opened by `openStatisticsPanel` in
 * `tui.ts`, and `registerNativeView` has no production caller. The constant and
 * the registry stay exported for host compatibility only; new views should
 * claim `session.panel` instead of registering a router page.
 */
export const STATISTICS_ROUTE = "statistics";

/** Plugin `Page.name` reserved for the Trajectory view. */
export const TRAJECTORY_ROUTE = "trajectory";

/** Plugin id the TUI host registers for this plugin; plugin routes carry it. */
export const TUI_PLUGIN_ID = "opencode-session-observability.tui";

const TOAST_TITLE = "Session observability";
const NATIVE_VIEW_MISSING = "Native view not installed yet.";

type SdkDestination = Parameters<TuiSDK.Context["ui"]["router"]["navigate"]>[0];
type SdkToastOptions = Parameters<TuiSDK.Context["ui"]["toast"]["show"]>[0];

/** The route shape navigation reads: only session routes carry an id. */
export type RouteLike = {
  readonly type: string;
  readonly sessionID?: string;
  readonly [key: string]: unknown;
};

/** Browser fallback supplied by the `/statistics` command. */
export type BrowserFallback = () => void | false | Promise<void>;

/** The slice of the SDK plugin context the native route needs. */
export type NativeRouteContext = {
  readonly ui: {
    readonly router: {
      navigate(destination: SdkDestination): void;
      current(): RouteLike;
    };
    readonly toast: {
      show(options: SdkToastOptions): void;
    };
  };
};

/** Ref-counted registrations per reserved page name. */
const nativeViews = new Map<string, number>();

function isValidName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0;
}

/**
 * Announces a native view for `name`. Registrations are ref-counted: the
 * returned cleanup removes exactly one reference, and calling it twice removes
 * one. Blank names are rejected so they cannot corrupt the registry.
 *
 * @deprecated Router-page seam (issue #6, decision D1). Statistics renders
 * through the `session.panel` slot, so no view is registered in production.
 * The registry stays exported and functional for host compatibility; new views
 * should claim `session.panel` and skip this registration step.
 */
export function registerNativeView(name: string): () => void {
  if (!isValidName(name)) {
    throw new TypeError("registerNativeView requires a non-empty page name");
  }
  nativeViews.set(name, (nativeViews.get(name) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (nativeViews.get(name) ?? 0) - 1;
    if (remaining > 0) nativeViews.set(name, remaining);
    else nativeViews.delete(name);
  };
}

/** Whether at least one native view is currently registered for `name`. */
export function hasNativeView(name: string): boolean {
  return isValidName(name) && (nativeViews.get(name) ?? 0) > 0;
}

/**
 * The session currently shown in the TUI, or `null` when the router is not on a
 * session: home and plugin routes carry no session of their own.
 */
export function currentSessionID(route: RouteLike | null | undefined): string | null {
  if (!route || route.type !== "session") return null;
  const sessionID = route.sessionID;
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null;
}

/**
 * Opens the native Statistics route when a view is registered. Otherwise it
 * explains the gap and hands over to the browser fallback. Never reads HTTP:
 * the page itself loads its data.
 */
export function openNativeStatistics(
  context: NativeRouteContext,
  browserFallback?: BrowserFallback,
): boolean {
  if (!hasNativeView(STATISTICS_ROUTE)) {
    context.ui.toast.show({
      title: TOAST_TITLE,
      message: NATIVE_VIEW_MISSING,
      variant: "info",
      duration: 8_000,
    });
    if (browserFallback) void browserFallback();
    return false;
  }
  context.ui.router.navigate({
    type: "plugin",
    id: TUI_PLUGIN_ID,
    name: STATISTICS_ROUTE,
    data: { sessionID: currentSessionID(context.ui.router.current()) },
  });
  return true;
}
