/**
 * The settings form's pure metadata and helpers: option lists, the response
 * limit normalizer and the theme list filter. The dialog is the renderer; this
 * module keeps the decisions testable without a DOM.
 */

import { GUARDRAIL_FIELDS, type GuardrailValues } from "./settings.ts";
import { THEMES, type ThemeEntry } from "./theme.ts";

/** The five response sizes the legacy select offered (`app.js:3305`). */
export const RESPONSE_LIMITS = [4_000, 12_000, 20_000, 50_000, 80_000] as const;
export const DEFAULT_RESPONSE_LIMIT = 20_000;

export const VIEW_MODE_OPTIONS = Object.freeze([
  Object.freeze({ id: "basic", label: "Basic" }),
  Object.freeze({ id: "advanced", label: "Advanced" }),
]);

export const CONTEXT_BASIS_OPTIONS = Object.freeze([
  Object.freeze({ id: "latest", label: "Latest" }),
  Object.freeze({ id: "cumulative", label: "Cumulative" }),
]);

/** `responseLimitSetting()` (`app.js:211-214`): any other stored value is 20k. */
export function normalizeResponseLimit(value: unknown): number {
  const number = Number(value);
  return (RESPONSE_LIMITS as readonly number[]).includes(number)
    ? number
    : DEFAULT_RESPONSE_LIMIT;
}

/**
 * The theme list the settings select shows: every seed theme plus Auto, Light
 * and Dark, and `OpenCode (current)` only while a TUI palette is in effect —
 * the same filter `renderSettingsForm()` applied (`app.js:3262-3264`).
 */
export function themeOptions(hasPalette: boolean): readonly ThemeEntry[] {
  return THEMES.filter((entry) => entry.id !== "opencode-current" || hasPalette);
}

/** The text values the six budget inputs start from. */
export function guardrailInputs(values: GuardrailValues): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const field of GUARDRAIL_FIELDS) {
    inputs[field.key] = String(values[field.key] ?? "");
  }
  return inputs;
}

/** The local editor state of the six budget fields. */
export interface GuardrailEditState {
  inputs: Record<string, string>;
  errors: Record<string, string>;
}

export type GuardrailWriter = (
  key: string,
  value: unknown,
) => { ok: true; value: number } | { ok: false; message: string };

/**
 * A keystroke only edits the raw string: the legacy `change` event (blur or
 * Enter for a number input) was the only writer, so no budget is stored or sent
 * while the user is still typing, and the input is never rewritten under focus.
 */
export function guardrailEdit(
  state: GuardrailEditState,
  key: string,
  raw: string,
): GuardrailEditState {
  return {
    inputs: { ...state.inputs, [key]: raw },
    errors: state.errors,
  };
}

/**
 * The commit half of the legacy handler (`app.js:3358-3376`): a valid value is
 * normalized and written once; an invalid one shows the message and restores the
 * stored budget without storing or sending anything.
 */
export function guardrailCommit(
  state: GuardrailEditState,
  key: string,
  write: GuardrailWriter,
  stored: GuardrailValues,
): GuardrailEditState {
  const result = write(key, state.inputs[key] ?? "");
  const inputs = { ...state.inputs };
  const errors = { ...state.errors };
  if (result.ok) {
    inputs[key] = String(result.value);
    delete errors[key];
  } else {
    inputs[key] = String((stored as Record<string, number | undefined>)[key] ?? "");
    errors[key] = result.message;
  }
  return { inputs, errors };
}
