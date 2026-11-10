import { spawn } from "node:child_process";
import { defineTuiPlugin } from "./define.ts";
import { baseUrl, pluginToken, reachable, tokenFromFile } from "./tui-net.ts";
import type { StatisticsKeyboardBridge } from "./tui/statistics/state.ts";
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
const STATISTICS_PANEL = "statistics";

type RouteLike = { type: string; sessionID?: string };
type ViewOpener = (view: "trajectory" | "statistics") => void | false | Promise<void>;

/** Opens the native Statistics route, handing the seam its browser fallback. */
export type NativeStatisticsOpener = (
  browserFallback: BrowserFallback,
) => void | false | Promise<void>;

/** Where `/statistics` should render: the TUI route, or the local web UI. */
export type StatsTarget = "native" | "web";

const WEB_FLAGS = new Set(["--web", "-w", "web"]);

/**
 * Classifies the raw `/statistics` argument. Only the documented browser
 * tokens select the web UI; everything else (empty, whitespace, non-string)
 * keeps the native route.
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
 * supplies the view opener and the native Statistics opener, so tests can scan
 * the surface — and the `/statistics` routing — without the SDK.
 */
export function tuiCommandDefinitions(
  openView: ViewOpener,
  openNative: NativeStatisticsOpener = (browserFallback) => browserFallback(),
): readonly TuiCommandDefinition[] {
  const openStatistics = (input?: string): void | false | Promise<void> => {
    if (parseStatsArg(input) === "web") {
      return openView("statistics");
    }
    // Native route first; the seam falls back to the browser and explains the
    // gap when no native view is registered yet.
    return openNative(() => openView("statistics"));
  };

  return [
    {
      id: "observability.open",
      title: "Open session observability",
      description: "Open the local Trajectory/Statistics UI",
      group: "Observability",
      palette: true,
      slash: { name: "observability", aliases: ["obs"] },
      run: () => openView("trajectory"),
    },
    {
      id: "observability.trajectory",
      title: "Open session Trajectory",
      description: "Open the event ledger for the current session",
      group: "Observability",
      palette: true,
      slash: { name: "trajectory" },
      run: () => openView("trajectory"),
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
 * inject a prompt or alter the session. `/statistics` opens the native
 * fullscreen panel; passing `--web`, `-w` or `web` opens the local web UI
 * instead, and `/statistics:web` always opens it for the session currently
 * shown in the TUI, or explains how to start the UI when it is not running.
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
    const { statusBadgeElement } = await import("./tui/statusBadge.tsx");

    /**
     * Opens the native Statistics panel for the current session. Returns false
     * when the host has no selected session to attach the panel to.
     */
    const openStatisticsPanel = (): boolean =>
      context.ui.panel.open(STATISTICS_PANEL, { presentation: "fullscreen" });

    /**
     * The mounted panel installs its handlers here; the keymap layer below only
     * forwards. When the panel is closed or not mounted, every command is a
     * no-op even before the `enabled` gate is considered.
     */
    const statisticsKeyboard: StatisticsKeyboardBridge = { handlers: null };

    context.ui.slot({
      append: "session.panel",
      render: (input) =>
        input.name === STATISTICS_PANEL
          ? statisticsPanelElement(context, input, statisticsKeyboard)
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

    context.keymap.layer(() => ({
      commands: tuiCommandDefinitions(openView, (browserFallback) => {
        if (openStatisticsPanel()) return;
        context.ui.toast.show({
          title: "Session observability",
          message: "No session is selected, so there is no statistics to show.",
          variant: "warning",
          duration: 6_000,
        });
        return browserFallback();
      }),
    }));

    /**
     * Panel-scoped navigation. The layer is permanently registered but gated on
     * `ui.panel.current()`, so it only claims keys while this plugin's
     * statistics panel is the open panel; `priority` makes it win over host
     * bindings such as `escape`.
     */
    context.keymap.layer(() => ({
      enabled: () => context.ui.panel.current()?.name === STATISTICS_PANEL,
      priority: 10,
      commands: [
        {
          id: "statistics.moveDown",
          title: "Statistics: select next turn",
          group: "Statistics",
          bind: "j,down",
          run: () => {
            statisticsKeyboard.handlers?.moveSelection(1);
          },
        },
        {
          id: "statistics.moveUp",
          title: "Statistics: select previous turn",
          group: "Statistics",
          bind: "k,up",
          run: () => {
            statisticsKeyboard.handlers?.moveSelection(-1);
          },
        },
        {
          id: "statistics.toggleExpand",
          title: "Statistics: expand or collapse the selected turn",
          group: "Statistics",
          bind: "return",
          run: () => {
            statisticsKeyboard.handlers?.toggleExpand();
          },
        },
        {
          id: "statistics.close",
          title: "Statistics: close the panel",
          group: "Statistics",
          bind: "escape",
          run: () => {
            context.ui.panel.close();
          },
        },
      ],
    }));
  },
});
