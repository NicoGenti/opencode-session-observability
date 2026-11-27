import { openWorkerSqliteSource } from "../core/adapters/sqlite-worker-source.ts";
import { ObservabilityService } from "../core/service.ts";
import type { ObservabilitySource } from "../core/types.ts";

/**
 * Total entries the cache may hold, the resident startup source included. Two
 * is the smallest useful size: the startup database plus one selected
 * candidate. A third selection evicts the least-recently-used non-startup
 * source and closes it.
 */
export const SOURCE_CACHE_CAPACITY = 2;

/** A resident entry, as stored. */
export interface CachedSource {
  key: string;
  source: ObservabilitySource;
  service: ObservabilityService;
}

/** A request's hold on an entry. Releasing it makes the entry evictable. */
export interface SourceLease extends CachedSource {
  /** Ends the lease; idempotent. Eviction closes the source once it is 0. */
  release(): void;
}

export interface SourceCacheOptions {
  /** The startup database. It occupies a slot for the cache's whole lifetime. */
  startup: CachedSource;
  /**
   * Test hook: opens one candidate database. Production uses the worker-backed
   * read-only SQLite source, whose `ready()` validates the schema and surfaces
   * a locked database as `DatabaseBusyError`.
   */
  open?: (path: string) => ObservabilitySource;
}

interface Entry extends CachedSource {
  /** Requests currently using this entry; eviction waits for 0. */
  inFlight: number;
}

/** Awaits `ready()` when the source exposes it (the worker source does). */
async function waitUntilReady(source: ObservabilitySource): Promise<void> {
  const candidate = source as ObservabilitySource & {
    ready?: () => Promise<void>;
  };
  if (typeof candidate.ready === "function") await candidate.ready();
}

/**
 * A two-entry LRU of open sources, keyed by the opaque database key. The
 * startup source is resident and is never evicted, so switching `?db=` on one
 * route cannot disturb a live poll already reading the startup database.
 *
 * Every acquire returns a lease; the router releases it when the response
 * closes. Eviction only closes a non-startup entry whose in-flight count is
 * zero, so a request can never have its worker terminated underneath it. When
 * every non-startup entry is in flight the cache may transiently exceed
 * `SOURCE_CACHE_CAPACITY`; the oldest zero-refcount entry is swept on the next
 * non-startup acquire or on any release that finds the capacity exceeded.
 *
 * `close()` also guards a worker that is still opening: a late `ready()` sees
 * the closed flag, closes that source and fails its request instead of
 * inserting into the cleared map.
 *
 * Concurrent misses for the same key share one open through `#pending`.
 */
export class SourceCache {
  readonly #startupKey: string;
  readonly #open: (path: string) => ObservabilitySource;
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<Entry>>();
  #closed = false;

  constructor(options: SourceCacheOptions) {
    this.#startupKey = options.startup.key;
    this.#open = options.open ?? ((path) => openWorkerSqliteSource(path));
    this.#entries.set(options.startup.key, { ...options.startup, inFlight: 0 });
  }

  /**
   * Resident entries. May transiently exceed `SOURCE_CACHE_CAPACITY` while all
   * non-startup entries are leased to in-flight requests.
   */
  get size(): number {
    return this.#entries.size;
  }

  /** The startup entry, always present until `close()`. */
  get startup(): CachedSource {
    const entry = this.#entries.get(this.#startupKey)!;
    return { key: entry.key, source: entry.source, service: entry.service };
  }

  /**
   * Leases the cached service for `key`, opening `path` on a miss. The caller
   * has already matched `key` to `path` against the fresh candidate list; the
   * cache never looks anything up by itself. The caller must call `release()`
   * once the response is finished.
   */
  async acquire(key: string, path: string): Promise<SourceLease> {
    if (key === this.#startupKey) {
      const startup = this.#entries.get(key)!;
      this.#touch(key, startup);
      // The startup entry is resident by construction; it is never evicted, so
      // it needs no in-flight accounting.
      return {
        key: startup.key,
        source: startup.source,
        service: startup.service,
        release: () => {},
      };
    }
    const existing = this.#entries.get(key);
    if (existing) {
      existing.inFlight += 1;
      this.#touch(key, existing);
      this.#evictIfOverCapacity();
      return this.#lease(existing);
    }
    const pending = this.#pending.get(key);
    if (pending) {
      const entry = await pending;
      entry.inFlight += 1;
      this.#evictIfOverCapacity();
      return this.#lease(entry);
    }
    const loading = this.#load(key, path);
    this.#pending.set(key, loading);
    try {
      return this.#lease(await loading);
    } finally {
      this.#pending.delete(key);
    }
  }

  /** Closes every resident source, startup included, and cancels pending opens. */
  close(): void {
    this.#closed = true;
    this.#pending.clear();
    for (const entry of this.#entries.values()) entry.source.close?.();
    this.#entries.clear();
  }

  async #load(key: string, path: string): Promise<Entry> {
    const source = this.#open(path);
    try {
      await waitUntilReady(source);
    } catch (error) {
      // A source that never became ready must not leak its worker.
      source.close?.();
      throw error;
    }
    // `close()` may have run while this worker was starting. Never insert into
    // the cleared map: close the late worker and fail the request, which is
    // already doomed because the server is shutting down.
    if (this.#closed) {
      source.close?.();
      throw new Error("Source cache is closed");
    }
    const entry: Entry = {
      key,
      source,
      service: new ObservabilityService(source),
      inFlight: 1,
    };
    this.#entries.set(key, entry);
    this.#evictIfOverCapacity();
    return entry;
  }

  #lease(entry: Entry): SourceLease {
    let released = false;
    return {
      key: entry.key,
      source: entry.source,
      service: entry.service,
      release: () => {
        if (released) return;
        released = true;
        // A release after eviction (or after `close()`) is a no-op.
        if (this.#entries.get(entry.key) !== entry) return;
        if (entry.inFlight > 0) entry.inFlight -= 1;
        this.#evictIfOverCapacity();
      },
    };
  }

  #touch(key: string, entry: Entry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  #evictIfOverCapacity(): void {
    while (this.#entries.size > SOURCE_CACHE_CAPACITY) {
      let victim: string | undefined;
      // Insertion order is LRU order because #touch re-inserts on use.
      for (const [key, entry] of this.#entries) {
        if (key === this.#startupKey) continue;
        if (entry.inFlight === 0) {
          victim = key;
          break;
        }
      }
      // Every non-startup entry is in flight: stay transiently over capacity
      // and let the next acquire/release sweep again.
      if (victim === undefined) return;
      const entry = this.#entries.get(victim)!;
      this.#entries.delete(victim);
      entry.source.close?.();
    }
  }
}
