import test from "node:test";
import assert from "node:assert/strict";
import { buildTuiUrl } from "../src/plugin/tui.ts";

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
