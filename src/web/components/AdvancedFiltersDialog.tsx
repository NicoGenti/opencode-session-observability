import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, type FormEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ADVANCED_SELECT_FIELDS,
  advancedFilterSchema,
  advancedFormDefaults,
  type AdvancedFilterValues,
  type EventFilters,
  type Facets,
} from "../lib/event-filters.ts";
import { formatNumber } from "../lib/format.ts";

const FIELD_IDS: Record<keyof AdvancedFilterValues, string> = {
  agent: "filter-agent",
  model: "filter-model",
  provider: "filter-provider",
  tool: "filter-tool",
  status: "filter-status",
  from: "filter-from",
  to: "filter-to",
  minPromptTokens: "filter-min-tokens",
  maxPromptTokens: "filter-max-tokens",
};

export interface AdvancedFiltersDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  filters: EventFilters;
  facets: Facets;
  onApply(values: AdvancedFilterValues): void;
  /** Focus restoration target, run from Radix's `onCloseAutoFocus`. */
  onRestoreFocus?(): void;
}

/**
 * The Advanced filters dialog (`app.js:744-819`, binding `:881-900`), the
 * project's first React Hook Form + Zod surface.
 *
 * Behavioural ports that matter:
 *
 * - A change is committed immediately and closes the dialog, returning focus to
 *   the Advanced filters button. A select or a datetime field commits on change;
 *   a number field commits on blur, which is when the legacy `change` event fired
 *   for it.
 * - The values keep the legacy string shape, so `"0"` is committed as `"0"` and
 *   a cleared field commits `""`, never `0`.
 * - Validation blocks the commit instead of applying a half-filled filter:
 *   `from` must be on or before `to`, the token bounds must be whole numbers,
 *   and the minimum must not exceed the maximum.
 * - Submitting is CSP-safe: the form handler calls `preventDefault()` and never
 *   falls back to the HTML form action.
 */
export function AdvancedFiltersDialog({
  open,
  onOpenChange,
  filters,
  facets,
  onApply,
  onRestoreFocus,
}: AdvancedFiltersDialogProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<AdvancedFilterValues>({
    resolver: zodResolver(advancedFilterSchema),
    defaultValues: advancedFormDefaults(filters),
    mode: "onSubmit",
  });

  useEffect(() => {
    if (open) reset(advancedFormDefaults(filters));
  }, [open, filters, reset]);

  const commit = handleSubmit((values) => {
    onApply(values);
    onOpenChange(false);
  });
  const commitNow = (): void => {
    void commit();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void commit();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-page/70 frosted-scrim" />
        <Dialog.Content
          id="advanced-filters"
          aria-describedby="advanced-filters-description"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onRestoreFocus?.();
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[86vh] w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border floating-frost p-5 text-text shadow-float"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-[14px] font-semibold">
                Advanced filters
              </Dialog.Title>
              <Dialog.Description
                id="advanced-filters-description"
                className="mt-1 text-[12px] leading-[1.5] text-text-2"
              >
                Narrow the ledger further. A value applies as soon as it changes.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close advanced filters"
                className="rounded-sm border border-border px-1.5 py-0.5 text-[12px] text-text-2"
              >
                Close
              </button>
            </Dialog.Close>
          </div>

          <form
            noValidate
            onSubmit={onSubmit}
            className="mt-4 grid gap-3"
          >
            <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
              {ADVANCED_SELECT_FIELDS.map((entry) => {
                const error = errors[entry.field];
                return (
                  <div key={entry.field} className="grid gap-1">
                    <label
                      htmlFor={FIELD_IDS[entry.field]}
                      className="text-[12px] text-text-2"
                    >
                      {entry.label}
                    </label>
                    <select
                      id={FIELD_IDS[entry.field]}
                      data-filter={entry.facet}
                      aria-describedby={
                        error ? `${FIELD_IDS[entry.field]}-error` : undefined
                      }
                      aria-invalid={error ? "true" : undefined}
                      {...register(entry.field, { onChange: commitNow })}
                      className="w-full rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-[12.5px] text-text"
                    >
                      <option value="">{entry.allLabel}</option>
                      {facets[entry.facet].map((facet) => (
                        <option key={facet.value} value={facet.value}>
                          {facet.value} ({formatNumber(facet.count)})
                        </option>
                      ))}
                    </select>
                    {error ? (
                      <p
                        id={`${FIELD_IDS[entry.field]}-error`}
                        role="alert"
                        className="m-0 text-[11.5px] text-critical"
                      >
                        {error.message}
                      </p>
                    ) : null}
                  </div>
                );
              })}

              {(
                [
                  { field: "from" as const, label: "From" },
                  { field: "to" as const, label: "To" },
                ] as const
              ).map((entry) => {
                const error = errors[entry.field];
                return (
                  <div key={entry.field} className="grid gap-1">
                    <label
                      htmlFor={FIELD_IDS[entry.field]}
                      className="text-[12px] text-text-2"
                    >
                      {entry.label}
                    </label>
                    <input
                      id={FIELD_IDS[entry.field]}
                      type="datetime-local"
                      data-filter={entry.field}
                      aria-describedby={
                        error ? `${FIELD_IDS[entry.field]}-error` : undefined
                      }
                      aria-invalid={error ? "true" : undefined}
                      {...register(entry.field, { onChange: commitNow })}
                      className="w-full rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-[12.5px] text-text"
                    />
                    {error ? (
                      <p
                        id={`${FIELD_IDS[entry.field]}-error`}
                        role="alert"
                        className="m-0 text-[11.5px] text-critical"
                      >
                        {error.message}
                      </p>
                    ) : null}
                  </div>
                );
              })}

              {(
                [
                  { field: "minPromptTokens" as const, label: "Min prompt tokens" },
                  { field: "maxPromptTokens" as const, label: "Max prompt tokens" },
                ] as const
              ).map((entry) => {
                const error = errors[entry.field];
                return (
                  <div key={entry.field} className="grid gap-1">
                    <label
                      htmlFor={FIELD_IDS[entry.field]}
                      className="text-[12px] text-text-2"
                    >
                      {entry.label}
                    </label>
                    <input
                      id={FIELD_IDS[entry.field]}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      data-filter={entry.field}
                      aria-describedby={
                        error ? `${FIELD_IDS[entry.field]}-error` : undefined
                      }
                      aria-invalid={error ? "true" : undefined}
                      {...register(entry.field, { onBlur: commitNow })}
                      className="w-full rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-[12.5px] text-text tabular-nums"
                    />
                    {error ? (
                      <p
                        id={`${FIELD_IDS[entry.field]}-error`}
                        role="alert"
                        className="m-0 text-[11.5px] text-critical"
                      >
                        {error.message}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-sm border border-border bg-surface-2 px-2.5 py-1 text-[12.5px] text-text-2"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                className="rounded-sm bg-accent px-2.5 py-1 text-[12.5px] text-page"
              >
                Done
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
