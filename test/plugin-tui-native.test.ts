import test from "node:test";
import assert from "node:assert/strict";
import {
  STATISTICS_ROUTE,
  TRAJECTORY_ROUTE,
  TUI_PLUGIN_ID,
  currentSessionID,
  hasNativeView,
  openNativeStatistics,
  registerNativeView,
  type NativeRouteContext,
  type RouteLike,
} from "../src/plugin/tui-native.ts";
import { tuiCommandDefinitions } from "../src/plugin/tui.ts";

type Recorder = {
  readonly context: NativeRouteContext;
  readonly navigations: unknown[];
  readonly toasts: unknown[];
};

/** A fake plugin context that records what the routing seam does. */
function fakeContext(route: RouteLike = { type: "home" }): Recorder {
  const navigations: unknown[] = [];
  const toasts: unknown[] = [];
  return {
    navigations,
    toasts,
    context: {
      ui: {
        router: {
          navigate: (destination: unknown) => {
            navigations.push(destination);
          },
          current: () => route,
        },
        toast: {
          show: (options: unknown) => {
            toasts.push(options);
          },
        },
      },
    },
  };
}

test("the reserved page names are pinned for sibling issues", () => {
  assert.equal(STATISTICS_ROUTE, "statistics");
  assert.equal(TRAJECTORY_ROUTE, "trajectory");
});

test("a registered native view stays visible until its cleanup runs", () => {
  const release = registerNativeView("lifecycle-view");
  try {
    assert.equal(hasNativeView("lifecycle-view"), true);
  } finally {
    release();
  }
  assert.equal(hasNativeView("lifecycle-view"), false);
});

test("two registrations need two cleanups", () => {
  const first = registerNativeView("refcount-view");
  const second = registerNativeView("refcount-view");
  first();
  assert.equal(hasNativeView("refcount-view"), true);
  second();
  assert.equal(hasNativeView("refcount-view"), false);
});

test("a cleanup releases one reference and blank names are rejected", () => {
  const release = registerNativeView("idempotent-view");
  const sibling = registerNativeView("idempotent-view");
  release();
  release();
  assert.equal(hasNativeView("idempotent-view"), true);
  sibling();
  assert.equal(hasNativeView("idempotent-view"), false);

  assert.throws(() => registerNativeView(""), TypeError);
  assert.throws(() => registerNativeView("   "), TypeError);
  assert.equal(hasNativeView(""), false);
  assert.equal(hasNativeView("   "), false);
  assert.equal(hasNativeView("never-registered"), false);
});

test("currentSessionID reads only session routes", () => {
  assert.equal(currentSessionID({ type: "session", sessionID: "ses_1" }), "ses_1");
  assert.equal(currentSessionID({ type: "home" }), null);
  assert.equal(currentSessionID({ type: "plugin", name: "statistics" }), null);
});

test("openNativeStatistics navigates when the statistics view is registered", () => {
  const release = registerNativeView(STATISTICS_ROUTE);
  try {
    const session = fakeContext({ type: "session", sessionID: "ses_1" });
    let fallbacks = 0;
    const navigated = openNativeStatistics(session.context, () => {
      fallbacks += 1;
    });
    assert.equal(navigated, true);
    assert.deepEqual(session.navigations, [
      {
        type: "plugin",
        id: TUI_PLUGIN_ID,
        name: STATISTICS_ROUTE,
        data: { sessionID: "ses_1" },
      },
    ]);
    assert.equal(session.toasts.length, 0);
    assert.equal(fallbacks, 0);

    const home = fakeContext({ type: "home" });
    assert.equal(openNativeStatistics(home.context), true);
    assert.deepEqual(home.navigations, [
      {
        type: "plugin",
        id: TUI_PLUGIN_ID,
        name: STATISTICS_ROUTE,
        data: { sessionID: null },
      },
    ]);
  } finally {
    release();
  }
});

test("openNativeStatistics toasts and falls back without a native view", () => {
  assert.equal(hasNativeView(STATISTICS_ROUTE), false);
  const session = fakeContext({ type: "session", sessionID: "ses_1" });
  let fallbacks = 0;
  const navigated = openNativeStatistics(session.context, () => {
    fallbacks += 1;
  });
  assert.equal(navigated, false);
  assert.equal(session.navigations.length, 0);
  assert.deepEqual(session.toasts, [
    {
      title: "Session observability",
      message: "Native view not installed yet.",
      variant: "info",
      duration: 8_000,
    },
  ]);
  assert.equal(fallbacks, 1);
});

test("/statistics sends native input through the native opener only", () => {
  const opened: string[] = [];
  const natives: Array<() => void | false | Promise<void>> = [];
  const commands = tuiCommandDefinitions(
    (view) => {
      opened.push(view);
    },
    (browserFallback) => {
      natives.push(browserFallback);
    },
  );
  const statistics = commands.find(
    (command) => command.id === "observability.statistics",
  );
  assert.ok(statistics);

  statistics.run(undefined);
  assert.deepEqual(opened, []);
  assert.equal(natives.length, 1);

  statistics.run("--web");
  assert.deepEqual(opened, ["statistics"]);

  natives[0]?.();
  assert.deepEqual(opened, ["statistics", "statistics"]);
});
