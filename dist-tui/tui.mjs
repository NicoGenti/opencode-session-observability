import { createComponent, createElement, insertNode, setProp, createTextNode, effect } from '@opentui/solid';
import { PluginContextProvider, usePlugin } from '@opencode/plugin/tui';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function tokenDirectory() {
  const override = process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR;
  if (override) return override;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, "opencode-observability");
  }
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return join(runtime, "opencode-observability");
  return join(homedir(), ".config", "opencode-observability");
}
function tokenFilePath(port) {
  return join(tokenDirectory(), `token-${port}.json`);
}
async function readTokenFile(port) {
  try {
    const raw = await readFile(tokenFilePath(port), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || parsed.port !== port || typeof parsed.token !== "string" || parsed.token.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function defineTuiPlugin(plugin) {
  return plugin;
}

const DEFAULT_URL = "http://127.0.0.1:4517";
const STATISTICS_PANEL = "statistics";
const LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
function buildTuiUrl(base, route, view, token, theme = null, palette = null) {
  const path = route.type === "session" && route.sessionID ? `#/s/${encodeURIComponent(route.sessionID)}/${view}` : "#/";
  const params = [];
  if (token) params.push(`token=${encodeURIComponent(token)}`);
  if (theme) params.push(`theme=${encodeURIComponent(theme)}`);
  if (palette) params.push(`palette=${encodeURIComponent(JSON.stringify(palette))}`);
  const url = `${base}/${path}`;
  return params.length > 0 ? `${url}?${params.join("&")}` : url;
}
function withoutToken(url) {
  return url.replace(/([?&])token=[^&]*/g, "$1").replace(/[?&]$/, "");
}
function pluginToken(value) {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  const env = process.env.OPENCODE_OBSERVABILITY_TOKEN;
  return typeof env === "string" && env.trim().length > 0 ? env.trim() : null;
}
async function tokenFromFile(base) {
  try {
    const url = new URL(base);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return (await readTokenFile(port))?.token ?? null;
  } catch {
    return null;
  }
}
function configuredTheme(context) {
  const configured = context.options.theme;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }
  if (configured && typeof configured === "object") {
    const name = configured.name;
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  }
  return null;
}
function themeColor(theme, path) {
  let cursor = theme;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = cursor[key];
  }
  if (typeof cursor === "string" && /^#[0-9a-f]{3,8}$/i.test(cursor.trim())) {
    return cursor.trim();
  }
  if (cursor && typeof cursor === "object") {
    const base = cursor.base;
    if (typeof base === "string" && /^#[0-9a-f]{3,8}$/i.test(base.trim())) {
      return base.trim();
    }
  }
  return null;
}
function themePalette(context) {
  const theme = context.theme;
  const page = themeColor(theme, ["background", "base"]);
  const text = themeColor(theme, ["text", "base"]);
  if (!page || !text) return null;
  const palette = {
    page,
    text,
    mode: context.themeMode === "light" ? "light" : "dark"
  };
  const optional = [
    ["surface", ["background", "raised", "base"]],
    ["surface2", ["background", "raised", "high"]],
    ["surface3", ["background", "action", "secondary", "base"]],
    ["text2", ["text", "muted"]],
    ["muted", ["text", "faint"]],
    ["border", ["border", "base"]],
    ["accent", ["text", "action", "primary", "base"]],
    ["good", ["text", "feedback", "success", "base"]],
    ["warning", ["text", "feedback", "warning", "base"]],
    ["critical", ["text", "feedback", "error", "base"]]
  ];
  for (const [key, path] of optional) {
    const value = themeColor(theme, path);
    if (value) palette[key] = value;
  }
  return palette;
}
function baseUrl(value) {
  if (typeof value !== "string" || value.length === 0) return DEFAULT_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_URL;
    if (!LOOPBACK.has(url.hostname.toLowerCase())) return DEFAULT_URL;
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_URL;
  }
}
async function reachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return "down";
    const body = await response.json().catch(() => null);
    return body?.authRequired === true ? "auth" : "ok";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}
function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore"
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
const tui = defineTuiPlugin({
  id: "opencode-session-observability.tui",
  async setup(context) {
    const base = baseUrl(context.options.url);
    const { statisticsPanelElement } = await Promise.resolve().then(() => StatisticsView$1);
    const openStatisticsPanel = () => context.ui.panel.open(STATISTICS_PANEL, { presentation: "fullscreen" });
    context.ui.slot({
      append: "session.panel",
      render: (input) => input.name === STATISTICS_PANEL ? statisticsPanelElement(context) : null
    });
    const openView = async (view) => {
      const configured = pluginToken(context.options.token);
      const status = await reachable(base);
      const token = status === "auth" ? configured ?? await tokenFromFile(base) : null;
      if (status === "down") {
        context.ui.toast.show({
          title: "Session observability",
          message: "The local UI is not running. Start it with: npm start -- --port 4517",
          variant: "warning",
          duration: 8e3
        });
        return;
      }
      if (status === "auth" && !token) {
        context.ui.toast.show({
          title: "Session observability",
          message: 'The UI requires an access token, but no token file was found. Restart it with `npm start`, or set the plugin option "token" or OPENCODE_OBSERVABILITY_TOKEN.',
          variant: "warning",
          duration: 1e4
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
        explicitTheme ? null : themePalette(context)
      );
      if (!openBrowser(url)) {
        context.ui.toast.show({
          title: "Session observability",
          message: withoutToken(url),
          variant: "info",
          duration: 8e3
        });
        return;
      }
      context.ui.toast.show({
        message: `Opening ${view} in the browser`,
        variant: "success"
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
          run: () => openView("trajectory")
        },
        {
          id: "observability.trajectory",
          title: "Open session Trajectory",
          description: "Open the event ledger for the current session",
          group: "Observability",
          palette: true,
          slash: { name: "trajectory" },
          run: () => openView("trajectory")
        },
        {
          id: "observability.statistics",
          title: "Open session Statistics",
          description: "Open the native turn/step metrics panel",
          group: "Observability",
          palette: true,
          slash: { name: "statistics", aliases: ["stats"] },
          run: () => {
            openStatisticsPanel();
          }
        },
        {
          id: "observability.statistics-web",
          title: "Open session Statistics in the browser",
          description: "Open the local web UI metrics table for the current session",
          group: "Observability",
          palette: true,
          slash: { name: "statistics-web", aliases: ["stats:web"] },
          run: () => openView("statistics")
        }
      ]
    }));
  }
});

const FALLBACK_COLORS = {
  fg: "#ffffff",
  bg: "#000000"
};
function bannerColors(context) {
  const palette = themePalette(context);
  return {
    fg: palette?.text ?? FALLBACK_COLORS.fg,
    bg: palette?.page ?? FALLBACK_COLORS.bg
  };
}
function StatisticsBanner() {
  const colors = bannerColors(usePlugin());
  return (() => {
    var _el$ = createElement("box"), _el$2 = createElement("text");
    insertNode(_el$, _el$2);
    setProp(_el$, "flexDirection", "column");
    setProp(_el$, "padding", 1);
    insertNode(_el$2, createTextNode(`StatisticsView (phase 1) — data binding lands in phase 2`));
    effect((_p$) => {
      var _v$ = colors.bg, _v$2 = colors.fg;
      _v$ !== _p$.e && (_p$.e = setProp(_el$, "backgroundColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = setProp(_el$2, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: void 0,
      t: void 0
    });
    return _el$;
  })();
}
function StatisticsView(props) {
  return createComponent(PluginContextProvider, {
    get value() {
      return props.context;
    },
    get children() {
      return createComponent(StatisticsBanner, {});
    }
  });
}
function statisticsPanelElement(context) {
  return createComponent(StatisticsView, {
    context
  });
}

const StatisticsView$1 = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  StatisticsView,
  statisticsPanelElement
}, Symbol.toStringTag, { value: 'Module' }));

export { buildTuiUrl, tui as default, themePalette };
