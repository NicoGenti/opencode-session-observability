import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  BENCHMARK_GROUP_BYS,
  BENCHMARK_OUTCOMES,
  BENCHMARK_TASK_TYPES,
  GROUP_OPTION_LABELS,
  MAX_BENCHMARK_FILTER_LENGTH,
  epochToDateInput,
  filtersFromFormValues,
  type BenchmarkFilterSet,
} from "../lib/benchmark.ts";

const OUTCOME_VALUES: readonly string[] = BENCHMARK_OUTCOMES;
const TASK_TYPE_VALUES: readonly string[] = BENCHMARK_TASK_TYPES;
const GROUP_BY_VALUES: readonly string[] = BENCHMARK_GROUP_BYS;

/**
 * The filter form's schema. RHF+Zod is allowed here because the benchmark has no
 * core contract to derive from (`plan:61`); the closed vocabularies and the group
 * dimension are still imported from `src/core/benchmark.ts`, and the date bounds
 * are not validated here — they are quantised on the way to the hash.
 */
const filtersSchema = z.object({
  from: z.string(),
  to: z.string(),
  model: z.string().max(MAX_BENCHMARK_FILTER_LENGTH),
  provider: z.string().max(MAX_BENCHMARK_FILTER_LENGTH),
  agent: z.string().max(MAX_BENCHMARK_FILTER_LENGTH),
  directory: z.string().max(MAX_BENCHMARK_FILTER_LENGTH),
  outcome: z.string().refine((value) => value === "" || OUTCOME_VALUES.includes(value)),
  taskType: z.string().refine((value) => value === "" || TASK_TYPE_VALUES.includes(value)),
  groupBy: z.string().refine((value) => GROUP_BY_VALUES.includes(value)),
});

type FilterFormValues = z.infer<typeof filtersSchema>;

const DEFAULTS: FilterFormValues = Object.freeze({
  from: "",
  to: "",
  model: "",
  provider: "",
  agent: "",
  directory: "",
  outcome: "",
  taskType: "",
  groupBy: "none",
});

/** The filter object back in the form's representation (`benchmark.js:263-315`). */
export function filtersToFormValues(filters: BenchmarkFilterSet): FilterFormValues {
  return {
    from: epochToDateInput(filters.from),
    to: epochToDateInput(filters.to),
    model: filters.model ?? "",
    provider: filters.provider ?? "",
    agent: filters.agent ?? "",
    directory: filters.directory ?? "",
    outcome: filters.outcome ?? "",
    taskType: filters.taskType ?? "",
    groupBy: filters.groupBy && filters.groupBy.length > 0 ? filters.groupBy : "none",
  };
}

const FIELD =
  "w-full rounded-sm border border-border-strong bg-surface px-1.5 py-1 text-[12px] text-text";
const LABEL = "text-[11px] text-muted";

export interface BenchmarkFiltersProps {
  filters: BenchmarkFilterSet;
  onSubmit(filters: BenchmarkFilterSet): void;
}

/**
 * The benchmark filter form: two date inputs, four text filters, two selects and
 * the group-by dimension (`benchmark.js:259-315`).
 *
 * `groupBy` travels with the filters but is never a criterion: the view decides
 * idle-versus-request from `benchmarkHasFilters`, which ignores it. Every submit
 * is a real form submit with `preventDefault` (CSP `form-action 'none'` blocks a
 * native POST), and the hash is the single source of truth for the comparison.
 */
export function BenchmarkFilters({ filters, onSubmit }: BenchmarkFiltersProps) {
  const key = useMemo(
    () =>
      [
        filters.from,
        filters.to,
        filters.model,
        filters.provider,
        filters.agent,
        filters.directory,
        filters.outcome,
        filters.taskType,
        filters.groupBy,
      ].join("\u0000"),
    [filters],
  );
  const form = useForm<FilterFormValues>({
    resolver: zodResolver(filtersSchema),
    defaultValues: filtersToFormValues(filters),
  });
  const { register, handleSubmit, reset } = form;

  // The hash owns the filters: an arriving deep link or a sidebar navigation
  // rewrites the fields instead of leaving stale values behind.
  useEffect(() => {
    reset(filtersToFormValues(filters));
  }, [key, filters, reset]);

  return (
    <form
      className="grid grid-cols-2 gap-2 max-[700px]:grid-cols-1"
      noValidate
      onSubmit={handleSubmit((values) => onSubmit(filtersFromFormValues(values)))}
    >
      <label className="grid gap-0.5">
        <span className={LABEL}>From</span>
        <input type="date" {...register("from")} className={FIELD} />
      </label>
      <label className="grid gap-0.5">
        <span className={LABEL}>To</span>
        <input type="date" {...register("to")} className={FIELD} />
      </label>
      <label className="grid gap-0.5">
        <span className={LABEL}>Model</span>
        <input
          type="text"
          placeholder="Any model"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_BENCHMARK_FILTER_LENGTH}
          {...register("model")}
          className={FIELD}
        />
      </label>
      <label className="grid gap-0.5">
        <span className={LABEL}>Provider</span>
        <input
          type="text"
          placeholder="Any provider"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_BENCHMARK_FILTER_LENGTH}
          {...register("provider")}
          className={FIELD}
        />
      </label>
      <label className="grid gap-0.5">
        <span className={LABEL}>Agent</span>
        <input
          type="text"
          placeholder="Any agent"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_BENCHMARK_FILTER_LENGTH}
          {...register("agent")}
          className={FIELD}
        />
      </label>
      <label className="grid gap-0.5">
        <span className={LABEL}>Directory</span>
        <input
          type="text"
          placeholder="Any directory"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_BENCHMARK_FILTER_LENGTH}
          {...register("directory")}
          className={FIELD}
        />
      </label>
      <label className="grid gap-0.5">
        <span className={LABEL}>Outcome</span>
        <select {...register("outcome")} className={FIELD}>
          <option value="">Any outcome</option>
          {OUTCOME_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-0.5">
        <span className={LABEL}>Task type</span>
        <select {...register("taskType")} className={FIELD}>
          <option value="">Any task type</option>
          {TASK_TYPE_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-0.5">
        <span className={LABEL}>Group by</span>
        <select {...register("groupBy")} className={FIELD}>
          {BENCHMARK_GROUP_BYS.map((value) => (
            <option key={value} value={value}>
              {GROUP_OPTION_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <div className="col-span-full">
        <button
          type="submit"
          className="rounded-sm border border-border-strong bg-surface-2 px-2.5 py-1 text-[12.5px] text-text hover:border-accent"
        >
          Compare
        </button>
      </div>
    </form>
  );
}
