import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_FILTER_TOGGLES,
  activeFilterLabels,
  applyFilterShortcut,
  resolveShortcut,
  type ShortcutState,
} from "../src/web/lib/shortcuts.ts";

const BASE: ShortcutState = Object.freeze({
  view: "trajectory",
  target: "other",
  overlay: null,
  selectedIndex: -1,
  eventCount: 0,
});

function state(patch: Partial<ShortcutState>): ShortcutState {
  return { ...BASE, ...patch };
}

/* ---------------------------------------------------------- documented table */

const TABLE: ReadonlyArray<{
  key: string;
  expected: ReturnType<typeof resolveShortcut>;
}> = [
  { key: "/", expected: { type: "focus-search", preventDefault: true } },
  { key: "1", expected: { type: "set-view", view: "trajectory", preventDefault: false } },
  { key: "2", expected: { type: "set-view", view: "statistics", preventDefault: false } },
  { key: "e", expected: { type: "toggle-filter", filter: "errorsOnly", preventDefault: false } },
  { key: "c", expected: { type: "toggle-filter", filter: "compactionsOnly", preventDefault: false } },
  { key: "r", expected: { type: "toggle-filter", filter: "retriesOnly", preventDefault: false } },
  { key: "s", expected: { type: "toggle-filter", filter: "subagentsOnly", preventDefault: false } },
  { key: "t", expected: { type: "toggle-filter", filter: "tools", preventDefault: false } },
  { key: "?", expected: { type: "toggle-shortcuts", preventDefault: true } },
  { key: "Escape", expected: { type: "close-sidebar", preventDefault: false } },
];

test("the documented shortcuts resolve to their commands", () => {
  for (const row of TABLE) {
    assert.deepEqual(resolveShortcut({ key: row.key }, BASE), row.expected, row.key);
  }
});

test("session navigation and jump keys need events and the trajectory view", () => {
  const withEvents = state({ eventCount: 3, selectedIndex: -1 });
  assert.deepEqual(resolveShortcut({ key: "j" }, withEvents), {
    type: "select-event",
    index: 0,
    preventDefault: true,
  });
  // `k` from nothing also lands on the first event (legacy clamps at zero).
  assert.deepEqual(resolveShortcut({ key: "k" }, withEvents), {
    type: "select-event",
    index: 0,
    preventDefault: true,
  });
  assert.deepEqual(
    resolveShortcut({ key: "j" }, state({ eventCount: 3, selectedIndex: 2 })),
    { type: "select-event", index: 2, preventDefault: true },
  );
  assert.deepEqual(
    resolveShortcut({ key: "k" }, state({ eventCount: 3, selectedIndex: 1 })),
    { type: "select-event", index: 0, preventDefault: true },
  );
  // An empty page has nowhere to move.
  assert.equal(resolveShortcut({ key: "j" }, BASE), null);
  assert.equal(
    resolveShortcut({ key: "j" }, state({ view: "statistics", eventCount: 3 })),
    null,
  );

  assert.deepEqual(
    resolveShortcut({ key: "Enter" }, state({ eventCount: 3, selectedIndex: 1 })),
    { type: "open-selected", preventDefault: false },
  );
  assert.equal(resolveShortcut({ key: "Enter" }, BASE), null);
  assert.equal(
    resolveShortcut({ key: "Enter" }, state({ eventCount: 3, selectedIndex: -1 })),
    null,
  );

  assert.deepEqual(resolveShortcut({ key: "g" }, BASE), {
    type: "scroll",
    to: "top",
    preventDefault: false,
  });
  assert.deepEqual(resolveShortcut({ key: "G" }, BASE), {
    type: "scroll",
    to: "bottom",
    preventDefault: false,
  });
  assert.equal(resolveShortcut({ key: "g" }, state({ view: "statistics" })), null);
  assert.equal(resolveShortcut({ key: "G" }, state({ view: "statistics" })), null);
});

test("typing, dialogs and the drawer suppress shortcuts", () => {
  for (const target of ["input", "textarea", "select", "contenteditable"] as const) {
    for (const key of ["/", "?", "1", "2", "e", "t", "c", "r", "s", "j", "g"]) {
      assert.equal(resolveShortcut({ key }, state({ target })), null, `${target} ${key}`);
    }
  }
  // Esc still closes the mobile sidebar while a field has focus (legacy order).
  assert.deepEqual(resolveShortcut({ key: "Escape" }, state({ target: "input" })), {
    type: "close-sidebar",
    preventDefault: false,
  });

  for (const overlay of ["dialog", "drawer"] as const) {
    for (const key of ["/", "?", "1", "2", "e", "Enter", "j", "g", "G", "Escape"]) {
      assert.equal(resolveShortcut({ key }, state({ overlay })), null, `${overlay} ${key}`);
    }
  }

  // The Shortcuts dialog itself still closes on `?`; nothing else passes through.
  assert.deepEqual(resolveShortcut({ key: "?" }, state({ overlay: "shortcuts" })), {
    type: "close-shortcuts",
    preventDefault: true,
  });
  assert.equal(resolveShortcut({ key: "j" }, state({ overlay: "shortcuts" })), null);
  assert.equal(resolveShortcut({ key: "Escape" }, state({ overlay: "shortcuts" })), null);
});

test("modifier combinations keep their legacy behaviour", () => {
  // Legacy never inspected modifiers, so these still resolve to the shortcut.
  assert.deepEqual(resolveShortcut({ key: "e", ctrlKey: true }, BASE), {
    type: "toggle-filter",
    filter: "errorsOnly",
    preventDefault: false,
  });
  assert.deepEqual(resolveShortcut({ key: "1", metaKey: true }, BASE), {
    type: "set-view",
    view: "trajectory",
    preventDefault: false,
  });
});

test("filter toggles match the legacy chip behaviour", () => {
  let filters = EMPTY_FILTER_TOGGLES;
  for (const key of ["errorsOnly", "compactionsOnly", "retriesOnly", "subagentsOnly"] as const) {
    filters = EMPTY_FILTER_TOGGLES;
    const on = applyFilterShortcut(filters, key);
    assert.equal(on[key], true);
    const off = applyFilterShortcut(on, key);
    assert.equal(off[key], false);
  }

  // `t` toggles the kind filter between ["tool"] and [] (never a boolean).
  const tools = applyFilterShortcut(EMPTY_FILTER_TOGGLES, "tools");
  assert.deepEqual(tools.kinds, ["tool"]);
  assert.deepEqual(applyFilterShortcut(tools, "tools").kinds, []);
  // A different kind is not "active" for `t`.
  assert.deepEqual(applyFilterShortcut({ ...EMPTY_FILTER_TOGGLES, kinds: ["user"] }, "tools").kinds, [
    "tool",
  ]);

  assert.deepEqual(activeFilterLabels(EMPTY_FILTER_TOGGLES), []);
  const all = {
    errorsOnly: true,
    compactionsOnly: true,
    retriesOnly: true,
    subagentsOnly: true,
    kinds: ["tool"],
  };
  assert.deepEqual(activeFilterLabels(all), [
    "Errors only",
    "Tool calls",
    "Compactions",
    "Retries",
    "Subagents",
  ]);
});
