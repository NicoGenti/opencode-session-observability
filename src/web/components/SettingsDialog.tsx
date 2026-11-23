import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  GUARDRAIL_FIELDS,
  get,
  getGuardrails,
  type GuardrailKey,
} from "../lib/settings.ts";
import {
  CONTEXT_BASIS_OPTIONS,
  RESPONSE_LIMITS,
  VIEW_MODE_OPTIONS,
  guardrailCommit,
  guardrailEdit,
  guardrailInputs,
  normalizeResponseLimit,
  themeOptions,
  type GuardrailEditState,
} from "../lib/settings-form.ts";
import type { GuardrailField } from "../../core/guardrails.ts";
import { useSettings } from "../providers/SettingsProvider.tsx";
import { useTheme } from "../providers/ThemeProvider.tsx";

export { RESPONSE_LIMITS, VIEW_MODE_OPTIONS, normalizeResponseLimit };

export interface GuardrailInputProps {
  field: GuardrailField;
  value: string;
  error?: string;
  onChange(key: GuardrailKey, value: string): void;
  onBlur(key: GuardrailKey): void;
}

/**
 * One advisory budget. The message comes from the core-derived
 * `normalizeGuardrailValue`; an invalid value is never stored or sent.
 */
export function GuardrailInput({
  field,
  value,
  error,
  onChange,
  onBlur,
}: GuardrailInputProps) {
  const inputId = `setting-guardrail-${field.key}`;
  const errorId = `setting-guardrail-error-${field.key}`;
  return (
    <div className="grid gap-1">
      <label htmlFor={inputId} className="text-[12px] text-text-2">
        {field.label}
      </label>
      <input
        id={inputId}
        type="number"
        inputMode="decimal"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        aria-describedby={errorId}
        aria-invalid={error ? "true" : undefined}
        onChange={(event) => onChange(field.key, event.target.value)}
        onBlur={() => onBlur(field.key)}
        onKeyDown={(event) => {
          // A number input fired `change` on Enter too; keep focus and commit.
          if (event.key === "Enter") {
            event.preventDefault();
            onBlur(field.key);
          }
        }}
        className="w-full rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-[12.5px] text-text tabular-nums"
      />
      {error ? (
        <p id={errorId} role="alert" className="m-0 text-[11.5px] text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

/**
 * The full legacy settings form (`src/ui/app.js:3259-3341`) as controlled
 * inputs. Every control writes through `settings.ts` immediately except the
 * guardrail budgets: like the legacy `change` listener (`app.js:3358`), a budget
 * commits on blur or Enter, so a fractional value can be typed and no `gr.*`
 * request fires per keystroke. Validation uses the core-derived metadata, never
 * a second schema.
 *
 * `contextBasis` writes through the provider setter so the Statistics toolbar
 * and this form share one source of truth; the local state only mirrors the
 * controlled select.
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const theme = useTheme();
  const settings = useSettings();
  const [contextBasis, setContextBasis] = useState<string>(settings.contextBasis);
  const [edit, setEdit] = useState<GuardrailEditState>(() => ({
    inputs: guardrailInputs(settings.guardrails),
    errors: {},
  }));
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      const active = globalThis.document?.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
    }
    wasOpen.current = open;
    if (!open) return;
    setContextBasis(get("contextBasis"));
    setEdit({ inputs: guardrailInputs(getGuardrails()), errors: {} });
  }, [open]);

  const changeGuardrail = (key: GuardrailKey, raw: string): void => {
    setEdit((previous) => guardrailEdit(previous, key, raw));
  };

  const commitGuardrail = (key: GuardrailKey): void => {
    setEdit((previous) =>
      guardrailCommit(previous, key, settings.setGuardrail, getGuardrails()),
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
  };

  const options = themeOptions(theme.palette !== null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-page/70 frosted-scrim" />
      <Dialog.Content
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = opener.current;
          opener.current = null;
          if (target?.isConnected) target.focus();
        }}
        className="fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border floating-frost p-5 text-text shadow-float"
      >
        <div className="flex items-start justify-between gap-3">
          <Dialog.Title className="text-[14px] font-semibold">Settings</Dialog.Title>
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="rounded-sm border border-border px-1.5 py-0.5 text-[12px] text-text-2"
            >
              Close
            </button>
          </Dialog.Close>
        </div>
        <Dialog.Description className="mt-1 text-[12px] leading-[1.5] text-text-2">
          Preferences are stored in this browser only.
        </Dialog.Description>

        <form onSubmit={submit} noValidate className="mt-4 grid gap-5">
          <section className="grid gap-2">
            <h3 className="m-0 text-[12px] font-semibold text-text">Appearance</h3>
            <div className="grid gap-1">
              <label htmlFor="setting-theme" className="text-[12px] text-text-2">
                Theme
              </label>
              <select
                id="setting-theme"
                value={theme.theme}
                onChange={(event) => theme.setTheme(event.target.value, { userSet: true })}
                className="w-full rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-[12.5px] text-text"
              >
                {options.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <label htmlFor="setting-view-mode" className="text-[12px] text-text-2">
                View mode
              </label>
              <select
                id="setting-view-mode"
                value={settings.viewMode}
                onChange={(event) => settings.setViewMode(event.target.value)}
                className="w-full rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-[12.5px] text-text"
              >
                {VIEW_MODE_OPTIONS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section className="grid gap-1.5">
            <h3 className="m-0 text-[12px] font-semibold text-text">Sessions</h3>
            <label className="flex items-center gap-2 text-[12.5px] text-text">
              <input
                type="checkbox"
                checked={settings.groupByProject}
                onChange={(event) => settings.setGroupByProject(event.target.checked)}
              />
              Group sessions by project path
            </label>
            <label className="flex items-center gap-2 text-[12.5px] text-text">
              <input
                type="checkbox"
                checked={settings.sessionTree}
                onChange={(event) => settings.setSessionTree(event.target.checked)}
              />
              Nest child sessions under parents
            </label>
          </section>

          <section className="grid gap-2">
            <h3 className="m-0 text-[12px] font-semibold text-text">Statistics</h3>
            <div className="grid gap-1">
              <label htmlFor="setting-context-basis" className="text-[12px] text-text-2">
                Context basis
              </label>
              <select
                id="setting-context-basis"
                value={contextBasis}
                onChange={(event) => {
                  setContextBasis(settings.setContextBasis(event.target.value));
                }}
                className="w-full rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-[12.5px] text-text"
              >
                {CONTEXT_BASIS_OPTIONS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <label htmlFor="setting-response-limit" className="text-[12px] text-text-2">
                Response limit
              </label>
              <select
                id="setting-response-limit"
                value={normalizeResponseLimit(settings.responseLimit)}
                onChange={(event) => settings.setResponseLimit(Number(event.target.value))}
                className="w-full rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-[12.5px] text-text"
              >
                {RESPONSE_LIMITS.map((value) => (
                  <option key={value} value={value}>
                    {value / 1_000}k chars
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-[12.5px] text-text">
              <input
                type="checkbox"
                checked={settings.showEventRows}
                onChange={(event) => settings.setShowEventRows(event.target.checked)}
              />
              Show event rows in Statistics
            </label>
          </section>

          <section className="grid gap-2">
            <h3 className="m-0 text-[12px] font-semibold text-text">Guardrails</h3>
            <p className="m-0 text-[11.5px] leading-[1.5] text-muted">
              Advisory budgets evaluated by the server from this browser's settings. They
              never block anything, and session health keeps its own frozen thresholds.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {GUARDRAIL_FIELDS.map((field) => (
                <GuardrailInput
                  key={field.key}
                  field={field}
                  value={
                    edit.inputs[field.key] ??
                    String(settings.guardrails[field.key] ?? "")
                  }
                  error={edit.errors[field.key]}
                  onChange={changeGuardrail}
                  onBlur={commitGuardrail}
                />
              ))}
            </div>
            <div>
              <button
                type="button"
                onClick={() => {
                  const restored = settings.resetGuardrails();
                  setEdit({ inputs: guardrailInputs(restored), errors: {} });
                }}
                className="rounded-sm border border-border bg-surface-2 px-2.5 py-1 text-[12.5px] text-text-2"
              >
                Reset guardrail defaults
              </button>
            </div>
          </section>

          <div className="flex justify-between gap-2 border-t border-border pt-3">
            <button
              type="button"
              onClick={() => {
                settings.resetSettings();
                setContextBasis(get("contextBasis"));
                setEdit({ inputs: guardrailInputs(getGuardrails()), errors: {} });
              }}
              className="rounded-sm border border-border bg-surface-2 px-2.5 py-1 text-[12.5px] text-text-2"
            >
              Restore defaults
            </button>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-sm bg-accent px-2.5 py-1 text-[12.5px] text-page"
              >
                Done
              </button>
            </Dialog.Close>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
