import { Worker } from "node:worker_threads";
import { DatabaseBusyError, UnsupportedSchemaError } from "./sqlite.ts";
import type {
  ObservabilitySource,
  RawMessage,
  SessionFamily,
  SessionMeta,
  SessionSummary,
} from "../types.ts";

/**
 * TypeScript rewrites `.ts` import specifiers on emit, but not string arguments
 * such as `new URL(...)`. Deriving the sibling's extension from this module's
 * own extension keeps the worker resolvable in both layouts: `.ts` when this
 * module runs from `src`, `.js` in the emitted `dist` lane.
 */
const WORKER_EXTENSION = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

interface WorkerReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function reviveError(error: { name: string; message: string }): Error {
  if (error.name === "DatabaseBusyError") return new DatabaseBusyError(error.message);
  if (error.name === "UnsupportedSchemaError") {
    return new UnsupportedSchemaError(error.message);
  }
  return new Error(error.message);
}

/**
 * Runs the synchronous SQLite adapter on a worker thread so a large session
 * cannot block the HTTP server's event loop. The public surface matches
 * ObservabilitySource; `ready()` resolves after the database is validated.
 */
export class WorkerSqliteSource implements ObservabilitySource {
  readonly kind = "sqlite" as const;
  readonly path: string;
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly readyPromise: Promise<void>;
  private nextID = 1;
  private closed = false;
  private failure: Error | null = null;

  constructor(path: string) {
    this.path = path;
    this.worker = new Worker(
      new URL(`./sqlite-worker${WORKER_EXTENSION}`, import.meta.url),
    );
    this.worker.on("message", (message: WorkerReply) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(reviveError(message.error ?? { name: "Error", message: "Worker error" }));
    });
    this.worker.on("error", (error) => {
      this.failure = error;
      this.failAll(error);
    });
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        const error = new Error(`SQLite worker exited with code ${code}`);
        this.failure = error;
        this.failAll(error);
      }
    });
    this.readyPromise = this.call<void>("init", path);
    this.readyPromise.catch(() => {
      // Surface the failure from ready() instead of as an unhandled rejection.
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  listSessions(options: { query?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    return this.call("listSessions", options);
  }

  getSession(sessionID: string): Promise<SessionMeta | null> {
    return this.call("getSession", sessionID);
  }

  listMessages(
    sessionID: string,
    options: { fromSeq?: number; toSeq?: number } = {},
  ): Promise<RawMessage[]> {
    return this.call("listMessages", sessionID, options);
  }

  getFamily(sessionID: string): Promise<SessionFamily> {
    return this.call("getFamily", sessionID);
  }

  messageBounds(
    sessionID: string,
  ): Promise<{ minSeq: number; maxSeq: number; count: number }> {
    return this.call("messageBounds", sessionID);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("SQLite worker closed"));
    }
    this.pending.clear();
    void this.worker.terminate();
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error("SQLite worker closed"));
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextID++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.worker.postMessage({ id, method, args });
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function openWorkerSqliteSource(path: string): WorkerSqliteSource {
  return new WorkerSqliteSource(path);
}
