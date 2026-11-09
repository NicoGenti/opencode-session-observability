import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error - plain browser module without type declarations
import * as settings from "../src/ui/settings.js";

const {
  applyPalette,
  applyTheme,
  applyViewMode,
  get,
  getTheme,
  migrate,
  normalizeTheme,
  readPaletteFromHash,
  readThemeFromHash,
  reset,
  set,
  setTheme,
  setViewMode,
} = settings;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

const storage = memoryStorage();
const variables = new Map<string, string>();
const root = {
  dataset: {} as Record<string, string>,
  style: {
    colorScheme: "",
    setProperty(name: string, value: string) {
      variables.set(name, value);
    },
    removeProperty(name: string) {
      variables.delete(name);
    },
  },
};
const body: { dataset: Record<string, string> } = { dataset: {} };
Object.assign(globalThis, {
  localStorage: storage,
  document: { documentElement: root, body },
});

test.beforeEach(() => {
  reset();
  root.dataset = {};
  root.style.colorScheme = "";
  variables.clear();
  body.dataset = {};
});

test("settings fall back to defaults and round-trip typed values", () => {
  assert.equal(get("viewMode"), "basic");
  assert.equal(get("responseLimit"), 20_000);
  assert.equal(getTheme(), "auto");

  set("viewMode", "advanced");
  set("responseLimit", 4_000);
  assert.equal(get("viewMode"), "advanced");
  assert.equal(get("responseLimit"), 4_000);
});

test("theme names are normalized and applied to the document", () => {
  assert.equal(normalizeTheme("Dracula"), "dracula");
  assert.equal(normalizeTheme("some-light-theme"), "light");
  assert.equal(normalizeTheme("some-dark-theme"), "dark");
  assert.equal(normalizeTheme("nonsense"), "auto");

  setTheme("nord");
  assert.equal(root.dataset.theme, "nord");
  assert.equal(variables.get("--page"), "#2e3440");
  applyTheme("auto");
  assert.equal(root.dataset.theme, "auto");
  assert.equal(variables.has("--page"), false);
});

test("a deep-link palette survives when localStorage is unavailable", () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  Object.assign(globalThis, { localStorage: undefined });
  try {
    applyPalette({ page: "#010203", text: "#fefefe", mode: "dark" });
    applyTheme("opencode-current");
    assert.equal(root.dataset.theme, "opencode-current");
    assert.equal(variables.get("--page"), "#010203");
  } finally {
    Object.assign(globalThis, { localStorage: original });
  }
});

test("the resolved OpenCode palette is applied and read from the fragment", () => {
  const palette = {
    page: "#123456",
    text: "#eeeeee",
    accent: "#ff8800",
    mode: "dark",
  };
  applyPalette(palette);
  assert.equal(root.dataset.theme, "opencode-current");
  assert.equal(variables.get("--page"), "#123456");
  assert.equal(variables.get("--text"), "#eeeeee");
  assert.equal(variables.get("--accent"), "#ff8800");

  const hash = `#/s/x?palette=${encodeURIComponent(JSON.stringify(palette))}`;
  assert.deepEqual(readPaletteFromHash(hash), palette);
  assert.equal(readPaletteFromHash("#/s/x?palette=nope"), null);
});

test("choosing a named theme clears a previously stored TUI palette", () => {
  set("palette", { page: "#010203", text: "#fefefe", mode: "dark" });
  applyPalette({ page: "#010203", text: "#fefefe", mode: "dark" });
  setTheme("dark", false);
  assert.equal(get("palette"), null);
  applyTheme("opencode-current");
  assert.equal(root.dataset.theme, "auto");
});

test("legacy manual themes are marked as user-selected once", () => {
  set("theme", "dark");
  migrate();
  assert.equal(get("themeUserSet"), true);
  assert.equal(get("settingsVersion"), 1);

  reset();
  set("theme", "auto");
  migrate();
  assert.equal(get("themeUserSet"), false);
});

test("view mode is persisted and reflected on the body", () => {
  assert.equal(setViewMode("advanced"), "advanced");
  assert.equal(body.dataset.viewMode, "advanced");
  setViewMode("nonsense");
  assert.equal(body.dataset.viewMode, "basic");
  applyViewMode();
  assert.equal(body.dataset.viewMode, "basic");
});

test("theme is read from the route fragment without touching other params", () => {
  assert.equal(readThemeFromHash("#/s/ses_1/trajectory?event=x&theme=tokyonight"), "tokyonight");
  assert.equal(readThemeFromHash("#/?theme=catppuccin"), "catppuccin");
  assert.equal(readThemeFromHash("#/s/ses_1/trajectory"), null);
  assert.equal(readThemeFromHash(""), null);
});

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function luminance(hex: string): number {
  const linear = (value: number) => {
    const ratio = value / 255;
    return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function mix(text: string, page: string, percent: number): string {
  const [tr, tg, tb] = channels(text);
  const [pr, pg, pb] = channels(page);
  const channel = (a: number, b: number) =>
    Math.round(a * percent + b * (1 - percent))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(tr, pr)}${channel(tg, pg)}${channel(tb, pb)}`;
}

test("derived themes keep muted text above AA on the derived surface", () => {
  const cases = [
    { page: "#f4f4f4", text: "#1b1b1b", mode: "light", surfacePercent: 0.04 },
    { page: "#101010", text: "#e6e6e6", mode: "dark", surfacePercent: 0.1 },
  ];
  for (const entry of cases) {
    applyPalette(entry);
    const muted = variables.get("--muted");
    assert.match(muted ?? "", /^#[0-9a-f]{6}$/);
    const surface = mix(entry.text, entry.page, entry.surfacePercent);
    assert.ok(
      contrast(muted!, surface) >= 4.5,
      `${entry.page} muted is ${contrast(muted!, surface).toFixed(2)}:1 on ${surface}`,
    );
  }
});
