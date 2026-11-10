import { createComponent, createElement, setProp, insert, effect, insertNode, createTextNode, memo } from '@opentui/solid';
import { createSignal, createMemo, createEffect, Show, For } from 'solid-js';
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
      render: (input) => input.name === STATISTICS_PANEL ? statisticsPanelElement(context, input) : null
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

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
function formatNumber(value) {
  if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
  return numberFormat.format(value);
}
function formatCompact(value) {
  if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}
function formatDuration(ms) {
  if (ms === null || ms === void 0 || !Number.isFinite(ms)) return "—";
  const abs = Math.abs(ms);
  if (abs < 1e3) return `${Math.round(ms)} ms`;
  if (abs < 6e4) return `${(ms / 1e3).toFixed(2)} s`;
  if (abs < 36e5) {
    const minutes2 = Math.floor(abs / 6e4);
    const seconds = Math.round(abs % 6e4 / 1e3);
    return `${ms < 0 ? "-" : ""}${minutes2}m ${seconds}s`;
  }
  const hours = Math.floor(abs / 36e5);
  const minutes = Math.round(abs % 36e5 / 6e4);
  return `${ms < 0 ? "-" : ""}${hours}h ${minutes}m`;
}
function formatPercent(ratio) {
  if (ratio === null || ratio === void 0 || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}
function formatCost(value) {
  if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}
function basisMark(basis) {
  if (basis === "measured") return "M";
  if (basis === "derived") return "D";
  if (basis === "estimated") return "E";
  return "—";
}

const MARKS = {
  completed: { symbol: "OK", label: "Completed", paletteKey: "good" },
  error: { symbol: "ERR", label: "Error", paletteKey: "critical" },
  interrupted: { symbol: "INT", label: "Interrupted", paletteKey: "warning" },
  running: { symbol: "RUN", label: "Running", paletteKey: "accent" },
  incomplete: { symbol: "INC", label: "Incomplete", paletteKey: "warning" },
  unknown: { symbol: "?", label: "Unknown", paletteKey: "muted" }
};
const FALLBACK = MARKS.unknown;
function statusMark(status) {
  return MARKS[status] ?? FALLBACK;
}
function statusSymbol(status) {
  return statusMark(status).symbol;
}

const BREAKPOINTS = {
  full: 120,
  wideMid: 100,
  mid: 90,
  narrowMid: 81};
const FULL_COLUMNS = [
  "turn",
  "steps",
  "tokIn",
  "tokOut",
  "reasoning",
  "cacheRead",
  "cacheWrite",
  "cacheHit",
  "modelMs",
  "toolMs",
  "residual",
  "cost",
  "status"
];
const WIDE_MID_COLUMNS = FULL_COLUMNS.filter(
  (id) => id !== "reasoning"
);
const MID_COLUMNS = WIDE_MID_COLUMNS.filter(
  (id) => id !== "cacheWrite"
);
const NARROW_MID_COLUMNS = [
  "turn",
  "steps",
  "tokIn",
  "tokOut",
  "cost",
  "status"
];
const COMPACT_COLUMNS = [
  "turn",
  "tokens",
  "cost",
  "status"
];
const COLUMN_LABELS = {
  turn: "#",
  steps: "Steps",
  tokIn: "In",
  tokOut: "Out",
  reasoning: "Reason",
  cacheRead: "CacheR",
  cacheWrite: "CacheW",
  cacheHit: "Hit",
  modelMs: "Model",
  toolMs: "Tool",
  residual: "Resid",
  cost: "Cost",
  status: "Status",
  tokens: "Tokens"
};
const COLUMN_WIDTHS = {
  turn: 4,
  steps: 5,
  tokIn: 8,
  tokOut: 8,
  reasoning: 7,
  cacheRead: 8,
  cacheWrite: 8,
  cacheHit: 8,
  modelMs: 9,
  toolMs: 9,
  residual: 9,
  cost: 10,
  status: 6,
  tokens: 17
};
function resolveLayout(width) {
  const safe = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
  if (safe >= BREAKPOINTS.full) {
    return { width: safe, mode: "full", columns: FULL_COLUMNS };
  }
  if (safe >= BREAKPOINTS.wideMid) {
    return { width: safe, mode: "mid", columns: WIDE_MID_COLUMNS };
  }
  if (safe >= BREAKPOINTS.mid) {
    return { width: safe, mode: "mid", columns: MID_COLUMNS };
  }
  if (safe >= BREAKPOINTS.narrowMid) {
    return { width: safe, mode: "mid", columns: NARROW_MID_COLUMNS };
  }
  return { width: safe, mode: "compact", columns: COMPACT_COLUMNS };
}
function columnLabel(id) {
  return COLUMN_LABELS[id];
}
function columnWidth(id) {
  return COLUMN_WIDTHS[id];
}
const UNAVAILABLE$1 = { value: null, basis: "unavailable" };
function metricOf(metric) {
  return metric ?? UNAVAILABLE$1;
}
function numberText(value) {
  return formatCompact(value);
}
function marked(metric, formatter) {
  const current = metricOf(metric);
  if (current.value === null || !Number.isFinite(current.value)) return "—";
  const basis = current.basis ?? "unavailable";
  return `${formatter(current.value)} ${basisMark(basis)}`;
}
function markedCompact(metric) {
  return marked(metric, (value) => formatCompact(value));
}
function contextPair(turn) {
  return `${markedCompact(turn.promptTokensLatest)}/${markedCompact(
    turn.promptTokensCumulative
  )}`;
}
function turnCellValues(turn) {
  const tokens = turn.tokens;
  const status = turn.status ?? "unknown";
  return {
    turn: String(turn.index),
    steps: String(turn.steps?.length ?? 0),
    tokIn: numberText(tokens?.input),
    tokOut: numberText(tokens?.output),
    reasoning: numberText(tokens?.reasoning),
    cacheRead: numberText(tokens?.cacheRead),
    cacheWrite: numberText(tokens?.cacheWrite),
    cacheHit: marked(turn.cacheHitRate, (value) => formatPercent(value)),
    modelMs: marked(turn.modelTime, (value) => formatDuration(value)),
    toolMs: marked(turn.toolTime, (value) => formatDuration(value)),
    residual: marked(turn.residualTime, (value) => formatDuration(value)),
    cost: marked(turn.cost, (value) => formatCost(value)),
    status: statusSymbol(status),
    tokens: contextPair(turn)
  };
}
function padCell(id, value) {
  if (id === "status") return value.padEnd(columnWidth(id));
  return value.padStart(columnWidth(id));
}
function formatHeader(columns) {
  return `  ${columns.map((id) => padCell(id, columnLabel(id))).join(" ")}`;
}
function formatRow(turn, columns, selected) {
  const values = turnCellValues(turn);
  const marker = selected ? "> " : "  ";
  const cells = [];
  let status = "";
  for (const id of columns) {
    const cell = padCell(id, values[id]);
    if (id === "status") {
      status = ` ${cell}`;
      continue;
    }
    cells.push(cell);
  }
  return { prefix: `${marker}${cells.join(" ")}`, status };
}

function defineRpc(definition) {
  const reserved = Object.values(definition.methods).flatMap((method) => Object.keys(method.errors ?? {})).find((name) => name.startsWith("rpc."));
  if (reserved) {
    throw new Error(`RPC error names starting with "rpc." are reserved: ${reserved}`);
  }
  return definition;
}

const stringArray = {
  type: "array",
  items: { type: "string" }
};
const looseObject = {
  type: "object",
  additionalProperties: true
};
const emptyInput = {
  type: "object",
  properties: {},
  additionalProperties: false
};
const Observability = defineRpc({
  id: "session-observability",
  methods: {
    health: {
      input: emptyInput,
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          version: { type: "string" },
          source: { type: "string" },
          revealAllowed: { type: "boolean" },
          readOnly: { type: "boolean" }
        },
        required: ["ok", "version", "source", "revealAllowed", "readOnly"],
        additionalProperties: false
      }
    },
    sessions: {
      input: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          reveal: { type: "boolean" }
        },
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          sessions: { type: "array", items: looseObject },
          revealAllowed: { type: "boolean" }
        },
        required: ["sessions", "revealAllowed"],
        additionalProperties: false
      }
    },
    session: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          reveal: { type: "boolean" }
        },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          session: looseObject,
          family: looseObject,
          revealAllowed: { type: "boolean" }
        },
        required: ["session", "family", "revealAllowed"],
        additionalProperties: false
      }
    },
    analysis: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          fromSeq: { type: "number" },
          toSeq: { type: "number" },
          reveal: { type: "boolean" }
        },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          analysis: looseObject,
          revealAllowed: { type: "boolean" }
        },
        required: ["analysis", "revealAllowed"],
        additionalProperties: false
      }
    },
    eventPage: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          q: { type: "string" },
          kinds: stringArray,
          agents: stringArray,
          models: stringArray,
          providers: stringArray,
          tools: stringArray,
          statuses: stringArray,
          errorsOnly: { type: "boolean" },
          retriesOnly: { type: "boolean" },
          compactionsOnly: { type: "boolean" },
          subagentsOnly: { type: "boolean" },
          contextOnly: { type: "boolean" },
          from: { type: "number" },
          to: { type: "number" },
          minPromptTokens: { type: "number" },
          maxPromptTokens: { type: "number" },
          limit: { type: "number" },
          before: { type: "string" },
          after: { type: "string" },
          around: { type: "string" },
          direction: { type: "string", enum: ["forward", "backward"] },
          reveal: { type: "boolean" }
        },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          events: { type: "array", items: looseObject },
          page: looseObject,
          coverage: looseObject,
          capabilities: looseObject,
          redacted: { type: "boolean" },
          revealAllowed: { type: "boolean" }
        },
        required: [
          "events",
          "page",
          "coverage",
          "capabilities",
          "redacted",
          "revealAllowed"
        ],
        additionalProperties: false
      }
    },
    event: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          eventID: { type: "string" },
          reveal: { type: "boolean" }
        },
        required: ["sessionID", "eventID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          event: looseObject,
          revealAllowed: { type: "boolean" }
        },
        required: ["event", "revealAllowed"],
        additionalProperties: false
      }
    },
    export: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          format: { type: "string", enum: ["json", "markdown", "html"] },
          includeEvents: { type: "boolean" },
          reveal: { type: "boolean" }
        },
        required: ["sessionID", "format"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          filename: { type: "string" },
          mime: { type: "string" },
          content: { type: "string" },
          redacted: { type: "boolean" }
        },
        required: ["filename", "mime", "content", "redacted"],
        additionalProperties: false
      }
    }
  },
  events: {}
});

const UNAVAILABLE = { value: null, basis: "unavailable" };
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function looksLikeAnalysis(value) {
  return isRecord(value) && Array.isArray(value.turns) && isRecord(value.totals) && isRecord(value.session);
}
function parseAnalysisResponse(response) {
  let current = response;
  for (let depth = 0; depth < 4; depth++) {
    if (!isRecord(current)) break;
    if (looksLikeAnalysis(current)) return { ok: true, analysis: current };
    if ("analysis" in current) {
      const inner = current.analysis;
      if (looksLikeAnalysis(inner)) return { ok: true, analysis: inner };
      return {
        ok: false,
        message: "No analysis is available for this session."
      };
    }
    if ("output" in current) {
      current = current.output;
      continue;
    }
    if ("error" in current) {
      return { ok: false, message: "The analysis request returned an error." };
    }
    break;
  }
  return {
    ok: false,
    message: "The analysis response was not recognized."
  };
}
function asMetric(value) {
  return value ?? UNAVAILABLE;
}
function createStatisticsState(client) {
  const [analysis, setAnalysis] = createSignal(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(null);
  const [sessionID, setSessionID] = createSignal("");
  const [selectedIndex, setSelectedIndexSignal] = createSignal(0);
  let request = 0;
  const totals = createMemo(() => {
    const value = analysis();
    if (!value) return null;
    const source = value.totals;
    return {
      totalContext: asMetric(source?.finalContext),
      cacheHitRate: asMetric(source?.cacheHitRate),
      cost: asMetric(source?.cost),
      turns: typeof source?.turns === "number" ? source.turns : value.turns?.length ?? 0
    };
  });
  const turns = createMemo(() => analysis()?.turns ?? []);
  function setSelectedIndex(index) {
    setSelectedIndexSignal(
      Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0
    );
  }
  async function fetchAnalysis(nextSessionID) {
    const target = typeof nextSessionID === "string" ? nextSessionID.trim() : "";
    const ticket = ++request;
    if (target !== sessionID()) setSelectedIndex(0);
    setSessionID(target);
    setAnalysis(null);
    setError(null);
    if (target.length === 0) {
      setLoading(false);
      setError("No session is selected.");
      return;
    }
    setLoading(true);
    try {
      const response = await client.rpc.call({
        rpcID: Observability.id,
        method: "analysis",
        input: { sessionID: target }
      });
      if (ticket !== request) return;
      const parsed = parseAnalysisResponse(response);
      if (!parsed.ok) {
        setAnalysis(null);
        setError(parsed.message);
        return;
      }
      setAnalysis(parsed.analysis);
    } catch {
      if (ticket !== request) return;
      setAnalysis(null);
      setError("The analysis could not be loaded. Reopen the panel to retry.");
    } finally {
      if (ticket === request) setLoading(false);
    }
  }
  return {
    analysis,
    loading,
    error,
    sessionID,
    selectedIndex,
    totals,
    turns,
    setSelectedIndex,
    fetchAnalysis
  };
}

const FALLBACK_FOREGROUND = "#ffffff";
const FALLBACK_BACKGROUND = "#000000";
function colorOf(palette, key) {
  return palette[key] ?? palette.text ?? palette.text2 ?? FALLBACK_FOREGROUND;
}
function backgroundOf(palette) {
  return palette.page ?? FALLBACK_BACKGROUND;
}
function bannerMetric(metric, formatter) {
  if (!metric || metric.value === null || !Number.isFinite(metric.value)) {
    return "—";
  }
  return `${formatter(metric.value)} ${basisMark(metric.basis)}`;
}
function sessionStatus(analysis) {
  const outcome = analysis.session?.outcome;
  if (outcome === "succeeded") return "completed";
  if (outcome === "failed") return "error";
  if (outcome === "interrupted") return "interrupted";
  const turns = analysis.turns ?? [];
  const last = turns[turns.length - 1];
  return last?.status ?? "unknown";
}
function Banner(props) {
  const status = () => statusMark(sessionStatus(props.analysis));
  const sessionID = () => props.analysis.session?.id ?? "unknown session";
  const turnCount = () => props.totals?.turns ?? props.analysis.turns?.length ?? 0;
  return (() => {
    var _el$ = createElement("box"), _el$2 = createElement("box"), _el$3 = createElement("text"), _el$5 = createElement("text"), _el$6 = createElement("text"), _el$9 = createElement("text"), _el$0 = createElement("box"), _el$1 = createElement("text"), _el$10 = createElement("text"), _el$11 = createElement("text");
    insertNode(_el$, _el$2);
    insertNode(_el$, _el$0);
    setProp(_el$, "flexDirection", "column");
    setProp(_el$, "flexShrink", 0);
    setProp(_el$, "marginBottom", 1);
    insertNode(_el$2, _el$3);
    insertNode(_el$2, _el$5);
    insertNode(_el$2, _el$6);
    insertNode(_el$2, _el$9);
    setProp(_el$2, "flexDirection", "row");
    setProp(_el$2, "gap", 1);
    insertNode(_el$3, createTextNode(`Session`));
    insert(_el$5, sessionID);
    insert(_el$6, () => `${status().symbol} ${status().label}`);
    insert(_el$2, createComponent(Show, {
      get when() {
        return props.analysis.redacted;
      },
      get children() {
        var _el$7 = createElement("text");
        insertNode(_el$7, createTextNode(`redacted`));
        effect((_$p) => setProp(_el$7, "fg", colorOf(props.palette, "warning"), _$p));
        return _el$7;
      }
    }), _el$9);
    insert(_el$9, () => `${turnCount()} turns`);
    insertNode(_el$0, _el$1);
    insertNode(_el$0, _el$10);
    insertNode(_el$0, _el$11);
    setProp(_el$0, "flexDirection", "row");
    setProp(_el$0, "gap", 2);
    insert(_el$1, () => `Context ${bannerMetric(props.totals?.totalContext, formatNumber)}`);
    insert(_el$10, () => `Cache hit ${bannerMetric(props.totals?.cacheHitRate, formatPercent)}`);
    insert(_el$11, () => `Cost ${bannerMetric(props.totals?.cost, formatCost)}`);
    effect((_p$) => {
      var _v$ = colorOf(props.palette, "text2"), _v$2 = colorOf(props.palette, "text"), _v$3 = colorOf(props.palette, status().paletteKey), _v$4 = colorOf(props.palette, "muted"), _v$5 = colorOf(props.palette, "text"), _v$6 = colorOf(props.palette, "text"), _v$7 = colorOf(props.palette, "text");
      _v$ !== _p$.e && (_p$.e = setProp(_el$3, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = setProp(_el$5, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = setProp(_el$6, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = setProp(_el$9, "fg", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = setProp(_el$1, "fg", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = setProp(_el$10, "fg", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = setProp(_el$11, "fg", _v$7, _p$.s));
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0,
      o: void 0,
      i: void 0,
      n: void 0,
      s: void 0
    });
    return _el$;
  })();
}
function StateMessage(props) {
  return (() => {
    var _el$12 = createElement("box");
    setProp(_el$12, "flexDirection", "column");
    setProp(_el$12, "flexGrow", 1);
    setProp(_el$12, "justifyContent", "center");
    setProp(_el$12, "alignItems", "center");
    insert(_el$12, createComponent(Show, {
      get when() {
        return props.state.loading();
      },
      get children() {
        var _el$13 = createElement("text");
        insertNode(_el$13, createTextNode(`Loading…`));
        effect((_$p) => setProp(_el$13, "fg", colorOf(props.palette, "muted"), _$p));
        return _el$13;
      }
    }), null);
    insert(_el$12, createComponent(Show, {
      get when() {
        return memo(() => !!!props.state.loading())() && props.state.error();
      },
      get children() {
        return [(() => {
          var _el$15 = createElement("text");
          insert(_el$15, () => props.state.error());
          effect((_$p) => setProp(_el$15, "fg", colorOf(props.palette, "critical"), _$p));
          return _el$15;
        })(), (() => {
          var _el$16 = createElement("text");
          insertNode(_el$16, createTextNode(`Reopen the panel to retry.`));
          effect((_$p) => setProp(_el$16, "fg", colorOf(props.palette, "muted"), _$p));
          return _el$16;
        })()];
      }
    }), null);
    insert(_el$12, createComponent(Show, {
      get when() {
        return memo(() => !!!props.state.loading())() && !props.state.error();
      },
      get children() {
        var _el$18 = createElement("text");
        insertNode(_el$18, createTextNode(`Loading…`));
        effect((_$p) => setProp(_el$18, "fg", colorOf(props.palette, "muted"), _$p));
        return _el$18;
      }
    }), null);
    return _el$12;
  })();
}
function Table(props) {
  return createComponent(Show, {
    get when() {
      return props.turns.length > 0;
    },
    get fallback() {
      return (() => {
        var _el$22 = createElement("text");
        insertNode(_el$22, createTextNode(`No turns for this session.`));
        effect((_$p) => setProp(_el$22, "fg", colorOf(props.palette, "muted"), _$p));
        return _el$22;
      })();
    },
    get children() {
      return [(() => {
        var _el$20 = createElement("text");
        setProp(_el$20, "wrapMode", "none");
        insert(_el$20, () => formatHeader(props.layout.columns));
        effect((_$p) => setProp(_el$20, "fg", colorOf(props.palette, "text2"), _$p));
        return _el$20;
      })(), (() => {
        var _el$21 = createElement("scrollbox");
        setProp(_el$21, "flexGrow", 1);
        setProp(_el$21, "scrollY", true);
        insert(_el$21, createComponent(For, {
          get each() {
            return props.turns;
          },
          children: (turn, index) => {
            const row = () => formatRow(turn, props.layout.columns, index() === props.selected);
            return (() => {
              var _el$24 = createElement("box"), _el$25 = createElement("text"), _el$26 = createElement("text");
              insertNode(_el$24, _el$25);
              insertNode(_el$24, _el$26);
              setProp(_el$24, "flexDirection", "row");
              setProp(_el$25, "wrapMode", "none");
              insert(_el$25, () => row().prefix);
              setProp(_el$26, "wrapMode", "none");
              insert(_el$26, () => row().status);
              effect((_p$) => {
                var _v$8 = colorOf(props.palette, index() === props.selected ? "accent" : "text"), _v$9 = colorOf(props.palette, statusMark(turn.status).paletteKey);
                _v$8 !== _p$.e && (_p$.e = setProp(_el$25, "fg", _v$8, _p$.e));
                _v$9 !== _p$.t && (_p$.t = setProp(_el$26, "fg", _v$9, _p$.t));
                return _p$;
              }, {
                e: void 0,
                t: void 0
              });
              return _el$24;
            })();
          }
        }));
        effect((_$p) => setProp(_el$21, "backgroundColor", backgroundOf(props.palette), _$p));
        return _el$21;
      })()];
    }
  });
}
function StatisticsPanel(props) {
  const context = usePlugin();
  const state = createStatisticsState(context.client);
  const palette = createMemo(() => themePalette(context) ?? {});
  const currentLayout = createMemo(() => resolveLayout(props.width));
  createEffect(() => {
    const sessionID = props.sessionID;
    void state.fetchAnalysis(sessionID);
  });
  return (() => {
    var _el$27 = createElement("box");
    setProp(_el$27, "flexDirection", "column");
    setProp(_el$27, "flexGrow", 1);
    setProp(_el$27, "padding", 1);
    insert(_el$27, createComponent(Show, {
      get when() {
        return state.analysis();
      },
      get fallback() {
        return createComponent(StateMessage, {
          state,
          get palette() {
            return palette();
          }
        });
      },
      children: (analysis) => [createComponent(Banner, {
        get analysis() {
          return analysis();
        },
        get totals() {
          return state.totals();
        },
        get palette() {
          return palette();
        }
      }), createComponent(Show, {
        get when() {
          return state.error();
        },
        get children() {
          var _el$28 = createElement("text");
          insert(_el$28, () => state.error());
          effect((_$p) => setProp(_el$28, "fg", colorOf(palette(), "critical"), _$p));
          return _el$28;
        }
      }), createComponent(Show, {
        get when() {
          return state.loading();
        },
        get fallback() {
          return createComponent(Table, {
            get layout() {
              return currentLayout();
            },
            get turns() {
              return state.turns();
            },
            get selected() {
              return state.selectedIndex();
            },
            get palette() {
              return palette();
            }
          });
        },
        get children() {
          var _el$29 = createElement("text");
          insertNode(_el$29, createTextNode(`Loading…`));
          effect((_$p) => setProp(_el$29, "fg", colorOf(palette(), "muted"), _$p));
          return _el$29;
        }
      })]
    }));
    effect((_$p) => setProp(_el$27, "backgroundColor", backgroundOf(palette()), _$p));
    return _el$27;
  })();
}
function StatisticsView(props) {
  return createComponent(PluginContextProvider, {
    get value() {
      return props.context;
    },
    get children() {
      return createComponent(StatisticsPanel, {
        get sessionID() {
          return props.sessionID;
        },
        get width() {
          return props.width;
        }
      });
    }
  });
}
function statisticsPanelElement(context, input) {
  return createComponent(StatisticsView, {
    context,
    get sessionID() {
      return input.sessionID;
    },
    get width() {
      return input.width;
    }
  });
}

const StatisticsView$1 = /*#__PURE__*/Object.freeze(/*#__PURE__*/Object.defineProperty({
  __proto__: null,
  StatisticsView,
  statisticsPanelElement
}, Symbol.toStringTag, { value: 'Module' }));

export { buildTuiUrl, tui as default, themePalette };
