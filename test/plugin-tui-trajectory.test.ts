import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  PANEL_FALLBACK,
  STATISTICS_PANEL,
  TRAJECTORY_PANEL,
  activePanelKeyboard,
  openPanelOrFallback,
  tuiCommandDefinitions,
  type PanelKeyboardBridge,
  type PanelToastOptions,
} from "../src/plugin/tui.ts";

const COMMAND_IDS = ["observability.trajectory", "observability.open"] as const;

test("the native panel ids stay pinned for both slot claims", () => {
  assert.equal(STATISTICS_PANEL, "statistics");
  assert.equal(TRAJECTORY_PANEL, "trajectory");
});

test("/trajectory opens the native panel first and falls back to the browser", () => {
  const opened: string[] = [];
  const natives: Array<() => void | false | Promise<void>> = [];
  const commands = tuiCommandDefinitions(
    (view) => {
      opened.push(view);
    },
    undefined,
    (browserFallback) => {
      natives.push(browserFallback);
    },
  );
  const trajectory = commands.find(
    (command) => command.id === "observability.trajectory",
  );
  assert.ok(trajectory);
  assert.equal(trajectory.slash.arguments, true);

  trajectory.run(undefined);
  assert.deepEqual(opened, []);
  assert.equal(natives.length, 1);

  natives[0]!();
  assert.deepEqual(opened, ["trajectory"]);
});

test("/observability takes the same native-first path as /trajectory", () => {
  const opened: string[] = [];
  const natives: Array<() => void | false | Promise<void>> = [];
  const commands = tuiCommandDefinitions(
    (view) => {
      opened.push(view);
    },
    undefined,
    (browserFallback) => {
      natives.push(browserFallback);
    },
  );
  const observability = commands.find(
    (command) => command.id === "observability.open",
  );
  assert.ok(observability);
  assert.deepEqual(observability.slash.aliases, ["obs"]);
  assert.equal(observability.slash.arguments, true);

  // Only junk input is native; it must not reach the browser before the opener.
  observability.run("junk");
  assert.deepEqual(opened, []);
  assert.equal(natives.length, 1);

  natives[0]!();
  assert.deepEqual(opened, ["trajectory"]);
});

test("--web forces the browser for /trajectory and /observability", () => {
  const opened: string[] = [];
  let natives = 0;
  const commands = tuiCommandDefinitions(
    (view) => {
      opened.push(view);
    },
    () => {
      natives += 1;
    },
    () => {
      natives += 1;
    },
  );

  for (const id of COMMAND_IDS) {
    const command = commands.find((candidate) => candidate.id === id);
    assert.ok(command, id);
    command.run("--web");
  }

  assert.deepEqual(opened, ["trajectory", "trajectory"]);
  assert.equal(natives, 0);
});

test("the fallback toasts once and hands over to the browser", () => {
  const toasts: PanelToastOptions[] = [];
  let fallbacks = 0;

  const opened = openPanelOrFallback(
    "trajectory",
    () => false,
    (options) => {
      toasts.push(options);
    },
    () => {
      fallbacks += 1;
    },
  );

  assert.equal(opened, false);
  assert.deepEqual(toasts, [
    {
      title: "Session observability",
      message: "No session is selected, so there is no trajectory to show.",
      variant: "info",
      duration: 6_000,
    },
  ]);
  assert.equal(fallbacks, 1);

  // /statistics keeps its issue-9 wording, so this change cannot regress it.
  assert.deepEqual(PANEL_FALLBACK.statistics, {
    message: "No session is selected, so there is no statistics to show.",
    variant: "warning",
  });

  // A successful open shows no toast and never touches the browser.
  toasts.length = 0;
  fallbacks = 0;
  assert.equal(
    openPanelOrFallback(
      "trajectory",
      () => true,
      (options) => {
        toasts.push(options);
      },
      () => {
        fallbacks += 1;
      },
    ),
    true,
  );
  assert.deepEqual(toasts, []);
  assert.equal(fallbacks, 0);
});

test("the keymap layer dispatches through the open panel's bridge", () => {
  const calls: string[] = [];
  const statistics: PanelKeyboardBridge = {
    handlers: {
      moveSelection: (delta) => {
        calls.push(`statistics:${delta}`);
      },
      toggleExpand: () => {
        calls.push("statistics:toggle");
      },
    },
  };
  const trajectory: PanelKeyboardBridge = {
    handlers: {
      moveSelection: (delta) => {
        calls.push(`trajectory:${delta}`);
      },
      toggleExpand: () => {
        calls.push("trajectory:toggle");
      },
    },
  };
  const active = (name: string | undefined) =>
    activePanelKeyboard(name, { statistics, trajectory });

  assert.equal(active("statistics"), statistics);
  assert.equal(active("trajectory"), trajectory);
  assert.equal(active("home"), null);
  assert.equal(active(undefined), null);

  active("trajectory")?.handlers?.moveSelection(1);
  active("statistics")?.handlers?.toggleExpand();
  assert.deepEqual(calls, ["trajectory:1", "statistics:toggle"]);
});

test("both panels claim session.panel without colliding", async () => {
  const source = await readFile(
    new URL("../src/plugin/tui.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    (source.match(/append: "session\.panel"/g) ?? []).length,
    2,
    "the host must receive one claim per native panel",
  );
  assert.match(source, /input\.name === STATISTICS_PANEL/);
  assert.match(source, /input\.name === TRAJECTORY_PANEL/);
  assert.match(
    source,
    /statisticsPanelElement\(context, input, statisticsKeyboard\)/,
  );
  assert.match(
    source,
    /trajectoryPanelElement\(context, input, trajectoryKeyboard\)/,
  );
  assert.match(
    source,
    /await import\(\s*"\.\/tui\/trajectory\/TrajectoryView\.tsx"\s*\)/,
  );
});
