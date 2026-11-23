import { useCallback, useEffect, useRef, useState } from "react";
import type { Benchmark } from "../../core/benchmark.ts";
import type { ApiFn } from "../lib/api.ts";
import {
  benchmarkApiPath,
  benchmarkErrorMessage,
  benchmarkHasFilters,
  benchmarkResponseLands,
  type BenchmarkFilterSet,
} from "../lib/benchmark.ts";

/** The four states the benchmark route renders (`benchmark.js:481-493`). */
export type BenchmarkStatus = "idle" | "loading" | "error" | "ready";

export interface BenchmarkState {
  status: BenchmarkStatus;
  benchmark: Benchmark | null;
  error: string | null;
}

export interface UseBenchmarkOptions {
  api: ApiFn;
  /**
   * Route ownership: a late response may only paint while this is true. The
   * legacy renderer re-read `parseHash().view` on both the success and the
   * failure path (`app.js:4156`, `:4160`), so a navigation that never touched
   * the sequence still cannot repaint another view.
   */
  owned(): boolean;
}

export interface UseBenchmarkResult extends BenchmarkState {
  /** Runs one comparison; the hash owns the filters. */
  run(filters: BenchmarkFilterSet): Promise<void>;
  /** Invalidates any in-flight comparison (session select, route leave). */
  invalidate(): void;
}

const IDLE: BenchmarkState = Object.freeze({
  status: "idle" as const,
  benchmark: null,
  error: null,
});

/**
 * The benchmark request controller, a port of `renderBenchmark` and
 * `benchmarkRequestSeq` (`app.js:4116-4163`).
 *
 * - Every run takes a ticket; a newer run, a route leave and unmount all bump the
 *   counter, so a stale response is dropped in both the success and the error
 *   path.
 * - Both paths then re-check route ownership: the sequence and the route are
 *   separate guards, in that order, exactly as legacy wrote them.
 * - A filter set with no criterion paints the idle copy and issues no request;
 *   `groupBy` alone is not a criterion.
 */
export function useBenchmark({ api, owned }: UseBenchmarkOptions): UseBenchmarkResult {
  const [state, setState] = useState<BenchmarkState>(IDLE);
  const sequence = useRef(0);
  const ownedRef = useRef(owned);
  ownedRef.current = owned;

  const invalidate = useCallback(() => {
    sequence.current += 1;
  }, []);

  const run = useCallback(
    async (filters: BenchmarkFilterSet): Promise<void> => {
      const ticket = ++sequence.current;
      if (!benchmarkHasFilters(filters)) {
        setState(IDLE);
        return;
      }
      setState({ status: "loading", benchmark: null, error: null });
      try {
        const data = await api<{ benchmark?: Benchmark }>(benchmarkApiPath(filters));
        if (!benchmarkResponseLands(ticket, sequence.current, ownedRef.current())) return;
        setState({
          status: "ready",
          benchmark: data.benchmark ?? null,
          error: null,
        });
      } catch (failure) {
        if (!benchmarkResponseLands(ticket, sequence.current, ownedRef.current())) return;
        setState({
          status: "error",
          benchmark: null,
          error: benchmarkErrorMessage(
            failure instanceof Error ? failure.message : String(failure),
          ),
        });
      }
    },
    [api],
  );

  useEffect(
    () => () => {
      // Leaving the route (or unmounting) makes a pending comparison a no-op.
      sequence.current += 1;
    },
    [],
  );

  return { ...state, run, invalidate };
}
