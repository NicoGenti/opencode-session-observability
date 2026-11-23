import test from "node:test";
import assert from "node:assert/strict";
import { consumeTokenFromLocation } from "../src/web/lib/auth.ts";
import { ConfirmController } from "../src/web/lib/confirm.ts";
import {
  EXPORT_ITEMS,
  EXPORT_NOTE,
  SHORTCUT_ROWS,
  SKIP_LINK,
} from "../src/web/lib/copy.ts";
import { parseHash, readRoute } from "../src/web/lib/hash.ts";
import {
  CONTEXT_BASIS_OPTIONS,
  RESPONSE_LIMITS,
  guardrailCommit,
  guardrailEdit,
  guardrailInputs,
  normalizeResponseLimit,
  themeOptions,
} from "../src/web/lib/settings-form.ts";
import { getGuardrails } from "../src/web/lib/settings.ts";
import { THEMES } from "../src/web/lib/theme.ts";
import {
  buildSessionTree,
  groupSessions,
  projectKey,
  sessionMatchesQuery,
} from "../src/web/lib/sessions.ts";
import { resolveShortcut, type ShortcutState } from "../src/web/lib/shortcuts.ts";
import type { SessionSummary } from "../src/core/types.ts";

/* ------------------------------------------------------------------ fixtures */

function session(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return { id, timeCreated: 1, ...patch };
}

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

/* ------------------------------------------------------------ sessions store */

test("search matches the same fields as the legacy sidebar", () => {
  const item = session("ses_1", {
    title: "Refactor the parser",
    slug: "quiet-river",
    agent: "build",
    directory: "E:\\work\\app",
    projectID: "proj_1",
  });
  assert.equal(sessionMatchesQuery(item, ""), true);
  assert.equal(sessionMatchesQuery(item, "   "), true);
  assert.equal(sessionMatchesQuery(item, "PARSER"), true);
  assert.equal(sessionMatchesQuery(item, "quiet-river"), true);
  assert.equal(sessionMatchesQuery(item, "build"), true);
  assert.equal(sessionMatchesQuery(item, "e:\\work"), true);
  assert.equal(sessionMatchesQuery(item, "proj_1"), true);
  assert.equal(sessionMatchesQuery(item, "ses_1"), true);
  assert.equal(sessionMatchesQuery(item, "nothing"), false);
});

test("projectKey falls back from directory to project id to the placeholder", () => {
  assert.equal(projectKey(session("a", { directory: "E:\\app" })), "E:\\app");
  assert.equal(projectKey(session("a", { projectID: "proj" })), "proj");
  assert.equal(projectKey(session("a")), "(no project)");
});

test("grouping keeps the server order and starts collapsed", () => {
  const sessions = [
    session("a", { directory: "/one", timeUpdated: 30 }),
    session("b", { directory: "/two", timeUpdated: 20 }),
    session("c", { directory: "/one", timeUpdated: 10 }),
  ];
  const groups = groupSessions(sessions, {
    groupByProject: true,
    sessionTree: false,
    expandedProjects: new Set<string>(),
    query: "",
  });
  assert.deepEqual(
    groups.map((group) => group.key),
    ["/one", "/two"],
  );
  assert.deepEqual(
    groups[0].sessions.map((item) => item.id),
    ["a", "c"],
  );
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].showHeader, true);
  assert.equal(groups[0].expanded, false);
  assert.deepEqual(groups[0].nodes, []);

  // Deterministic: the same input and options yield the same output.
  assert.deepEqual(
    groupSessions(sessions, {
      groupByProject: true,
      sessionTree: false,
      expandedProjects: new Set<string>(),
      query: "",
    }),
    groups,
  );

  const expanded = groupSessions(sessions, {
    groupByProject: true,
    sessionTree: false,
    expandedProjects: new Set(["/one"]),
    query: "",
  });
  assert.equal(expanded[0].expanded, true);
  assert.equal(expanded[1].expanded, false);

  const searching = groupSessions(sessions, {
    groupByProject: true,
    sessionTree: false,
    expandedProjects: new Set<string>(),
    query: "ONE",
  });
  assert.equal(searching.length, 1);
  assert.equal(searching[0].expanded, true);
  assert.deepEqual(
    searching[0].sessions.map((item) => item.id),
    ["a", "c"],
  );

  const ungrouped = groupSessions(sessions, {
    groupByProject: false,
    sessionTree: false,
    expandedProjects: new Set<string>(),
    query: "",
  });
  assert.equal(ungrouped.length, 1);
  assert.equal(ungrouped[0].key, "");
  assert.equal(ungrouped[0].showHeader, false);
  assert.equal(ungrouped[0].expanded, true);
});

test("the session tree nests children and guards cycles", () => {
  const nodes = buildSessionTree([
    session("root-old", { timeUpdated: 10 }),
    session("root-new", { timeUpdated: 20 }),
    session("child-2", { parentID: "root-old", timeCreated: 3 }),
    session("child-1", { parentID: "root-old", timeCreated: 2 }),
    session("grandchild", { parentID: "child-1", timeCreated: 5 }),
  ]);
  assert.deepEqual(
    nodes.map((node) => node.session.id),
    ["root-new", "root-old"],
  );
  const rootOld = nodes[1];
  assert.deepEqual(
    rootOld.children.map((node) => node.session.id),
    ["child-1", "child-2"],
  );
  assert.equal(rootOld.children[0].depth, 1);
  assert.equal(rootOld.children[0].children[0].session.id, "grandchild");
  assert.equal(rootOld.children[0].children[0].depth, 2);

  // A self-reference and a two-node cycle both stay visible as roots.
  const cyclic = buildSessionTree([
    session("self", { parentID: "self", timeUpdated: 3 }),
    session("a", { parentID: "b", timeUpdated: 2 }),
    session("b", { parentID: "a", timeUpdated: 1 }),
  ]);
  assert.deepEqual(
    cyclic.map((node) => node.session.id),
    ["self", "a", "b"],
  );
  assert.equal(cyclic.every((node) => node.depth === 0), true);
});

/* ------------------------------------------------------- settings form helpers */

test("the settings form derives the legacy option lists", () => {
  assert.equal(normalizeResponseLimit(4_000), 4_000);
  assert.equal(normalizeResponseLimit("50000"), 50_000);
  assert.equal(normalizeResponseLimit(1), 20_000);
  assert.equal(normalizeResponseLimit("nope"), 20_000);
  assert.equal(normalizeResponseLimit(null), 20_000);
  assert.deepEqual([...RESPONSE_LIMITS], [4_000, 12_000, 20_000, 50_000, 80_000]);
  assert.deepEqual(
    CONTEXT_BASIS_OPTIONS.map((entry) => entry.id),
    ["latest", "cumulative"],
  );

  const withoutPalette = themeOptions(false);
  const withPalette = themeOptions(true);
  assert.equal(
    withoutPalette.some((entry) => entry.id === "opencode-current"),
    false,
  );
  assert.equal(withPalette.some((entry) => entry.id === "opencode-current"), true);
  assert.equal(withPalette.length, THEMES.length);
  const seeds = THEMES.filter(
    (entry) =>
      entry.id !== "auto" &&
      entry.id !== "light" &&
      entry.id !== "dark" &&
      entry.id !== "opencode-current",
  );
  assert.equal(seeds.length, 33);

  const inputs = guardrailInputs(getGuardrails());
  assert.equal(Object.keys(inputs).length, 6);
  assert.equal(inputs.tokensTotal, "2000000");
});

test("guardrail budgets commit on blur/Enter only and never per keystroke", () => {
  const stored = getGuardrails();
  let writes = 0;
  const write = (key: string, value: unknown) => {
    writes += 1;
    // A fractional cost is valid; an empty count budget is not.
    if (key === "costTotal" && String(value) === "12.5") {
      return { ok: true as const, value: 12.5 };
    }
    return { ok: false as const, message: "invalid" };
  };

  // A keystroke only edits the raw string: the writer is never called, so no
  // `gr.*` request can fire and the focused input is not rewritten.
  const start = { inputs: guardrailInputs(stored), errors: {} };
  const typing = guardrailEdit(start, "costTotal", "12.");
  assert.equal(writes, 0);
  assert.equal(typing.inputs.costTotal, "12.");
  const fractional = guardrailEdit(typing, "costTotal", "12.5");
  assert.equal(writes, 0);
  assert.equal(fractional.inputs.costTotal, "12.5");

  // Commit writes exactly once and normalizes the stored number.
  const committed = guardrailCommit(fractional, "costTotal", write, stored);
  assert.equal(writes, 1);
  assert.equal(committed.inputs.costTotal, "12.5");
  assert.deepEqual(committed.errors, {});

  // An invalid commit stores/sends nothing and restores the stored budget.
  const rejected = guardrailCommit(
    guardrailEdit(fractional, "retries", "2.5"),
    "retries",
    write,
    stored,
  );
  assert.equal(writes, 2);
  assert.equal(rejected.inputs.retries, String(stored.retries));
  assert.equal(rejected.errors.retries, "invalid");
});

/* ----------------------------------------------------------- confirm contract */

test("the confirm controller resolves accept, cancel and supersession", async () => {
  const controller = new ConfirmController();
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => {
    notifications += 1;
  });

  assert.equal(controller.getSnapshot(), null);
  const accepted = controller.request({ title: "Reveal", message: "Show secrets?" });
  assert.equal(controller.getSnapshot()?.title, "Reveal");
  assert.equal(controller.getSnapshot()?.acceptLabel, "Continue");
  assert.equal(controller.getSnapshot()?.danger, true);
  controller.settle(true);
  assert.equal(await accepted, true);
  assert.equal(controller.getSnapshot(), null);

  const cancelled = controller.request({
    title: "Reset",
    message: "Restore defaults?",
    acceptLabel: "Restore",
    danger: false,
  });
  assert.equal(controller.getSnapshot()?.acceptLabel, "Restore");
  assert.equal(controller.getSnapshot()?.danger, false);
  controller.settle(false);
  assert.equal(await cancelled, false);

  // A second request settles the first one with false instead of stacking.
  const first = controller.request({ title: "First", message: "one" });
  const second = controller.request({ title: "Second", message: "two" });
  assert.equal(await first, false);
  assert.equal(controller.getSnapshot()?.title, "Second");
  controller.settle(false);
  assert.equal(await second, false);

  // Settling with nothing open is a no-op.
  controller.settle(false);
  assert.equal(notifications, 7);
  unsubscribe();
});

/* ------------------------------------------------------- token before routing */

test("a fragment token is consumed before a route is read", () => {
  const store = memoryStorage();
  const location = {
    hash: "#/s/ses_1/statistics?event=msg%3A1&token=abc",
    pathname: "/",
    search: "",
  };
  const writes: string[] = [];
  const history = {
    replaceState(_state: unknown, _title: string, url: string) {
      writes.push(url);
      location.hash = url.slice(url.indexOf("#"));
    },
  };

  // `AuthProvider`'s state initializer is exactly this pair, above the router.
  const token = consumeTokenFromLocation(location, history, store);
  const route = readRoute(location.hash);

  assert.equal(token, "abc");
  assert.deepEqual(writes, ["/#/s/ses_1/statistics?event=msg%3A1"]);
  assert.deepEqual(route, {
    kind: "session",
    sessionID: "ses_1",
    view: "statistics",
    eventID: "msg:1",
    benchmarkQuery: "",
  });
  // The route parser never sees a token parameter.
  assert.equal(parseHash(location.hash).eventID, "msg:1");
});

/* ------------------------------------------------------------ copy contracts */

test("the shortcut dialog lists the full documented model", () => {
  assert.deepEqual(
    SHORTCUT_ROWS.map((row) => row.keys.join(" ")),
    ["/", "1", "2", "e", "t", "c", "r", "s", "j k", "Enter", "g G", "Esc", "?"],
  );
  for (const row of SHORTCUT_ROWS) {
    assert.ok(row.action.length > 0);
    assert.doesNotMatch(row.action, /!/);
    assert.notEqual(row.action, row.action.toUpperCase(), row.action);
  }

  // Every one-key row resolves to a command in the resting state, so the table
  // and the decision function cannot drift apart.
  const base: ShortcutState = {
    view: "trajectory",
    target: "other",
    overlay: null,
    selectedIndex: -1,
    eventCount: 0,
  };
  for (const row of SHORTCUT_ROWS) {
    if (row.keys.length !== 1 || row.keys[0].length !== 1) continue;
    const command = resolveShortcut({ key: row.keys[0] }, base);
    assert.notEqual(command, null, row.keys[0]);
  }
});

test("the skip link and export menu keep their documented shape", () => {
  assert.deepEqual(SKIP_LINK, { href: "#main", label: "Skip to content" });
  assert.deepEqual(
    EXPORT_ITEMS.map((item) => item.id),
    ["json", "markdown", "html"],
  );
  assert.deepEqual(
    EXPORT_ITEMS.map((item) => item.label),
    ["JSON (full analysis)", "Markdown report", "HTML report"],
  );
  assert.equal(EXPORT_NOTE, "Redacted by default");
});
