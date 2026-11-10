import { spawn } from "node:child_process";
import { defineTuiPlugin } from "./define.ts";
import { baseUrl, pluginToken, reachable, tokenFromFile } from "./tui-net.ts";
import type { StatisticsKeyboardBridge } from "./tui/statistics/state.ts";
import type { TrajectoryKeyboardBridge } from "./tui/trajectory/state.ts";
import {
  TUI_PLUGIN_ID,
  openNativeStatistics,
  type BrowserFallback,
} from "./tui-native.ts";

// The native routing seam lives in one module so sibling issues (#6/#8) import
// the reserved page names and the registry from a single place.
export {
  STATISTICS_ROUTE,
  TRAJECTORY_ROUTE,
  registerNativeView,
  hasNativeView,
  openNativeStatistics,
  currentSessionID,
} from "./tui-native.ts";

// The status badge seam lives in one module so the slot wiring (#6) imports the
// formatter, the cached fetcher and the badge text from the same place as the
// commands.
export {
  formatStatusBadge,
  fetchSessionStatus,
  statusBadgeText,
} from "./tui-status.ts";

// The local-UI transport helpers live in a leaf module so the status seam can
// share them without importing this entry point. Re-exported here unchanged:
// this entry point stays the single import site for the TUI surface.
export {
  baseUrl,
  pluginToken,
  tokenFromFile,
  reachable,
  type Reachability,
} from "./tui-net.ts";

/** Panel id shared by `ui.panel.open` and the `session.panel` slot claim. */
export const STATISTICS_PANEL = "statistics";

/** Panel id of the native Trajectory view (issue #6, decision D2). */
export const TRAJECTORY_PANEL = "trajectory";

type RouteLike = { type: string; sessionID?: string };
type ViewOpener = (view: "trajectory" | "statistics") => void | false | Promise<void>;

/** Opens a native panel view, handing the seam its browser fallback. */
export type NativeViewOpener = (
  browserFallback: BrowserFallback,
) => void | false | Promise<void>;

/**
 * @deprecated Alias of `NativeViewOpener`, kept for existing imports.
 */
export type NativeStatisticsOpener = NativeViewOpener;

/** Which native session panel a command targets. */
export type PanelTarget = "statistics" | "trajectory";

type ToastVariant = "info" | "success" | "warning" | "error";

/** The toast subset the routing fallback shows (SDK-compatible shape). */
export type PanelToastOptions = {
  readonly title?: string;
  readonly message: string;
  readonly variant?: ToastVariant;
  readonly duration?: number;
};

/**
 * Fallback copy per panel. `/statistics` keeps its warning wording from issue
 * #9; `/trajectory` introduces the informational variant.
 */
export const PANEL_FALLBACK = {
  statistics: {
    message: "No session is selected, so there is no statistics to show.",
    variant: "warning",
  },
  trajectory: {
    message: "No session is selected, so there is no trajectory to show.",
    variant: "info",
  },
} as const satisfies Record<
  PanelTarget,
  { readonly message: string; readonly variant: ToastVariant }
>;

/**
 * Native-first opener shared by `/statistics`, `/trajectory` and
 * `/observability`: open the panel, or toast once and hand over to the browser.
 * It mirrors the issue-9 fallback: one toast, then the existing browser path,
 * which reports its own success or start-up failure.
 */
export function openPanelOrFallback(
  panel: PanelTarget,
  open: () => boolean,
  toast: (options: PanelToastOptions) => void,
  browserFallback: BrowserFallback,
): boolean {
  if (open()) return true;
  const copy = PANEL_FALLBACK[panel];
  toast({
    title: "Session observability",
    message: copy.message,
    variant: copy.variant,
    duration: 6_000,
  });
  void browserFallback();
  return false;
}

/**
 * The keyboard bridge of the panel currently open, or `null` when the open
 * panel is not one of ours. The keymap layer dispatches through this, so both
 * native panels share the same bindings without seeing each other's handlers.
 */
export type PanelKeyboardBridge = {
  handlers: {
    moveSelection(delta: number): void;
    toggleExpand(): void;
  } | null;
};

export function activePanelKeyboard(
  name: string | undefined,
  bridges: {
    readonly statistics: PanelKeyboardBridge;
    readonly trajectory: PanelKeyboardBridge;
  },
): PanelKeyboardBridge | null {
  if (name === STATISTICS_PANEL) return bridges.statistics;
  if (name === TRAJECTORY_PANEL) return bridges.trajectory;
  return null;
}

/** Where `/statistics` should render: the TUI route, or the local web UI. */
export type StatsTarget = "native" | "web";

const WEB_FLAGS = new Set(["--web", "-w", "web"]);

/**
 * Classifies the raw `/statistics` or `/trajectory` argument. Only the
 * documented browser tokens select the web UI; everything else (empty,
 * whitespace, non-string) keeps the native route.
 */
export function parseStatsArg(input: unknown): StatsTarget {
  if (typeof input !== "string") return "native";
  return WEB_FLAGS.has(input.trim().toLowerCase()) ? "web" : "native";
}

/** One TUI command definition, structurally compatible with the SDK keymap. */
export type TuiCommandDefinition = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly group: string;
  readonly palette: true;
  readonly slash: {
    readonly name: string;
    readonly aliases?: string[];
    readonly arguments?: true;
  };
  readonly run: (input?: string) => void | false | Promise<void>;
};

/**
 * Builds the read-only Observability command surface. Pure: the caller
 * supplies the view opener and the two native panel openers, so tests can scan
 * the surface — and the `/statistics` and `/trajectory` routing — without the
 * SDK.
 */
export function tuiCommandDefinitions(
  openView: ViewOpener,
  openNative: NativeViewOpener = (browserFallback) => browserFallback(),
  openNativeTrajectory: NativeViewOpener = (browserFallback) =>
    browserFallback(),
): readonly TuiCommandDefinition[] {
  const openStatistics = (input?: string): void | false | Promise<void> => {
    if (parseStatsArg(input) === "web") {
      return openView("statistics");
    }
    // Native route first; the seam falls back to the browser and explains the
    // gap when the panel cannot open (no session selected).
    return openNative(() => openView("statistics"));
  };

  const openTrajectory = (input?: string): void | false | Promise<void> => {
    if (parseStatsArg(input) === "web") {
      return openView("trajectory");
    }
    // Same native-first contract as `/statistics` (issue #6, decision D2).
    return openNativeTrajectory(() => openView("trajectory"));
  };

  return [
    {
      id: "observability.open",
      title: "Open session observability",
      description:
        "Open the native Trajectory view; add --web for the local web UI",
      group: "Observability",
      palette: true,
      slash: { name: "observability", aliases: ["obs"], arguments: true },
      run: openTrajectory,
    },
    {
      id: "observability.trajectory",
      title: "Open session Trajectory",
      description:
        "Open the native Trajectory view; add --web for the local web UI",
      group: "Observability",
      palette: true,
      slash: { name: "trajectory", arguments: true },
      run: openTrajectory,
    },
    {
      id: "observability.statistics",
      title: "Open session Statistics",
      description:
        "Open the native Statistics view; add --web for the local web UI",
      group: "Observability",
      palette: true,
      slash: { name: "statistics", aliases: ["stats"], arguments: true },
      run: openStatistics,
    },
    {
      id: "observability.statistics.web",
      title: "Open session Statistics in the browser",
      description: "Open the local Statistics web UI for the current session",
      group: "Observability",
      palette: true,
      slash: { name: "statistics:web", aliases: ["stats:web"] },
      run: () => openView("statistics"),
    },
  ];
}

export function buildTuiUrl(
  base: string,
  route: RouteLike,
  view: "trajectory" | "statistics",
  token: string | null,
  theme: string | null = null,
  palette: Record<string, string> | null = null,
): string {
  const path =
    route.type === "session" && route.sessionID
      ? `#/s/${encodeURIComponent(route.sessionID)}/${view}`
      : "#/";
  const params: string[] = [];
  if (token) params.push(`token=${encodeURIComponent(token)}`);
  if (theme) params.push(`theme=${encodeURIComponent(theme)}`);
  if (palette) params.push(`palette=${encodeURIComponent(JSON.stringify(palette))}`);
  const url = `${base}/${path}`;
  return params.length > 0 ? `${url}?${params.join("&")}` : url;
}

function withoutToken(url: string): string {
  return url.replace(/([?&])token=[^&]*/g, "$1").replace(/[?&]$/, "");
}

function configuredTheme(context: {
  options: Readonly<Record<string, unknown>>;
}): string | null {
  const configured = context.options.theme;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }
  if (configured && typeof configured === "object") {
    const name = (configured as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  }
  return null;
}

function themeColor(theme: unknown, path: string[]): string | null {
  let cursor: unknown = theme;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  if (typeof cursor === "string" && /^#[0-9a-f]{3,8}$/i.test(cursor.trim())) {
    return cursor.trim();
  }
  if (cursor && typeof cursor === "object") {
    const base = (cursor as Record<string, unknown>).base;
    if (typeof base === "string" && /^#[0-9a-f]{3,8}$/i.test(base.trim())) {
      return base.trim();
    }
  }
  return null;
}

/**
 * Extracts the colors OpenCode already resolved for its own TUI. Sending them
 * in the deep link makes the browser match the user's actual theme, including
 * custom themes that this UI does not bundle.
 */
export function themePalette(context: {
  theme?: unknown;
  themeMode?: unknown;
}): Record<string, string> | null {
  const theme = context.theme;
  const page = themeColor(theme, ["background", "base"]);
  const text = themeColor(theme, ["text", "base"]);
  if (!page || !text) return null;
  const palette: Record<string, string> = {
    page,
    text,
    mode: context.themeMode === "light" ? "light" : "dark",
  };
  const optional: Array<[string, string[]]> = [
    ["surface", ["background", "raised", "base"]],
    ["surface2", ["background", "raised", "high"]],
    ["surface3", ["background", "action", "secondary", "base"]],
    ["text2", ["text", "muted"]],
    ["muted", ["text", "faint"]],
    ["border", ["border", "base"]],
    ["accent", ["text", "action", "primary", "base"]],
    ["good", ["text", "feedback", "success", "base"]],
    ["warning", ["text", "feedback", "warning", "base"]],
    ["critical", ["text", "feedback", "error", "base"]],
  ];
  for (const [key, path] of optional) {
    const value = themeColor(theme, path);
    if (value) palette[key] = value;
  }
  return palette;
}

function openBrowser(url: string): boolean {
  try {
    if (process.platform === "win32") {
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * OpenCode 2 TUI part.
 *
 * Registers `/observability`, `/trajectory`, `/statistics` (alias `/stats`) and
 * `/statistics:web` (alias `/stats:web`). The commands are read-only: they never
 * inject a prompt or alter the session. `/statistics` and `/trajectory` open
 * their native fullscreen panels first; passing `--web`, `-w` or `web` opens the
 * local web UI instead, and `/statistics:web` always opens it for the session
 * currently shown in the TUI, or explains how to start the UI when it is not
 * running.
 */
export default defineTuiPlugin({
  id: TUI_PLUGIN_ID,
  async setup(context) {
    const base = baseUrl(context.options.url);

    // Loaded lazily: the raw sources are `.tsx` modules for JSX-capable hosts,
    // while Node-hosted tests import this module without a JSX loader.
    const { statisticsPanelElement } = await import(
      "./tui/statistics/StatisticsView.tsx"
    );
    const { trajectoryPanelElement } = await import(
      "./tui/trajectory/TrajectoryView.tsx"
    );
    const { statusBadgeElement } = await import("./tui/statusBadge.tsx");

    /**
     * Opens the native Statistics panel for the current session. Returns false
     * when the host has no selected session to attach the panel to.
     */
    const openStatisticsPanel = (): boolean =>
      context.ui.panel.open(STATISTICS_PANEL, { presentation: "fullscreen" });

    /** Opens the native Trajectory panel; false without a selected session. */
    const openTrajectoryPanel = (): boolean =>
      context.ui.panel.open(TRAJECTORY_PANEL, { presentation: "fullscreen" });

    /**
     * The mounted panels install their handlers here; the keymap layer below
     * only forwards. When a panel is closed or not mounted, every command is a
     * no-op even before the `enabled` gate is considered.
     */
    const statisticsKeyboard: StatisticsKeyboardBridge = { handlers: null };
    const trajectoryKeyboard: TrajectoryKeyboardBridge = { handlers: null };

    context.ui.slot({
      append: "session.panel",
      render: (input) =>
        input.name === STATISTICS_PANEL
          ? statisticsPanelElement(context, input, statisticsKeyboard)
          : null,
    });

    /**
     * The Trajectory panel is a second claim on the same slot (decision D2).
     * Each claim renders only for its own panel id and returns `null`
     * otherwise, so the host can pick by name without the claims colliding.
     */
    context.ui.slot({
      append: "session.panel",
      render: (input) =>
        input.name === TRAJECTORY_PANEL
          ? trajectoryPanelElement(context, input, trajectoryKeyboard)
          : null,
    });

    /**
     * Status badge (issue #6, decision D3). `prompt.footer.status` carries the
     * session id, the input mode and `showDetails`; the badge renders one line
     * and degrades every missing value to `n/a`. When an older host does not
     * publish this path, the SDK appends the claim to the nearest surviving
     * ancestor (`prompt.footer`), so no second claim is needed and nothing
     * throws or toasts.
     */
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => statusBadgeElement(context, input),
    });

    const openView = async (view: "trajectory" | "statistics"): Promise<void> => {
      const configured = pluginToken(context.options.token);
      const status = await reachable(base);
      const token =
        status === "auth"
          ? (configured ?? (await tokenFromFile(base)))
          : null;
      if (status === "down") {
        context.ui.toast.show({
          title: "Session observability",
          message:
            "The local UI is not running. Start it with: npm start -- --port 4517",
          variant: "warning",
          duration: 8_000,
        });
        return;
      }
      if (status === "auth" && !token) {
        context.ui.toast.show({
          title: "Session observability",
          message:
            "The UI requires an access token, but no token file was found. Restart it with `npm start`, or set the plugin option \"token\" or OPENCODE_OBSERVABILITY_TOKEN.",
          variant: "warning",
          duration: 10_000,
        });
        return;
      }
      const explicitTheme = configuredTheme(context);
      const url = buildTuiUrl(
        base,
        context.ui.router.current(),
        view,
        token,
        explicitTheme,
        explicitTheme ? null : themePalette(context),
      );
      if (!openBrowser(url)) {
        context.ui.toast.show({
          title: "Session observability",
          message: withoutToken(url),
          variant: "info",
          duration: 8_000,
        });
        return;
      }
      context.ui.toast.show({
        message: `Opening ${view} in the browser`,
        variant: "success",
      });
    };

    const keymapBridges = {
      statistics: statisticsKeyboard,
      trajectory: trajectoryKeyboard,
    };
    const activeKeyboard = (): PanelKeyboardBridge | null =>
      activePanelKeyboard(context.ui.panel.current()?.name, keymapBridges);

    context.keymap.layer(() => ({
      commands: tuiCommandDefinitions(
        openView,
        (browserFallback) => {
          openPanelOrFallback(
            "statistics",
            openStatisticsPanel,
            (options) => context.ui.toast.show(options),
            browserFallback,
          );
        },
        (browserFallback) => {
          openPanelOrFallback(
            "trajectory",
            openTrajectoryPanel,
            (options) => context.ui.toast.show(options),
            browserFallback,
          );
        },
      ),
    }));

    /**
     * Panel-scoped navigation shared by both native panels. The layer is
     * permanently registered but gated on `ui.panel.current()`, so it only
     * claims keys while one of this plugin's panels is open; dispatch resolves
     * the active panel's bridge, so the two panels never see each other's
     * handlers. `priority` makes it win over host bindings such as `escape`.
     * The focus gate from the hardening phase is intentionally not applied yet.
     */
    context.keymap.layer(() => ({
      enabled: () => activeKeyboard() !== null,
      priority: 10,
      commands: [
        {
          id: "panel.moveDown",
          title: "Session panel: select next turn",
          group: "Session panel",
          bind: "j,down",
          run: () => {
            activeKeyboard()?.handlers?.moveSelection(1);
          },
        },
        {
          id: "panel.moveUp",
          title: "Session panel: select previous turn",
          group: "Session panel",
          bind: "k,up",
          run: () => {
            activeKeyboard()?.handlers?.moveSelection(-1);
          },
        },
        {
          id: "panel.toggleExpand",
          title: "Session panel: expand or collapse the selected turn",
          group: "Session panel",
          bind: "return",
          run: () => {
            activeKeyboard()?.handlers?.toggleExpand();
          },
        },
        {
          id: "panel.close",
          title: "Session panel: close the panel",
          group: "Session panel",
          bind: "escape",
          run: () => {
            context.ui.panel.close();
          },
        },
      ],
    }));
  },
});
