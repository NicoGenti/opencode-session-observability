import { useEffect } from "react";
import clsx from "clsx";
import type { ApiFn } from "../lib/api.ts";
import type { Benchmark, BenchmarkPattern, BenchmarkRollups } from "../../core/benchmark.ts";
import type { Metric } from "../../core/types.ts";
import { benchmarkFragment } from "../lib/hash.ts";
import { formatCost, formatDuration, formatNumber, formatPercent } from "../lib/format.ts";
import {
  BENCHMARK_COLUMN_HEADERS,
  BENCHMARK_EMPTY_COPY,
  BENCHMARK_IDLE_COPY,
  BENCHMARK_LOADING_COPY,
  BENCHMARK_PATTERNS_NOTE,
  BENCHMARK_PATTERNS_TITLE,
  BENCHMARK_SUBTITLE,
  BENCHMARK_TITLE,
  GROUP_LABELS,
  benchmarkHasFilters,
  benchmarkIsEmpty,
  groupLabel,
  patternSessionIDs,
  serializeBenchmarkFilters,
  type BenchmarkFilterSet,
} from "../lib/benchmark.ts";
import { useBenchmark } from "../hooks/useBenchmark.ts";
import { BenchmarkFilters } from "./BenchmarkFilters.tsx";

export interface BenchmarkViewProps {
  api: ApiFn;
  /** The route's parsed filter set; the hash is the single source of truth. */
  filters: BenchmarkFilterSet;
  /** True while the router still owns the benchmark view. */
  routeOwned(): boolean;
  /**
   * Bumped when the effective database changes. A dedicated epoch so a DB switch
   * re-runs the benchmark request without reacting to unrelated data refreshes.
   */
  dbEpoch: number;
}

function MetricCell({
  metric,
  formatter,
}: {
  metric: Metric | null | undefined;
  formatter: (value: number) => string;
}) {
  if (!metric || metric.value === null || metric.value === undefined || !Number.isFinite(metric.value)) {
    const note = metric?.note && metric.note.length > 0 ? metric.note : "unavailable";
    return (
      <td className="px-2 py-1 text-right tabular-nums">
        <span className="text-muted" title={note}>
          Not recorded
        </span>
      </td>
    );
  }
  const title = `derived${metric.note ? `: ${metric.note}` : ""}`;
  return (
    <td className="px-2 py-1 text-right tabular-nums">
      <span title={title}>
        {formatter(metric.value)}
        <sup className="ml-px align-super text-[10px] text-muted">D</sup>
      </span>
    </td>
  );
}

function CountCell({ value }: { value: number }) {
  return <td className="px-2 py-1 text-right tabular-nums">{formatNumber(value)}</td>;
}

function RollupCells({ rollups }: { rollups: BenchmarkRollups }) {
  const completions = rollups.completions ?? {
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    unrecorded: 0,
  };
  return (
    <>
      <CountCell value={rollups.sessions} />
      <CountCell value={rollups.turns} />
      <CountCell value={rollups.steps} />
      <CountCell value={rollups.tokensTotal} />
      <MetricCell metric={rollups.costSum} formatter={formatCost} />
      <MetricCell metric={rollups.costPerSession} formatter={formatCost} />
      <MetricCell metric={rollups.durationPerSession} formatter={formatDuration} />
      <MetricCell metric={rollups.cacheHitRate} formatter={formatPercent} />
      <CountCell value={rollups.retries} />
      <CountCell value={rollups.errors} />
      <CountCell value={rollups.toolFailures} />
      <CountCell value={rollups.compactions} />
      <CountCell value={completions.succeeded} />
      <CountCell value={completions.failed} />
      <CountCell value={completions.interrupted} />
      <CountCell value={completions.unrecorded} />
      <CountCell value={rollups.windowedCount} />
    </>
  );
}

const HEAD_CLASS =
  "border-b border-border bg-surface-2 px-2 py-1.5 text-right text-[11px] font-semibold text-text-2";
const ROW_CLASS = "border-b border-grid text-[11.5px] text-text-2";

function BenchmarkTable({ benchmark }: { benchmark: Benchmark }) {
  // A hostile or truncated payload with no overall rollup renders no table
  // instead of throwing; the notes and patterns still explain the comparison.
  if (!benchmark.overall?.rollups) return null;
  const groupBy = benchmark.groupBy || "none";
  const heading = GROUP_LABELS[groupBy] ?? GROUP_LABELS.none;
  const groups = Array.isArray(benchmark.groups) ? benchmark.groups : [];
  return (
    <div className="overflow-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[1100px] border-collapse">
        <caption className="sr-only">
          {`Session benchmark rollups by ${heading.toLowerCase()}`}
        </caption>
        <thead>
          <tr>
            <th scope="col" className={clsx(HEAD_CLASS, "text-left")}>
              {heading}
            </th>
            {BENCHMARK_COLUMN_HEADERS.map((label) => (
              <th key={label} scope="col" className={HEAD_CLASS}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.key} className={ROW_CLASS}>
              <th scope="row" className="px-2 py-1 text-left font-semibold text-text">
                {groupLabel(group)}
              </th>
              <RollupCells rollups={group.rollups} />
            </tr>
          ))}
          <tr className="bg-surface-3 text-[11.5px] text-text">
            <td className="px-2 py-1.5 font-semibold">Overall</td>
            <RollupCells rollups={benchmark.overall.rollups} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PatternCard({ pattern }: { pattern: BenchmarkPattern }) {
  const { shown, rest } = patternSessionIDs(pattern);
  return (
    <li className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-border bg-surface-2 px-1.5 py-px text-[11px] text-text-2">
          {pattern.kind === "failing-tool" ? "Failing tool" : "Health rule"}
        </span>
        <strong className="text-[12px] text-text">{pattern.key || "Not recorded"}</strong>
        <span className="text-[11.5px] text-text-2">
          {formatNumber(pattern.sessionCount)} sessions
        </span>
      </div>
      {shown.length ? (
        <p className="m-0 mt-1 text-[11.5px] text-muted">
          {shown.join(" · ")}
          {rest > 0 ? ` · +${rest} more` : ""}
        </p>
      ) : null}
    </li>
  );
}

function BenchmarkPatterns({ patterns }: { patterns: readonly BenchmarkPattern[] }) {
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  return (
    <section aria-label={BENCHMARK_PATTERNS_TITLE} className="grid gap-1.5">
      <h3 className="m-0 text-[12.5px] font-semibold text-text">{BENCHMARK_PATTERNS_TITLE}</h3>
      <p className="m-0 text-[11.5px] text-muted">{BENCHMARK_PATTERNS_NOTE}</p>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {patterns.map((pattern) => (
          <PatternCard key={`${pattern.kind}:${pattern.key}`} pattern={pattern} />
        ))}
      </ul>
    </section>
  );
}

function BenchmarkNotes({ benchmark }: { benchmark: Benchmark }) {
  const notes = (benchmark.basisNotes ?? []).filter(
    (note) => typeof note === "string" && note.length > 0,
  );
  if (notes.length === 0) return null;
  const capped = benchmark.sessionsCapped === true;
  return (
    <ul
      data-sessions-capped={capped ? "true" : undefined}
      className="m-0 grid list-none gap-0.5 p-0 text-[11.5px] text-text-2"
    >
      {notes.map((note, index) => (
        <li
          key={note}
          className={clsx("border-l-2 pl-2", capped && index === 0 ? "border-warning" : "border-border")}
        >
          {note}
        </li>
      ))}
    </ul>
  );
}

/**
 * The standalone `#/benchmark` route (`benchmark.js:481-494`).
 *
 * No session is selected here: the comparison is a page of its own, the filter
 * set travels in the hash, and the form stays editable in all four states
 * (idle, loading, error, empty). Submitting a set that already matches the hash
 * re-runs the request in place; any other set writes the hash and lets the
 * router deliver it, so a deep link and a submit are the same code path. Leaving
 * the route never writes a session hash: `writeSessionRoute` is a no-op without
 * a session id, and this view has none.
 */
export function BenchmarkView({
  api,
  filters,
  routeOwned,
  dbEpoch,
}: BenchmarkViewProps) {
  const benchmark = useBenchmark({ api, owned: routeOwned });
  const filtersKey = serializeBenchmarkFilters(filters);
  const { run } = benchmark;

  useEffect(() => {
    void run(filters);
    // `filtersKey` is the value identity of `filters`; `dbEpoch` re-runs after a
    // database switch, which changes every benchmark row's provenance.
  }, [filtersKey, run, dbEpoch]);

  const hasCriteria = benchmarkHasFilters(filters);
  const empty =
    benchmark.status === "ready" && benchmarkIsEmpty(benchmark.benchmark);

  return (
    <section className="grid content-start gap-2.5 px-4 py-3">
      <div className="grid gap-0.5">
        <h2 className="m-0 text-[14px] font-semibold text-text">{BENCHMARK_TITLE}</h2>
        <p className="m-0 text-[11.5px] text-text-2">{BENCHMARK_SUBTITLE}</p>
      </div>

      <BenchmarkFilters
        filters={filters}
        onSubmit={(next) => {
          const nextQuery = serializeBenchmarkFilters(next);
          const fragment = benchmarkFragment(nextQuery);
          const current =
            typeof globalThis.location?.hash === "string" ? globalThis.location.hash : "";
          if (current === fragment) {
            void run(next);
            return;
          }
          globalThis.location.hash = fragment;
        }}
      />

      <div role="status" aria-live="polite" className="grid gap-1.5">
        {benchmark.status === "error" ? (
          <p role="alert" className="m-0 text-[12.5px] text-text">
            {benchmark.error}
          </p>
        ) : benchmark.status === "loading" ? (
          <p className="m-0 text-[12.5px] text-muted">{BENCHMARK_LOADING_COPY}</p>
        ) : !hasCriteria ? (
          <p className="m-0 text-[12.5px] text-muted">{BENCHMARK_IDLE_COPY}</p>
        ) : empty ? (
          <p className="m-0 text-[12.5px] text-muted">{BENCHMARK_EMPTY_COPY}</p>
        ) : benchmark.benchmark ? (
          <>
            <BenchmarkTable benchmark={benchmark.benchmark} />
            <BenchmarkPatterns patterns={benchmark.benchmark.recurringPatterns ?? []} />
          </>
        ) : null}
        {benchmark.benchmark ? <BenchmarkNotes benchmark={benchmark.benchmark} /> : null}
      </div>
    </section>
  );
}
