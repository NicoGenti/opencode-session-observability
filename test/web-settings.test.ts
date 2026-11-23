import test from "node:test";
import assert from "node:assert/strict";
import {
  applyViewMode,
  get,
  getViewMode,
  migrate,
  reset,
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
  assert.equal(storage.keys().length, 15);

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
  ];
  assert.equal(new Set(keys).size, 15);
});
