/**
 * Per-browser UI preferences.
 *
 * Everything here is a convenience: if localStorage is unavailable (private
 * mode, blocked storage, preview), the in-memory defaults still render a
 * complete UI. The keys keep the existing `observability-` prefix so older
 * `observability-theme` / `observability-response-limit` values survive.
 *
 * Theme names mirror OpenCode 2's built-in list. Each entry carries three seed
 * colours; applyTheme derives the surface/border scale from them, so adding a
 * theme is one line. The TUI can also send the exact resolved palette of the
 * running OpenCode theme (see applyPalette).
 */

export const THEMES = [
  { id: "auto", label: "System / Auto" },
  { id: "opencode-current", label: "OpenCode (current)" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "aura", label: "Aura", mode: "dark", page: "#15141b", text: "#edecee", accent: "#a277ff" },
  { id: "ayu", label: "Ayu", mode: "dark", page: "#0b0e14", text: "#bfbdb6", accent: "#e6b450" },
  { id: "carbonfox", label: "Carbonfox", mode: "dark", page: "#161616", text: "#f2f4f8", accent: "#78a9ff" },
  { id: "catppuccin", label: "Catppuccin", mode: "dark", page: "#1e1e2e", text: "#cdd6f4", accent: "#cba6f7" },
  { id: "catppuccin-frappe", label: "Catppuccin Frappé", mode: "dark", page: "#303446", text: "#c6d0f5", accent: "#ca9ee6" },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato", mode: "dark", page: "#24273a", text: "#cad3f5", accent: "#c6a0f6" },
  { id: "cobalt2", label: "Cobalt2", mode: "dark", page: "#193549", text: "#ffffff", accent: "#ffc600" },
  { id: "cursor", label: "Cursor", mode: "dark", page: "#1e1e1e", text: "#d4d4d4", accent: "#3794ff" },
  { id: "dracula", label: "Dracula", mode: "dark", page: "#282a36", text: "#f8f8f2", accent: "#bd93f9" },
  { id: "everforest", label: "Everforest", mode: "dark", page: "#2d353b", text: "#d3c6aa", accent: "#a7c080" },
  { id: "flexoki", label: "Flexoki", mode: "dark", page: "#100f0f", text: "#cecdc3", accent: "#d0a215" },
  { id: "github", label: "GitHub", mode: "dark", page: "#0d1117", text: "#e6edf3", accent: "#58a6ff" },
  { id: "gruvbox", label: "Gruvbox", mode: "dark", page: "#282828", text: "#ebdbb2", accent: "#fabd2f" },
  { id: "kanagawa", label: "Kanagawa", mode: "dark", page: "#1f1f28", text: "#dcd7ba", accent: "#7e9cd8" },
  { id: "lucent-orng", label: "Lucent Orng", mode: "dark", page: "#1a1410", text: "#f5e6d3", accent: "#ff8a3d" },
  { id: "material", label: "Material", mode: "dark", page: "#263238", text: "#eeffff", accent: "#82aaff" },
  { id: "matrix", label: "Matrix", mode: "dark", page: "#0d0208", text: "#00ff41", accent: "#00ff41" },
  { id: "mercury", label: "Mercury", mode: "light", page: "#f4f4f4", text: "#1b1b1b", accent: "#005fcc" },
  { id: "monokai", label: "Monokai", mode: "dark", page: "#272822", text: "#f8f8f2", accent: "#a6e22e" },
  { id: "nightowl", label: "Night Owl", mode: "dark", page: "#011627", text: "#d6deeb", accent: "#82aaff" },
  { id: "nord", label: "Nord", mode: "dark", page: "#2e3440", text: "#d8dee9", accent: "#88c0d0" },
  { id: "one-dark", label: "One Dark", mode: "dark", page: "#282c34", text: "#abb2bf", accent: "#61afef" },
  { id: "opencode", label: "OpenCode", mode: "dark", page: "#0f1115", text: "#e6e9ef", accent: "#6aa7ff" },
  { id: "orng", label: "Orng", mode: "dark", page: "#1a1210", text: "#f2e9e4", accent: "#ff7a1a" },
  { id: "osaka-jade", label: "Osaka Jade", mode: "dark", page: "#0b1512", text: "#c8e6d4", accent: "#3ddc97" },
  { id: "palenight", label: "Palenight", mode: "dark", page: "#292d3e", text: "#a6accd", accent: "#c792ea" },
  { id: "rosepine", label: "Rose Pine", mode: "dark", page: "#191724", text: "#e0def4", accent: "#c4a7e7" },
  { id: "solarized", label: "Solarized", mode: "dark", page: "#002b36", text: "#839496", accent: "#268bd2" },
  { id: "synthwave84", label: "Synthwave '84", mode: "dark", page: "#262335", text: "#ffffff", accent: "#ff7edb" },
  { id: "tokyonight", label: "Tokyo Night", mode: "dark", page: "#1a1b26", text: "#c0caf5", accent: "#7aa2f7" },
  { id: "vercel", label: "Vercel", mode: "dark", page: "#000000", text: "#ededed", accent: "#ffffff" },
  { id: "vesper", label: "Vesper", mode: "dark", page: "#101010", text: "#ffffff", accent: "#ffc799" },
  { id: "zenburn", label: "Zenburn", mode: "dark", page: "#3f3f3f", text: "#dcdccc", accent: "#8cd0d3" },
];

export const VIEW_MODES = [
  { id: "basic", label: "Basic" },
  { id: "advanced", label: "Advanced" },
];

const DEFAULTS = {
  settingsVersion: 0,
  theme: "auto",
  themeUserSet: false,
  palette: null,
  viewMode: "basic",
  contextBasis: "latest",
  responseLimit: 20_000,
  showEventRows: false,
  groupByProject: true,
  sessionTree: true,
  expandedProjects: [],
  expandedParents: [],
};

const KEY_PREFIX = "observability-";
const LEGACY_KEYS = {
  theme: "observability-theme",
  responseLimit: "observability-response-limit",
};

let activePalette = null;

const THEME_VARS = [
  "--page",
  "--surface",
  "--surface-2",
  "--surface-3",
  "--text",
  "--text-2",
  "--muted",
  "--border",
  "--border-strong",
  "--grid",
  "--accent",
  "--accent-weak",
  "--good",
  "--warning",
  "--serious",
  "--critical",
  "--shadow",
];

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function storageKey(key) {
  return LEGACY_KEYS[key] ?? `${KEY_PREFIX}${key}`;
}

function readRaw(key) {
  const store = storage();
  if (!store) return null;
  try {
    return store.getItem(storageKey(key));
  } catch {
    return null;
  }
}

function writeRaw(key, value) {
  const store = storage();
  if (!store || value === null) return;
  try {
    store.setItem(storageKey(key), value);
  } catch {
    // Preferences are best-effort.
  }
}

function parse(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function get(key) {
  const fallback = DEFAULTS[key];
  const raw = readRaw(key);
  return raw !== null ? parse(raw, fallback) : fallback;
}

export function set(key, value) {
  if (!(key in DEFAULTS)) return;
  writeRaw(key, JSON.stringify(value));
}

/**
 * One-time upgrade path for preferences written by the previous UI, which had
 * a manual light/dark toggle and no `themeUserSet` marker. Without this, the
 * first TUI deep link would silently overwrite the user's existing choice.
 */
export function migrate() {
  if (Number(get("settingsVersion")) >= 1) return;
  const storedTheme = parse(readRaw("theme"), "auto");
  if (storedTheme && storedTheme !== "auto") set("themeUserSet", true);
  set("settingsVersion", 1);
}

export function getTheme() {
  const theme = normalizeTheme(get("theme"));
  return theme === "opencode-current" && !get("palette") ? "auto" : theme;
}

export function setTheme(theme, userSet = true) {
  const normalized = normalizeTheme(theme);
  set("theme", normalized);
  if (normalized !== "opencode-current") {
    activePalette = null;
    set("palette", null);
  }
  if (userSet) set("themeUserSet", true);
  applyTheme(normalized);
  return normalized;
}

export function getViewMode() {
  return get("viewMode") === "advanced" ? "advanced" : "basic";
}

export function setViewMode(mode) {
  const next = mode === "advanced" ? "advanced" : "basic";
  set("viewMode", next);
  applyViewMode(next);
  return next;
}

export function isTheme(value) {
  return THEMES.some((theme) => theme.id === value);
}

export function normalizeTheme(value) {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  if (isTheme(normalized)) return normalized;
  // Accept OpenCode theme names that are not bundled here: they still select
  // the closest colour scheme instead of forcing the user back to Auto.
  if (/light|latte|dawn|day/.test(normalized)) return "light";
  if (/dark|mocha|night|dusk/.test(normalized)) return "dark";
  return "auto";
}

function clearThemeVars(root) {
  if (!root?.style) return;
  for (const name of THEME_VARS) root.style.removeProperty(name);
  root.style.removeProperty("color-scheme");
}

function setThemeVar(root, name, value) {
  if (root?.style && typeof value === "string" && value.length > 0) {
    root.style.setProperty(name, value);
  }
}

function themeEntry(theme) {
  return THEMES.find((entry) => entry.id === theme && entry.page) ?? null;
}

function parseHexColor(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((character) => character + character)
          .join("")
      : hex.slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function mixColor(text, page, percent) {
  return {
    r: Math.round(text.r * percent + page.r * (1 - percent)),
    g: Math.round(text.g * percent + page.g * (1 - percent)),
    b: Math.round(text.b * percent + page.b * (1 - percent)),
  };
}

function linearChannel(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  return (
    0.2126 * linearChannel(color.r) +
    0.7152 * linearChannel(color.g) +
    0.0722 * linearChannel(color.b)
  );
}

function contrastRatio(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function hexColor(color) {
  return `#${[color.r, color.g, color.b]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Secondary text must stay readable on the surface, not only on the page.
 * 50% text was too light on paper themes; raise the mix until AA holds.
 */
function mutedColor(text, page, dark) {
  const textColor = parseHexColor(text);
  const pageColor = parseHexColor(page);
  if (!textColor || !pageColor) {
    return `color-mix(in srgb, ${text} 68%, ${page})`;
  }
  const surface = mixColor(textColor, pageColor, dark ? 0.1 : 0.04);
  for (const percent of [0.66, 0.72, 0.78]) {
    const candidate = mixColor(textColor, pageColor, percent);
    if (contrastRatio(candidate, surface) >= 4.5) return hexColor(candidate);
  }
  return text;
}

function applyEntry(root, entry) {
  const dark = entry.mode !== "light";
  const mix = (percent) =>
    `color-mix(in srgb, ${entry.text} ${percent}%, ${entry.page})`;
  root.dataset.theme = entry.id;
  root.style.colorScheme = dark ? "dark" : "light";
  setThemeVar(root, "--page", entry.page);
  setThemeVar(root, "--surface", dark ? mix(10) : mix(4));
  setThemeVar(root, "--surface-2", dark ? mix(16) : mix(7));
  setThemeVar(root, "--surface-3", dark ? mix(22) : mix(10));
  setThemeVar(root, "--text", entry.text);
  setThemeVar(root, "--text-2", `color-mix(in srgb, ${entry.text} 78%, ${entry.page})`);
  setThemeVar(root, "--muted", mutedColor(entry.text, entry.page, dark));
  setThemeVar(root, "--border", `color-mix(in srgb, ${entry.text} 13%, transparent)`);
  setThemeVar(root, "--border-strong", `color-mix(in srgb, ${entry.text} 24%, transparent)`);
  setThemeVar(root, "--grid", dark ? mix(18) : mix(9));
  setThemeVar(root, "--accent", entry.accent);
  setThemeVar(root, "--accent-weak", `color-mix(in srgb, ${entry.accent} 16%, var(--surface))`);
  setThemeVar(root, "--shadow", `0 10px 30px ${dark ? "rgba(0, 0, 0, 0.5)" : "rgba(0, 0, 0, 0.14)"}`);
}

export function applyTheme(theme = getTheme()) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  const normalized = normalizeTheme(theme);
  clearThemeVars(root);
  root.dataset.theme = normalized;
  if (normalized === "opencode-current") {
    const palette = get("palette") ?? activePalette;
    if (palette) applyPalette(palette);
    else root.dataset.theme = "auto";
    return;
  }
  if (normalized === "auto" || normalized === "light" || normalized === "dark") return;
  const entry = themeEntry(normalized);
  if (entry) applyEntry(root, entry);
}

/**
 * Applies the exact colors OpenCode reports through the TUI context. The
 * payload comes from the URL fragment and is validated before use.
 */
export function applyPalette(palette) {
  const root = globalThis.document?.documentElement;
  if (!root || !palette || typeof palette !== "object") return;
  activePalette = palette;
  const color = (value) =>
    typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value.trim())
      ? value.trim()
      : null;
  const page = color(palette.page);
  const text = color(palette.text);
  if (!page || !text) return;
  clearThemeVars(root);
  const mode = palette.mode === "light" ? "light" : "dark";
  const accent = color(palette.accent) ?? "#6aa7ff";
  applyEntry(root, {
    id: "opencode-current",
    mode,
    page,
    text,
    accent,
  });
  const optional = {
    "--surface": color(palette.surface),
    "--surface-2": color(palette.surface2),
    "--surface-3": color(palette.surface3),
    "--text-2": color(palette.text2),
    "--muted": color(palette.muted),
    "--border": color(palette.border),
    "--border-strong": color(palette.borderStrong),
    "--grid": color(palette.grid),
    "--good": color(palette.good),
    "--warning": color(palette.warning),
    "--serious": color(palette.serious),
    "--critical": color(palette.critical),
  };
  for (const [name, value] of Object.entries(optional)) {
    if (value) setThemeVar(root, name, value);
  }
}

export function applyViewMode(mode = getViewMode()) {
  const body = globalThis.document?.body;
  if (body) body.dataset.viewMode = mode === "advanced" ? "advanced" : "basic";
}

function fragmentQuery(hash) {
  if (typeof hash !== "string" || hash.length === 0) return null;
  return hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
}

/** Reads `?theme=` from the route fragment so the TUI can mirror OpenCode. */
export function readThemeFromHash(hash) {
  const query = fragmentQuery(hash);
  if (!query) return null;
  const value = new URLSearchParams(query).get("theme");
  return value && value.trim() ? value.trim() : null;
}

/** Reads `?palette=` (URI-encoded JSON) from the route fragment. */
export function readPaletteFromHash(hash) {
  const query = fragmentQuery(hash);
  if (!query) return null;
  const raw = new URLSearchParams(query).get("palette");
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function reset() {
  for (const key of Object.keys(DEFAULTS)) {
    const store = storage();
    if (!store) continue;
    try {
      store.removeItem(storageKey(key));
    } catch {
      // Preferences are best-effort.
    }
  }
  activePalette = null;
  applyTheme("auto");
  applyViewMode("basic");
}
