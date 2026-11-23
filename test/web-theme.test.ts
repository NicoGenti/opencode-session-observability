import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { get, set } from "../src/web/lib/settings.ts";
import {
  THEMES,
  applyPalette,
  applyTheme,
  normalizeTheme,
  readPaletteFromHash,
  readThemeFromHash,
  resetAll,
  selectServerTheme,
  setTheme,
  themeLabel,
} from "../src/web/lib/theme.ts";

/* --------------------------------------------------------------- fake host */

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
    keys() {
      return [...values.keys()];
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
  resetAll();
  root.dataset = {};
  root.style.colorScheme = "";
  variables.clear();
  body.dataset = {};
});

/* ------------------------------------------------------------ CSS contract */

const css = await readFile(
  new URL("../src/web/styles/index.css", import.meta.url),
  "utf8",
);

/** `--name: value;` pairs inside one sliced block, whitespace normalized. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.replace(/\s+/g, " ").trim());
  }
  return out;
}

const lightStart = css.indexOf(":root {");
const mediaStart = css.indexOf("@media (prefers-color-scheme: dark)");
const attributeStart = css.indexOf(':root[data-theme="dark"]');
assert.ok(
  lightStart >= 0 && mediaStart > lightStart && attributeStart > mediaStart,
  "the light, media-query and attribute token blocks must all exist in order",
);

const light = declarations(css.slice(lightStart, mediaStart));
const mediaDark = declarations(css.slice(mediaStart, attributeStart));
const attributeDark = declarations(
  css.slice(attributeStart, css.indexOf("}", attributeStart) + 1),
);

const LIGHT_VALUES: Record<string, string> = {
  "--page": "#f9f9f7",
  "--surface": "#fcfcfb",
  "--surface-2": "#f3f3f0",
  "--surface-3": "#ecebe6",
  "--text": "#0b0b0b",
  "--text-2": "#52514e",
  "--muted": "#6b6a66",
  "--border": "rgba(11, 11, 11, 0.10)",
  "--border-strong": "rgba(11, 11, 11, 0.18)",
  "--grid": "#e1e0d9",
  "--accent": "#1f6ac2",
  "--accent-weak": "color-mix(in srgb, var(--accent) 10%, var(--surface))",
  "--good": "#0a7f0a",
  "--warning": "#fab219",
  "--serious": "#ec835a",
  "--critical": "#c23535",
  "--radius": "10px",
  "--radius-sm": "6px",
  "--shadow": "0 10px 30px rgba(11, 11, 11, 0.10)",
  "--mono":
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  "--sans": 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

const DARK_VALUES: Record<string, string> = {
  "--page": "#0d0d0d",
  "--surface": "#1a1a19",
  "--surface-2": "#232322",
  "--surface-3": "#2c2c2a",
  "--text": "#f0efec",
  "--text-2": "#c3c2b7",
  "--muted": "#898781",
  "--border": "rgba(255, 255, 255, 0.10)",
  "--border-strong": "rgba(255, 255, 255, 0.18)",
  "--grid": "#2c2c2a",
  "--accent": "#3987e5",
  "--accent-weak": "color-mix(in srgb, var(--accent) 16%, var(--surface))",
  "--good": "#0ca30c",
  "--critical": "#ef6a6a",
  "--shadow": "0 10px 30px rgba(0, 0, 0, 0.45)",
};

/** Dark inherits these from `:root`, exactly as the legacy stylesheet did. */
const DARK_INHERITED = [
  "--warning",
  "--serious",
  "--radius",
  "--radius-sm",
  "--mono",
  "--sans",
];

test("every DESIGN.md token keeps its legacy name and light value verbatim", () => {
  assert.equal(Object.keys(LIGHT_VALUES).length, 21);
  for (const [name, value] of Object.entries(LIGHT_VALUES)) {
    const actual = light.get(name);
    assert.ok(actual !== undefined, `${name} missing from :root`);
    assert.equal(actual, value, `${name} drifted from the legacy value`);
  }
});

test("dark values are defined under both the media query and data-theme", () => {
  for (const [name, value] of Object.entries(DARK_VALUES)) {
    assert.equal(mediaDark.get(name), value, `${name} (media query)`);
    assert.equal(attributeDark.get(name), value, `${name} (data-theme="dark")`);
  }
  for (const name of DARK_INHERITED) {
    assert.equal(mediaDark.has(name), false, `${name} must stay inherited`);
    assert.equal(attributeDark.has(name), false, `${name} must stay inherited`);
    assert.ok(light.has(name), `${name} still defined once in :root`);
  }
});

test("every token is registered as a Tailwind theme key, token-only", () => {
  assert.match(css, /@import "tailwindcss";/);
  // The emitted utility set must depend only on the intended source tree.
  assert.match(css, /@source "\.\.\/";/);
  // Tailwind's stock palette and elevation scale are removed, so a missing
  // token cannot fall back to a stock colour.
  assert.match(css, /--color-\*:\s*initial;/);
  assert.match(css, /--shadow-\*:\s*initial;/);
  assert.match(css, /@theme inline \{/);

  const colours = Object.keys(LIGHT_VALUES).filter((name) =>
    [
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
    ].includes(name),
  );
  assert.equal(colours.length, 16);
  for (const name of colours) {
    assert.ok(
      css.includes(`--color-${name.slice(2)}: var(${name});`),
      `${name} has no --color-* theme key`,
    );
  }

  assert.ok(css.includes("--font-sans: var(--sans);"));
  assert.ok(css.includes("--font-mono: var(--mono);"));
  assert.ok(css.includes("--radius-sm: 6px;"));
  assert.ok(css.includes("--radius-lg: 10px;"));
  assert.ok(css.includes("--shadow-float: var(--shadow);"));
});

test("dark mode uses the data-theme attribute, never a dark class", () => {
  assert.ok(css.includes(':root[data-theme="dark"]'));
  assert.ok(css.includes(':root:where(:not([data-theme="light"]))'));
  assert.doesNotMatch(css, /\.dark\b/);
});

/* --------------------------------------------------------------- selection */

test("theme names are normalized against the bundled list", () => {
  assert.equal(normalizeTheme("Dracula"), "dracula");
  assert.equal(normalizeTheme("some-light-theme"), "light");
  assert.equal(normalizeTheme("some-dark-theme"), "dark");
  assert.equal(normalizeTheme("nonsense"), "auto");
  assert.equal(normalizeTheme(42), "auto");
  assert.equal(themeLabel("nord"), "Nord");
  assert.equal(themeLabel("nonsense"), "System / Auto");
});

const NAMED_THEMES = [
  "aura",
  "ayu",
  "carbonfox",
  "catppuccin",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "cobalt2",
  "cursor",
  "dracula",
  "everforest",
  "flexoki",
  "github",
  "gruvbox",
  "kanagawa",
  "lucent-orng",
  "material",
  "matrix",
  "mercury",
  "monokai",
  "nightowl",
  "nord",
  "one-dark",
  "opencode",
  "orng",
  "osaka-jade",
  "palenight",
  "rosepine",
  "solarized",
  "synthwave84",
  "tokyonight",
  "vercel",
  "vesper",
  "zenburn",
];

test("the four mode entries and every seed palette are ported unchanged", () => {
  assert.deepEqual(
    THEMES.slice(0, 4).map((entry) => entry.id),
    ["auto", "opencode-current", "light", "dark"],
  );
  assert.deepEqual(
    THEMES.filter((entry) => entry.page !== undefined).map((entry) => entry.id),
    NAMED_THEMES,
  );
  assert.equal(THEMES.length, NAMED_THEMES.length + 4);
});

test("applying a seed theme derives the surface scale and color-scheme", () => {
  setTheme("nord");
  assert.equal(root.dataset.theme, "nord");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(variables.get("--page"), "#2e3440");
  assert.equal(variables.get("--text"), "#d8dee9");
  assert.equal(variables.get("--accent"), "#88c0d0");
  assert.equal(
    variables.get("--surface"),
    "color-mix(in srgb, #d8dee9 10%, #2e3440)",
  );

  setTheme("mercury");
  assert.equal(root.style.colorScheme, "light");
  assert.equal(
    variables.get("--surface"),
    "color-mix(in srgb, #1b1b1b 4%, #f4f4f4)",
  );

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

test("the resolved OpenCode palette is validated and applied", () => {
  const palette = {
    page: "#123456",
    text: "#eeeeee",
    accent: "#ff8800",
    mode: "dark",
    surface2: "#222222",
    borderStrong: "#333333",
  };
  applyPalette(palette);
  assert.equal(root.dataset.theme, "opencode-current");
  assert.equal(variables.get("--page"), "#123456");
  assert.equal(variables.get("--text"), "#eeeeee");
  assert.equal(variables.get("--accent"), "#ff8800");
  assert.equal(variables.get("--surface-2"), "#222222");
  assert.equal(variables.get("--border-strong"), "#333333");

  applyTheme("auto");
  applyPalette({ page: "not-a-colour", text: "#eeeeee", mode: "dark" });
  assert.equal(root.dataset.theme, "auto");
  assert.equal(variables.has("--page"), false);
});

test("the boot server theme applies only without a user pick or a deep link", () => {
  assert.equal(
    selectServerTheme("nord", { themeUserSet: false, linkedTheme: false }),
    "nord",
  );
  assert.equal(
    selectServerTheme("Some Light Theme", { themeUserSet: false, linkedTheme: false }),
    "light",
  );
  assert.equal(selectServerTheme("nord", { themeUserSet: true, linkedTheme: false }), null);
  assert.equal(selectServerTheme("nord", { themeUserSet: false, linkedTheme: true }), null);
  assert.equal(selectServerTheme("", { themeUserSet: false, linkedTheme: false }), null);
  assert.equal(selectServerTheme(42, { themeUserSet: false, linkedTheme: false }), null);
});

test("choosing a named theme clears a previously stored TUI palette", () => {
  set("palette", { page: "#010203", text: "#fefefe", mode: "dark" });
  applyPalette({ page: "#010203", text: "#fefefe", mode: "dark" });
  setTheme("dark", false);
  assert.equal(get("palette"), null);
  applyTheme("opencode-current");
  assert.equal(root.dataset.theme, "auto");
});

test("theme and palette readers ignore everything but the fragment query", () => {
  assert.equal(
    readThemeFromHash("#/s/ses_1/trajectory?event=x&theme=tokyonight"),
    "tokyonight",
  );
  assert.equal(readThemeFromHash("#/?theme=catppuccin"), "catppuccin");
  assert.equal(readThemeFromHash("#/s/ses_1/trajectory"), null);
  assert.equal(readThemeFromHash(""), null);

  const palette = { page: "#123456", text: "#eeeeee", mode: "dark" };
  assert.deepEqual(
    readPaletteFromHash(`#/s/x?palette=${encodeURIComponent(JSON.stringify(palette))}`),
    palette,
  );
  assert.equal(readPaletteFromHash("#/s/x?palette=nope"), null);
  assert.equal(readPaletteFromHash("#/s/x?theme=nord"), null);
});

/* ---------------------------------------------------------- WCAG luminance */

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

test("every bundled seed theme derives muted from the text, not 50%", () => {
  for (const entry of THEMES) {
    if (entry.page === undefined || entry.text === undefined) continue;
    applyPalette({ page: entry.page, text: entry.text, mode: entry.mode });
    const muted = variables.get("--muted")!;
    assert.match(muted, /^#[0-9a-f]{6}$/, entry.id);
    const surface = mix(entry.text, entry.page, entry.mode === "light" ? 0.04 : 0.1);
    if (entry.id === "solarized") {
      // Pre-existing exception carried over unchanged from src/ui/settings.js:
      // Solarized's own text is 4.10:1, so every 66-78% mix is below AA and the
      // derivation falls back to the theme text. Not a Phase 1 regression.
      assert.equal(muted, entry.text);
      continue;
    }
    assert.ok(
      contrast(muted, surface) >= 4.5,
      `${entry.id} muted is ${contrast(muted, surface).toFixed(2)}:1 on ${surface}`,
    );
  }
});

/* ------------------------------------------------------- frosted contract */

test("the frosted tokens land in the light block and in both dark blocks", () => {
  const TINT = "color-mix(in srgb, var(--surface) 90%, transparent)";
  const blocks: Array<[string, Map<string, string>]> = [
    ["light :root", light],
    ["prefers-color-scheme dark", mediaDark],
    ['[data-theme="dark"]', attributeDark],
  ];
  for (const [label, block] of blocks) {
    // A token missing from one block silently un-frosts that theme, so every
    // block that defines `--surface` must define both glass tokens too.
    assert.equal(block.get("--glass-tint"), TINT, `--glass-tint (${label})`);
    assert.equal(block.get("--glass-blur"), "12px", `--glass-blur (${label})`);
  }
});

test("one shared class carries the frost, with two opaque fallbacks", () => {
  const rule = /\.floating-frost \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.ok(rule !== "", ".floating-frost is missing from index.css");
  assert.ok(rule.includes("background-color: var(--glass-tint);"), "translucent tint");
  assert.ok(rule.includes("-webkit-backdrop-filter: blur(var(--glass-blur));"), "Safari frost");
  assert.ok(rule.includes("backdrop-filter: blur(var(--glass-blur));"), "Chromium frost");

  // Declared once and overridden twice (the two fallbacks), never copied.
  assert.equal(css.match(/\.floating-frost \{/g)?.length, 3);
  assert.equal(
    rule.split("backdrop-filter: blur(var(--glass-blur))").length - 1,
    2,
    "-webkit- and standard frost inside the one class",
  );
  // The one shadow token stays the only elevation: the class adds none.
  assert.equal(css.includes("box-shadow"), false);

  const supports =
    /@supports not \(\(backdrop-filter: blur\(4px\)\) or \(-webkit-backdrop-filter: blur\(4px\)\)\) \{([\s\S]*?)\n\}/.exec(
      css,
    )?.[1] ?? "";
  const reduced =
    /@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  for (const [label, block] of [
    ["@supports not (backdrop-filter)", supports],
    ["prefers-reduced-transparency", reduced],
  ] as const) {
    assert.ok(block.includes("background-color: var(--surface);"), `${label} paints the surface`);
    assert.ok(block.includes("-webkit-backdrop-filter: none;"), `${label} drops the frost`);
    assert.ok(block.includes("backdrop-filter: none;"), `${label} drops the standard frost`);
    assert.equal(
      block.split("backdrop-filter: none;").length - 1,
      2,
      `${label} drops both the webkit and the standard filter`,
    );
  }
});

test("the scrim blurs the backdrop, and both guards reset only the filter", () => {
  const rule = /\.frosted-scrim \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.ok(rule !== "", ".frosted-scrim is missing from index.css");
  assert.ok(rule.includes("-webkit-backdrop-filter: blur(var(--glass-blur));"), "Safari blur");
  assert.ok(rule.includes("backdrop-filter: blur(var(--glass-blur));"), "Chromium blur");
  assert.equal(
    rule.split("backdrop-filter: blur(var(--glass-blur))").length - 1,
    2,
    "-webkit- and standard blur inside the one scrim class",
  );
  // The tint stays on the overlay utilities and the radius on `--glass-blur`:
  // the scrim owns no colour and no second blur token.
  assert.equal(rule.includes("background-color"), false, "the scrim must own no background");

  // Declared once and reset twice, one guard each.
  assert.equal(css.match(/\.frosted-scrim \{/g)?.length, 3);

  const supports = [
    ...css.matchAll(
      /@supports not \(\(backdrop-filter: blur\(4px\)\) or \(-webkit-backdrop-filter: blur\(4px\)\)\) \{([\s\S]*?)\n\}/g,
    ),
  ]
    .map((match) => match[1] ?? "")
    .find((block) => block.includes(".frosted-scrim")) ?? "";
  const transparency = [
    ...css.matchAll(/@media \(prefers-reduced-transparency: reduce\) \{([\s\S]*?)\n\}/g),
  ]
    .map((match) => match[1] ?? "")
    .find((block) => block.includes(".frosted-scrim")) ?? "";

  for (const [label, block] of [
    ["@supports not (backdrop-filter)", supports],
    ["prefers-reduced-transparency", transparency],
  ] as const) {
    assert.ok(block !== "", `${label} carries no .frosted-scrim guard`);
    assert.ok(block.includes("-webkit-backdrop-filter: none;"), `${label} drops the blur`);
    assert.ok(block.includes("backdrop-filter: none;"), `${label} drops the standard blur`);
    assert.equal(
      block.split("backdrop-filter: none;").length - 1,
      2,
      `${label} drops both the webkit and the standard filter`,
    );
    // A scrim has nothing to make opaque: the dim survives, only the blur goes.
    assert.equal(block.includes("background-color"), false, `${label} must keep the tint`);
  }
});

test("no backdrop-filter lives outside the two frost blocks", () => {
  // Two class bodies (webkit + standard), the two `@supports` probes that name
  // the property once per operand, and the four guard bodies resetting both.
  const declarations = css.match(/backdrop-filter:/g)?.length ?? 0;
  assert.equal(declarations, 16, "no backdrop-filter outside the two frost blocks");
  const frosts = css.match(/blur\(var\(--glass-blur\)\)/g)?.length ?? 0;
  assert.equal(frosts, 4, "one blur radius, two consumers");
  const resets = css.match(/backdrop-filter: none;/g)?.length ?? 0;
  assert.equal(resets, 8, "both prefixes reset in each of the four guards");
  const tokens = [
    ...new Set(
      [...css.matchAll(/(--[a-z0-9-]*blur[a-z0-9-]*)\s*:/g)].map((match) => match[1] ?? ""),
    ),
  ].sort();
  assert.deepEqual(tokens, ["--glass-blur"], "one blur token only");
});

/** Every floating surface, plus the overlay tint it keeps; the seven tinted ones scrim. */
const FLOATING_SURFACES: Array<[string, string | null]> = [
  ["AdvancedFiltersDialog.tsx", "bg-page/70"],
  ["CompareModal.tsx", "bg-page/70"],
  ["ConfirmDialog.tsx", "bg-page/70"],
  ["EventDrawer.tsx", "bg-page/70"],
  ["ExportMenu.tsx", null],
  ["SettingsDialog.tsx", "bg-page/70"],
  ["ShortcutsDialog.tsx", "bg-page/70"],
  ["Toast.tsx", null],
  ["TokenPromptDialog.tsx", "bg-text/40"],
];

test("every floating surface opts into the shared classes and keeps its overlay", async () => {
  for (const [file, overlay] of FLOATING_SURFACES) {
    const source = await readFile(
      new URL(`../src/web/components/${file}`, import.meta.url),
      "utf8",
    );
    assert.equal(
      source.split("floating-frost").length - 1,
      1,
      `${file} must carry .floating-frost exactly once`,
    );
    // The treatment is the shared class alone: no component restates the frost
    // or reaches for an arbitrary var utility.
    assert.equal(source.includes("backdrop-filter"), false, `${file} restates the frost`);
    assert.equal(source.includes("--glass-"), false, `${file} reads a glass token directly`);
    if (overlay) {
      assert.ok(source.includes(overlay), `${file} must keep its ${overlay} overlay`);
      assert.equal(
        source.split("frosted-scrim").length - 1,
        1,
        `${file} must carry .frosted-scrim exactly once`,
      );
    } else {
      // The menu popover and the toast have no scrim to blur.
      assert.equal(source.includes("frosted-scrim"), false, `${file} must not carry a scrim`);
    }
  }

  // The table above names nine surfaces; this scan proves the class did not
  // leak into any *other* component: the scrim belongs to the seven tinted
  // overlays and nowhere else.
  const components = new URL("../src/web/components/", import.meta.url);
  const scrimmed: string[] = [];
  for (const entry of await readdir(components, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue;
    const text = await readFile(new URL(entry.name, components), "utf8");
    if (text.includes("frosted-scrim")) scrimmed.push(entry.name);
  }
  assert.deepEqual(
    scrimmed.sort(),
    [
      "AdvancedFiltersDialog.tsx",
      "CompareModal.tsx",
      "ConfirmDialog.tsx",
      "EventDrawer.tsx",
      "SettingsDialog.tsx",
      "ShortcutsDialog.tsx",
      "TokenPromptDialog.tsx",
    ],
    "the scrim belongs to the seven tinted overlays only",
  );
});
