import { spawn } from "node:child_process";
import { readTokenFile } from "../server/token-file.ts";
import { defineTuiPlugin } from "./define.ts";

const DEFAULT_URL = "http://127.0.0.1:4517";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

type Reachability = "ok" | "auth" | "down";
type RouteLike = { type: string; sessionID?: string };
type ViewOpener = (view: "trajectory" | "statistics") => void | false | Promise<void>;

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
 * supplies the view opener, so tests can scan the surface without the SDK.
 */
export function tuiCommandDefinitions(
  openView: ViewOpener,
): readonly TuiCommandDefinition[] {
  const openStatistics = (input?: string): void | false | Promise<void> => {
    if (parseStatsArg(input) === "web") {
      return openView("statistics");
    }
    // Phase 2 seam: the native route attempt lands here; until the native
    // view ships, the existing browser path stays the interim behaviour.
    return openView("statistics");
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

export function pluginToken(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const env = process.env.OPENCODE_OBSERVABILITY_TOKEN;
  return typeof env === "string" && env.trim().length > 0 ? env.trim() : null;
}

export async function tokenFromFile(base: string): Promise<string | null> {
  try {
    const url = new URL(base);
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    return (await readTokenFile(port))?.token ?? null;
  } catch {
    return null;
  }
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

export function baseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return DEFAULT_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_URL;
    // The TUI only opens the local UI; restrict the target to loopback so the
    // configurable URL cannot be turned into a launcher for arbitrary hosts.
    if (!LOOPBACK.has(url.hostname.toLowerCase())) return DEFAULT_URL;
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_URL;
  }
}

async function reachable(url: string): Promise<Reachability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return "down";
    const body = (await response.json().catch(() => null)) as {
      authRequired?: unknown;
    } | null;
    return body?.authRequired === true ? "auth" : "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
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
 * Registers `/observability`, `/trajectory`, `/statistics` and
 * `/statistics:web`. The commands are read-only: they never inject a prompt or
 * alter the session. They open the local web UI for the session currently shown
 * in the TUI, or explain how to start the UI when it is not running.
 */
export default defineTuiPlugin({
  id: "opencode-session-observability.tui",
  setup(context) {
    const base = baseUrl(context.options.url);

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
      commands: tuiCommandDefinitions(openView),
    }));
  },
});
