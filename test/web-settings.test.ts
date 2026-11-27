import test from "node:test";
import assert from "node:assert/strict";
import {
  applyViewMode,
  effectiveDbKeyChange,
  get,
  getViewMode,
  migrate,
  reset,
  resolveDbKey,
  set,
  setViewMode,
  type SettingsKey,
} from "../src/web/lib/settings.ts";

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
const body: { dataset: Record<string, string> } = { dataset: {} };
Object.assign(globalThis, {
  localStorage: storage,
  document: { documentElement: { dataset: {}, style: undefined }, body },
});

test.beforeEach(() => {
  reset();
  body.dataset = {};
});

test("settings fall back to defaults and round-trip typed values", () => {
  assert.equal(get("viewMode"), "basic");
  assert.equal(get("responseLimit"), 20_000);
  assert.equal(get("theme"), "auto");
  assert.equal(get("themeUserSet"), false);
  assert.equal(get("settingsVersion"), 0);
  assert.equal(get("guardrails"), null);
  assert.deepEqual(get("expandedProjects"), []);

  set("viewMode", "advanced");
  set("responseLimit", 4_000);
  set("showEventRows", true);
  assert.equal(get("viewMode"), "advanced");
  assert.equal(get("responseLimit"), 4_000);
  assert.equal(get("showEventRows"), true);
});

test("legacy keys are kept for older theme and response-limit values", () => {
  set("theme", "dark");
  set("responseLimit", 4_000);
  assert.equal(storage.getItem("observability-theme"), '"dark"');
  assert.equal(storage.getItem("observability-response-limit"), "4000");
  assert.deepEqual(
    storage.keys().sort(),
    ["observability-response-limit", "observability-theme"],
  );
});

test("legacy manual themes are marked as user-selected once", () => {
  set("theme", "dark");
  migrate();
  assert.equal(get("themeUserSet"), true);
  assert.equal(get("settingsVersion"), 1);
  assert.equal(storage.getItem("observability-settingsVersion"), "1");

  reset();
  set("theme", "auto");
  migrate();
  assert.equal(get("themeUserSet"), false);
});

test("the migration is one-shot once settingsVersion reached 1", () => {
  set("theme", "dark");
  set("settingsVersion", 1);
  set("themeUserSet", false);
  migrate();
  assert.equal(get("themeUserSet"), false);
  assert.equal(get("settingsVersion"), 1);
});

test("stored values survive a reload through the same key", () => {
  set("guardrails", { costTotal: 12 });
  // A fresh module read is the same `get` path the browser takes on reload.
  assert.deepEqual(get("guardrails"), { costTotal: 12 });
  assert.match(storage.getItem("observability-guardrails") ?? "", /"costTotal":12/);
});

test("unknown keys are ignored without writing", () => {
  const untypedSet = set as (key: string, value: unknown) => void;
  untypedSet("nonsense", 1);
  assert.equal(storage.getItem("observability-nonsense"), null);
  assert.deepEqual(storage.keys(), []);
});

test("view mode is persisted and reflected on the body", () => {
  assert.equal(setViewMode("advanced"), "advanced");
  assert.equal(body.dataset.viewMode, "advanced");
  setViewMode("nonsense");
  assert.equal(body.dataset.viewMode, "basic");
  assert.equal(getViewMode(), "basic");
  applyViewMode();
  assert.equal(body.dataset.viewMode, "basic");
});

test("reset clears exactly the stored default key set", () => {
  set("theme", "nord");
  set("themeUserSet", true);
  set("palette", { page: "#010203", text: "#fefefe", mode: "dark" });
  set("viewMode", "advanced");
  set("contextBasis", "first");
  set("responseLimit", 1_000);
  set("showEventRows", true);
  set("groupByProject", false);
  set("sessionTree", false);
  set("expandedProjects", ["prj_1"]);
  set("expandedParents", ["ses_1"]);
  set("guardrails", { retries: 3 });
  set("settingsVersion", 1);
  set("guardrailsExpanded", true);
  set("guardrailsCollapsed", false);
  set("dbKey", "startup-key-1");
  assert.equal(storage.keys().length, 16);

  reset();
  assert.equal(storage.keys().length, 0, storage.keys().join(", "));
});

test("unavailable storage degrades to defaults instead of throwing", () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  const broken = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  Object.assign(globalThis, { localStorage: broken });
  try {
    assert.equal(get("viewMode"), "basic");
    assert.doesNotThrow(() => set("viewMode", "advanced"));
    assert.doesNotThrow(() => migrate());
    assert.doesNotThrow(() => setViewMode("advanced"));
    assert.doesNotThrow(() => reset());
    assert.equal(getViewMode(), "basic");
  } finally {
    Object.assign(globalThis, { localStorage: original });
  }
});

test("the settings key union stays the documented vocabulary", () => {
  const keys: SettingsKey[] = [
    "settingsVersion",
    "theme",
    "themeUserSet",
    "palette",
    "viewMode",
    "contextBasis",
    "responseLimit",
    "showEventRows",
    "groupByProject",
    "sessionTree",
    "expandedProjects",
    "expandedParents",
    "guardrails",
    "guardrailsExpanded",
    "guardrailsCollapsed",
    "dbKey",
  ];
  assert.equal(new Set(keys).size, 16);
});

test("dbKey setting defaults to startup key", () => {
  // The library default is "no explicit choice"; the boot health probe adopts
  // the startup key through `resolveDbKey`, and a chosen key round-trips.
  assert.equal(get("dbKey"), "");
  assert.deepEqual(resolveDbKey("", ["startup-key-1"], "startup-key-1"), {
    key: "startup-key-1",
    reset: false,
  });

  set("dbKey", "startup-key-1");
  assert.equal(get("dbKey"), "startup-key-1");
  assert.equal(storage.getItem("observability-dbKey"), '"startup-key-1"');
});

test("invalid stored dbKey resets to startup key", () => {
  assert.deepEqual(resolveDbKey("gone-key", ["startup-key-1"], "startup-key-1"), {
    key: "startup-key-1",
    reset: true,
  });
  // A still-present key is kept without a reset.
  assert.deepEqual(resolveDbKey("startup-key-1", ["startup-key-1"], "startup-key-1"), {
    key: "startup-key-1",
    reset: false,
  });
  // A vanished user key resets to the startup key even when the catalogue did
  // not return it (the server always serves the startup database).
  assert.deepEqual(resolveDbKey("gone-key", [], "startup-key-1"), {
    key: "startup-key-1",
    reset: true,
  });
  // The startup key is valid by definition even when the catalogue omits it.
  assert.deepEqual(resolveDbKey("startup-key-1", [], "startup-key-1"), {
    key: "startup-key-1",
    reset: false,
  });
  // An older server with no startupDbKey never invents a key.
  assert.deepEqual(resolveDbKey("", [], undefined), { key: "", reset: false });
});

test("effectiveDbKeyChange compares the wire target, not the stored spelling", () => {
  const startup = "startup-key-1";
  // Same key: no refetch.
  assert.equal(effectiveDbKeyChange(startup, startup, startup), false);
  assert.equal(effectiveDbKeyChange("other-key", "other-key", startup), false);
  // A different real database refetches.
  assert.equal(effectiveDbKeyChange("other-key", "third-key", startup), true);
  // "" means "no db parameter": the startup database, same as the startup key.
  assert.equal(effectiveDbKeyChange("", startup, startup), false);
  assert.equal(effectiveDbKeyChange(startup, "", startup), false);
  // "" to a real database changes the wire target.
  assert.equal(effectiveDbKeyChange("", "other-key", startup), true);
  // Falling back to "" from a real selection changes it back to startup.
  assert.equal(effectiveDbKeyChange("other-key", "", startup), true);
  // Selecting the startup key from another database also changes the target.
  assert.equal(effectiveDbKeyChange("other-key", startup, startup), true);
  // An older server has no startup key: "" still means the startup database,
  // and the ""<->startup-key equivalence cannot be claimed without knowing it.
  assert.equal(effectiveDbKeyChange("", "", ""), false);
  assert.equal(effectiveDbKeyChange("", "other-key", ""), true);
  assert.equal(effectiveDbKeyChange("", "startup-key-1", ""), true);
  assert.equal(effectiveDbKeyChange("startup-key-1", "", ""), true);
  // Comparison is raw: a whitespace key is a different (invalid) wire value.
  assert.equal(effectiveDbKeyChange(" ", "", ""), true);
});
