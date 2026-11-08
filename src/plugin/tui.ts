import { spawn } from "node:child_process";
import { Plugin } from "@opencode/plugin/tui";

const DEFAULT_URL = "http://127.0.0.1:4517";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

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

async function reachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    return response.ok;
  } catch {
    return false;
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
export default Plugin.define({
  id: "opencode-session-observability.tui",
  setup(context) {
    const base = baseUrl(context.options.url);

    const targetUrl = (view: "trajectory" | "statistics"): string => {
      const route = context.ui.router.current();
      if (route.type === "session") {
        return `${base}/#/s/${encodeURIComponent(route.sessionID)}/${view}`;
      }
      return `${base}/`;
    };

    const openView = async (view: "trajectory" | "statistics"): Promise<void> => {
      const url = targetUrl(view);
      if (!(await reachable(base))) {
        context.ui.toast.show({
          title: "Session observability",
          message:
            "The local UI is not running. Start it with: npm start -- --port 4517",
          variant: "warning",
          duration: 8_000,
        });
        return;
      }
      if (!openBrowser(url)) {
        context.ui.toast.show({
          title: "Session observability",
          message: url,
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
