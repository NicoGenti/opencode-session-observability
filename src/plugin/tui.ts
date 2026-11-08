import { spawn } from "node:child_process";
import { readTokenFile } from "../server/token-file.ts";
import { defineTuiPlugin } from "./define.ts";

const DEFAULT_URL = "http://127.0.0.1:4517";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

type Reachability = "ok" | "auth" | "down";
type RouteLike = { type: string; sessionID?: string };

export function buildTuiUrl(
  base: string,
  route: RouteLike,
  view: "trajectory" | "statistics",
  token: string | null,
): string {
  const path =
    route.type === "session" && route.sessionID
      ? `#/s/${encodeURIComponent(route.sessionID)}/${view}`
      : "#/";
  const url = `${base}/${path}`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

function withoutToken(url: string): string {
  return url.replace(/([?&])token=[^&]*/g, "$1").replace(/[?&]$/, "");
}

function pluginToken(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const env = process.env.OPENCODE_OBSERVABILITY_TOKEN;
  return typeof env === "string" && env.trim().length > 0 ? env.trim() : null;
}

async function tokenFromFile(base: string): Promise<string | null> {
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

function baseUrl(value: unknown): string {
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
 * Registers `/observability`, `/trajectory` and `/statistics`. The commands
 * are read-only: they never inject a prompt or alter the session. They open the
 * local web UI for the session currently shown in the TUI, or explain how to
 * start the UI when it is not running.
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
      const url = buildTuiUrl(base, context.ui.router.current(), view, token);
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
      commands: [
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
          description: "Open the turn/step metrics table for the current session",
          group: "Observability",
          palette: true,
          slash: { name: "statistics" },
          run: () => openView("statistics"),
        },
      ],
    }));
  },
});
