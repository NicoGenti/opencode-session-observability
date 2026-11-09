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
