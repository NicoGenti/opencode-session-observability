import test from "node:test";
import assert from "node:assert/strict";
import { buildTuiUrl, themePalette } from "../src/plugin/tui.ts";

const BASE = "http://127.0.0.1:4517";

test("TUI URLs keep the token in the fragment", () => {
  assert.equal(
    buildTuiUrl(BASE, { type: "session", sessionID: "ses_1" }, "trajectory", "tok"),
    `${BASE}/#/s/ses_1/trajectory?token=tok`,
  );
  assert.equal(
    buildTuiUrl(BASE, { type: "home" }, "statistics", null),
    `${BASE}/#/`,
  );
});

test("TUI URLs carry the OpenCode theme without changing token-only URLs", () => {
  assert.equal(
    buildTuiUrl(BASE, { type: "session", sessionID: "ses_1" }, "trajectory", "tok", "dark"),
    `${BASE}/#/s/ses_1/trajectory?token=tok&theme=dark`,
  );
  assert.equal(
    buildTuiUrl(BASE, { type: "home" }, "statistics", null, "tokyonight"),
    `${BASE}/#/?theme=tokyonight`,
  );
  assert.equal(
    buildTuiUrl(BASE, { type: "home" }, "statistics", null, null, {
      page: "#000000",
      text: "#ffffff",
    }),
    `${BASE}/#/?palette=${encodeURIComponent('{"page":"#000000","text":"#ffffff"}')}`,
  );
});

test("TUI palette extraction mirrors the resolved OpenCode theme", () => {
  const palette = themePalette({
    themeMode: "light",
    theme: {
      background: { base: "#fafafa", raised: { base: "#f0f0f0", high: "#e0e0e0" } },
      text: {
        base: "#111111",
        muted: "#444444",
        faint: "#777777",
        action: { primary: { base: "#0055ff" } },
        feedback: {
          success: { base: "#008800" },
          warning: { base: "#aa6600" },
          error: { base: "#cc0000" },
        },
      },
      border: { base: "#dddddd" },
    },
  });
  assert.deepEqual(palette, {
    page: "#fafafa",
    text: "#111111",
    mode: "light",
    surface: "#f0f0f0",
    surface2: "#e0e0e0",
    text2: "#444444",
    muted: "#777777",
    border: "#dddddd",
    accent: "#0055ff",
    good: "#008800",
    warning: "#aa6600",
    critical: "#cc0000",
  });
  assert.equal(themePalette({ theme: null }), null);
});

test("TUI URLs encode session IDs and tokens", () => {
  assert.equal(
    buildTuiUrl(
      BASE,
      { type: "session", sessionID: "a b" },
      "statistics",
      "a&b",
    ),
    `${BASE}/#/s/a%20b/statistics?token=a%26b`,
  );
  assert.equal(
    buildTuiUrl(BASE, { type: "session" }, "statistics", "tok"),
    `${BASE}/#/?token=tok`,
  );
});
