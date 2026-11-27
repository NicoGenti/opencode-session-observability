/**
 * Per-browser UI preferences, a strict TypeScript port of `src/ui/settings.js`.
 *
 * Everything here is a convenience: if localStorage is unavailable (private
 * mode, blocked storage, preview), the in-memory defaults still render a
 * complete UI. The keys keep the existing `observability-` prefix, including
 * the legacy `observability-theme` / `observability-response-limit` names, so
 * values written by the previous UI survive.
 *
 * Theme selection and palette application live in `theme.ts` (the theme parts
 * of the legacy module); this module owns the store, the migration marker, the
 * view mode and the guardrail budgets. The budget metadata is imported from
 * `src/core/guardrails.ts` — there is no second mirror in the new UI.
 */

import {
  DEFAULT_GUARDRAILS,
  GUARDRAIL_FIELDS as CORE_GUARDRAIL_FIELDS,
  GUARDRAIL_MAX as CORE_GUARDRAIL_MAX,
  type GuardrailField,
} from "../../core/guardrails.ts";

export type ViewMode = "basic" | "advanced";

/** The stored budget vocabulary, derived from the core metadata. */
export type GuardrailKey = GuardrailField["key"];

export type GuardrailValues = Record<GuardrailKey, number>;

/** A TUI-supplied palette; every field is validated before it is applied. */
export interface ThemePalette {
  page?: string;
  text?: string;
  accent?: string;
  mode?: string;
  surface?: string;
  surface2?: string;
  surface3?: string;
  text2?: string;
  muted?: string;
  border?: string;
  borderStrong?: string;
  grid?: string;
  good?: string;
  warning?: string;
  serious?: string;
  critical?: string;
}

export interface StoredSettings {
  settingsVersion: number;
  theme: string;
  themeUserSet: boolean;
  palette: ThemePalette | null;
  viewMode: ViewMode;
  contextBasis: string;
  responseLimit: number;
  showEventRows: boolean;
  groupByProject: boolean;
  sessionTree: boolean;
  expandedProjects: string[];
  expandedParents: string[];
  guardrails: Partial<GuardrailValues> | null;
  guardrailsExpanded: boolean;
  guardrailsCollapsed: boolean;
  /** The opaque key of the database the UI should query; "" means startup. */
  dbKey: string;
}

export type SettingsKey = keyof StoredSettings;

/* --------------------------------------------------------------------------
 * The browser boundary.
 *
 * These narrow structural types let the module run under `node:test` (no DOM
 * lib) and build under `tsconfig.ui.json` (DOM lib) without depending on either
 * ambient global. Only the members this store touches are declared.
 * ------------------------------------------------------------------------ */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StyleLike {
  colorScheme?: string;
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}

export interface DomElement {
  dataset: Record<string, string | undefined>;
  style?: StyleLike | null;
}

export interface DomDocument {
  documentElement?: DomElement | null;
  body?: DomElement | null;
}

export interface DomScope {
  localStorage?: StorageLike | null;
  sessionStorage?: StorageLike | null;
  document?: DomDocument | null;
}

/**
 * The host global, viewed through the minimal shapes above. The double
 * assertion is the single boundary between an isomorphic module and whichever
 * global object (browser or `node:test` fake) is installed.
 */
export function domScope(): DomScope {
  return globalThis as unknown as DomScope;
}

export function browserStorage(): StorageLike | null {
  try {
    return domScope().localStorage ?? null;
  } catch {
    return null;
  }
}

const DEFAULTS: StoredSettings = {
  settingsVersion: 0,
  theme: "auto",
  themeUserSet: false,
  palette: null,
  viewMode: "basic",
  contextBasis: "latest",
  responseLimit: 20_000,
  showEventRows: false,
  groupByProject: true,
  sessionTree: true,
  expandedProjects: [],
  expandedParents: [],
  guardrails: null,
  guardrailsExpanded: false,
  guardrailsCollapsed: true,
  dbKey: "",
};

const KEY_PREFIX = "observability-";
const LEGACY_KEYS: Partial<Record<SettingsKey, string>> = {
  theme: "observability-theme",
  responseLimit: "observability-response-limit",
};

function storageKey(key: SettingsKey): string {
  return LEGACY_KEYS[key] ?? `${KEY_PREFIX}${key}`;
}

function readRaw(key: SettingsKey): string | null {
  const store = browserStorage();
  if (!store) return null;
  try {
    return store.getItem(storageKey(key));
  } catch {
    return null;
  }
}

function writeRaw(key: SettingsKey, value: string): void {
  const store = browserStorage();
  if (!store) return;
  try {
    store.setItem(storageKey(key), value);
  } catch {
    // Preferences are best-effort.
  }
}

function parse(value: string | null, fallback: unknown): unknown {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function get<K extends SettingsKey>(key: K): StoredSettings[K] {
  const fallback = DEFAULTS[key];
  const raw = readRaw(key);
  return (raw !== null ? parse(raw, fallback) : fallback) as StoredSettings[K];
}

export function set<K extends SettingsKey>(key: K, value: StoredSettings[K]): void {
  if (!(key in DEFAULTS)) return;
  writeRaw(key, JSON.stringify(value));
}

export interface DbKeyResolution {
  /** The key the UI should use; "" means "let the server pick the startup DB". */
  key: string;
  /** True when a stored choice was unavailable and had to be replaced. */
  reset: boolean;
}

/**
 * Validates a stored database key against the SERVABLE keys a fresh catalogue
 * returned. The startup key is valid by definition: the server always serves
 * it, even when it is absent from the catalogue, so it is never cleared. A
 * present key is kept; an empty key adopts the startup key; a stored key that
 * disappeared (or a catalogue row that exists but is not a v2 database) resets
 * to the startup key (or clears to "", which lets the server keep its startup
 * database) and reports the reset so the dialog can show its one-shot caption.
 * A missing `startupDbKey` (an older server) leaves the key empty.
 */
export function resolveDbKey(
  stored: unknown,
  candidateKeys: readonly string[],
  startupKey: unknown,
): DbKeyResolution {
  const startup = typeof startupKey === "string" ? startupKey.trim() : "";
  const value = typeof stored === "string" ? stored.trim() : "";
  const startupIsServable = startup !== "";
  if (value !== "" && (value === startup || candidateKeys.includes(value))) {
    return { key: value, reset: false };
  }
  if (value === "") {
    return { key: startupIsServable ? startup : "", reset: false };
  }
  return { key: startupIsServable ? startup : "", reset: true };
}

/**
 * Whether the effective WIRE database changes between two stored keys. `""`
 * means "no db parameter": the request is served by the startup database,
 * exactly like the explicit startup key, so those two spellings are the same
 * target while `startupKey` is known. Every other pair differs: choosing a real
 * database from "" changes the target, and falling back to "" from a real
 * selection changes it back to the startup database.
 *
 * Values are compared raw: `requestTarget` appends the stored string verbatim,
 * so a whitespace-only key is an invalid key handled by the `invalid_db`
 * self-heal, not something this helper normalizes away.
 */
export function effectiveDbKeyChange(
  previousEffectiveKey: string,
  nextKey: string,
  startupKey: string,
): boolean {
  const target = (key: string): string =>
    key === "" || (startupKey !== "" && key === startupKey)
      ? "\0startup"
      : key;
  return target(previousEffectiveKey) !== target(nextKey);
}

/**
 * One-time upgrade path for preferences written by the previous UI, which had
 * a manual light/dark toggle and no `themeUserSet` marker. Without this, the
 * first TUI deep link would silently overwrite the user's existing choice.
 */
export function migrate(): void {
  if (Number(get("settingsVersion")) >= 1) return;
  const storedTheme = parse(readRaw("theme"), "auto");
  if (typeof storedTheme === "string" && storedTheme && storedTheme !== "auto") {
    set("themeUserSet", true);
  }
  set("settingsVersion", 1);
}

/* --------------------------------------------------------------- view mode */

export function getViewMode(): ViewMode {
  return get("viewMode") === "advanced" ? "advanced" : "basic";
}

export function setViewMode(mode: string): ViewMode {
  const next: ViewMode = mode === "advanced" ? "advanced" : "basic";
  set("viewMode", next);
  applyViewMode(next);
  return next;
}

export function applyViewMode(mode: string = getViewMode()): void {
  const body = domScope().document?.body;
  if (body) body.dataset.viewMode = mode === "advanced" ? "advanced" : "basic";
}

/* --------------------------------------------------------------- guardrails */

/**
 * The closed budget vocabulary, imported from `src/core/guardrails.ts` (the
 * single source of truth). Re-exported for the UI so callers never need the
 * core path directly.
 */
export const GUARDRAIL_FIELDS: readonly GuardrailField[] = CORE_GUARDRAIL_FIELDS;

/** The out-of-the-box budgets, imported from core (frozen there). */
export const GUARDRAIL_DEFAULTS: Readonly<GuardrailValues> = DEFAULT_GUARDRAILS;

/** The inclusive upper bound per budget, imported from core. */
export const GUARDRAIL_MAX: Readonly<GuardrailValues> = CORE_GUARDRAIL_MAX;

const INTEGER_BUDGETS: ReadonlySet<GuardrailKey> = new Set(
  GUARDRAIL_FIELDS.filter((field) => field.integer).map((field) => field.key),
);

/** The closed budget metadata entry for a key, or `null` for an unknown key. */
export function guardrailField(key: string): GuardrailField | null {
  return GUARDRAIL_FIELDS.find((field) => field.key === key) ?? null;
}

/**
 * One budget as a stored number: finite, non-negative, inside its field bound
 * and, for the count budgets, a whole number. `null` means "reject" — the
 * settings form shows the message and the value never reaches localStorage or a
 * request.
 *
 * A number is used as given. A string is only accepted when it has
 * non-whitespace content, and only through `Number()` — so an emptied field
 * (`""` or `"  "`), `null`, an array or a boolean is rejected instead of
 * silently becoming a budget of 0.
 */
export function normalizeGuardrailValue(
  key: string,
  value: unknown,
): number | null {
  const field = guardrailField(key);
  if (!field) return null;
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number) || number < field.min || number > field.max) {
    return null;
  }
  if (INTEGER_BUDGETS.has(field.key) && !Number.isInteger(number)) return null;
  return number;
}

/** The inline message for one rejected budget. */
export function guardrailErrorMessage(key: string): string {
  const field = guardrailField(key);
  if (!field) return "Unknown guardrail budget.";
  return `${field.label} must be a number between ${field.min} and ${field.max}.`;
}

/**
 * The effective budgets: the stored values, each falling back to the core
 * default when absent or malformed. A hand-edited localStorage entry can
 * therefore never disable a budget or send a hostile number.
 */
export function getGuardrails(): GuardrailValues {
  const stored = get("guardrails");
  const values: GuardrailValues = { ...GUARDRAIL_DEFAULTS };
  if (stored && typeof stored === "object") {
    const record = stored as Record<string, unknown>;
    for (const field of GUARDRAIL_FIELDS) {
      const value = normalizeGuardrailValue(field.key, record[field.key]);
      if (value !== null) values[field.key] = value;
    }
  }
  return values;
}

export type GuardrailWriteResult =
  | { ok: true; value: number }
  | { ok: false; message: string };

/** Stores one validated budget; a rejected value is never written. */
export function setGuardrail(key: string, value: unknown): GuardrailWriteResult {
  const normalized = normalizeGuardrailValue(key, value);
  if (normalized === null) {
    return { ok: false, message: guardrailErrorMessage(key) };
  }
  set("guardrails", { ...getGuardrails(), [key]: normalized });
  return { ok: true, value: normalized };
}

/** Drops every stored override, restoring the core defaults. */
export function resetGuardrails(): GuardrailValues {
  set("guardrails", null);
  return { ...GUARDRAIL_DEFAULTS };
}

/**
 * The `gr.*` parameters appended to the analysis fetch. All six budgets are
 * always sent in the documented order — the effective values, defaults
 * included, are exactly what the server evaluates — so "only set keys" means
 * exactly the six documented keys, never a stray one. A malformed value falls
 * back to the default instead of being dropped, so the panel and the server
 * always agree.
 */
export function guardrailParams(
  values: Partial<Record<GuardrailKey, unknown>> = getGuardrails(),
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const field of GUARDRAIL_FIELDS) {
    const value = normalizeGuardrailValue(field.key, values?.[field.key]);
    params[`gr.${field.key}`] = String(
      value === null ? GUARDRAIL_DEFAULTS[field.key] : value,
    );
  }
  return params;
}

type ResetListener = () => void;

const resetListeners = new Set<ResetListener>();

/**
 * Notifies in-memory disclosure state (the sidebar's expanded project/parent
 * sets, the guardrails disclosure) that every preference was cleared, so a
 * stale set can never be written back to localStorage after a reset.
 */
export function onSettingsReset(listener: ResetListener): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

/**
 * Removes every stored preference (the same key set the legacy `reset()`
 * cleared). Theme and view-mode application belong to `theme.ts`'s `resetAll`,
 * which calls this first.
 */
export function reset(): void {
  for (const key of Object.keys(DEFAULTS) as SettingsKey[]) {
    const store = browserStorage();
    if (!store) continue;
    try {
      store.removeItem(storageKey(key));
    } catch {
      // Preferences are best-effort.
    }
  }
  for (const listener of [...resetListeners]) listener();
}
