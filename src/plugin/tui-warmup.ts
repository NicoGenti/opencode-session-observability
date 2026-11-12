import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenDirectory } from "../server/token-file.ts";
import { reachable, tokenFromFile } from "./tui-net.ts";

/**
 * Warm-up decision helpers for the local UI (issue #9).
 *
 * Pure, host-independent logic for the auto-start path: the env/option knob,
 * the spawn decision, the base port and package-root/entry resolution. Phase 2
 * adds the guarded spawn: a per-port lock, a detached child process, a bounded
 * health wait and `ensureServer`, the single entry point Phase 3 calls.
 *
 * It imports Node stdlib and two leaf helpers it can share without a cycle:
 * `tokenDirectory()` (the lock lives beside the token file, so the test env
 * override follows automatically) and `reachable()`. It imports nothing from
 * `tui.ts`, `tui-native.ts` or `tui-status.ts`.
 *
 * Resolution walks *up* from this module: the dev layout puts the package root
 * two levels above `src/plugin/`, the npm bundle puts it one level above
 * `dist-tui/`, where the bundled copy of this file lives.
 */

/** Keep in sync with `tui-net.ts`; owning the literal avoids a transport import. */
const DEFAULT_PORT = 4517;

const SERVER_ENTRY_SEGMENTS = ["src", "server", "index.ts"] as const;

/**
 * Prebuilt server bundle. Node ≥22.18 refuses to type-strip `.ts` files under
 * `node_modules`, so an installed package runs this ESM artifact instead.
 */
const BUNDLED_ENTRY_SEGMENTS = ["dist-server", "server.mjs"] as const;

/** Enough for `dist-tui/` (1 up) and `src/plugin/` (2 up) with room to spare. */
const MAX_ANCESTOR_DEPTH = 8;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/** Health poll cadence and the total warm-up budget. */
const POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * After a spawned server reports "auth", the token file is written just after
 * the socket starts listening. Wait briefly for it so the first `openView`
 * after boot does not race the write; "auth" is still the answer at expiry.
 */
const TOKEN_POLL_TIMEOUT_MS = 1_000;
const TOKEN_POLL_INTERVAL_MS = 100;

/**
 * A claim older than this is stale even when its pid is alive, which bounds
 * the pid-reuse window (a recycled pid must not pin a dead server's lock).
 */
const LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/** How long to listen for the child's "error" event before treating it as spawned. */
const SPAWN_SETTLE_MS = 250;

/** Loopback only: the auto-started server is never exposed beyond this host. */
const SPAWN_HOST = "127.0.0.1";

const LOCK_VERSION = 1;

/** Directory holding this module, in whichever layout it is loaded from. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function envFlag(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (FALSE_VALUES.has(normalized)) return false;
  if (TRUE_VALUES.has(normalized)) return true;
  // Unrecognized and blank values defer to the option instead of guessing.
  return undefined;
}

/**
 * Whether the local UI should be started on demand.
 *
 * A recognized env value wins over the plugin option in both directions; an
 * unrecognized or blank env value defers to the option, and the default is on
 * (`option !== false`).
 */
export function autoStartEnabled(
  option: unknown,
  envValue: string | undefined,
): boolean {
  const fromEnv = typeof envValue === "string" ? envFlag(envValue) : undefined;
  return fromEnv ?? option !== false;
}

/** What the warm-up launcher should do for a given reachability probe. */
export function decideWarmup(
  status: "ok" | "auth" | "down",
  autoStart: boolean,
): "already-running" | "spawn" | "disabled" {
  if (status === "ok" || status === "auth") return "already-running";
  return autoStart ? "spawn" : "disabled";
}

/** Port of a configured base URL, falling back to the default local UI port. */
export function basePort(base: string): number {
  try {
    const url = new URL(base);
    if (url.port.length === 0) return DEFAULT_PORT;
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 && port <= 65_535
      ? port
      : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/**
 * Package root, found by walking up from this module until a directory that
 * contains `src/server/index.ts` is reached. Serves both the dev layout and the
 * installed layout, and fails with the probed chain rather than inventing one.
 */
export function resolvePackageRoot(): string {
  const probed: string[] = [];
  let current = MODULE_DIR;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    probed.push(current);
    if (existsSync(join(current, ...SERVER_ENTRY_SEGMENTS))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `tui-warmup: package root not found (looked for ${SERVER_ENTRY_SEGMENTS.join("/")}); probed: ${probed.join(" -> ")}`,
  );
}

/**
 * Absolute path of the server entry point inside `root` (defaults to the
 * package root). The prebuilt bundle wins when it exists: that is the single
 * layout that runs under `node_modules/`, where Node will not type-strip `.ts`.
 * Without it the dev layout falls back to the TypeScript source.
 */
export function resolveServerEntry(root: string = resolvePackageRoot()): string {
  const bundled = resolve(root, ...BUNDLED_ENTRY_SEGMENTS);
  if (existsSync(bundled)) return bundled;
  return resolve(root, ...SERVER_ENTRY_SEGMENTS);
}

/** Where the local UI answers: reachable, token-protected, or offline. */
export type WarmupStatus = "ok" | "auth" | "down";

/**
 * Test seams. Every field defaults to the real behavior, so production callers
 * pass only `autoStart`/`timeoutMs` and tests never touch the network, spawn a
 * process or write outside their own temporary directory.
 */
export interface EnsureServerDeps {
  probe?: (base: string) => Promise<WarmupStatus>;
  spawn?: (entry: string, port: number) => Promise<number>;
  entry?: string;
  lockDirectory?: string;
  pollIntervalMs?: number;
  /** Reads the per-port token record; defaults to `tokenFromFile(base)`. */
  readToken?: (base: string) => Promise<string | null>;
}

export interface EnsureServerOptions extends EnsureServerDeps {
  autoStart?: boolean;
  timeoutMs?: number;
}

interface LockRecord {
  version: 1;
  pid: number;
  createdAt: string;
}

/**
 * Lock file for a port, beside the token file. Deriving the directory from
 * `tokenDirectory()` means the `OPENCODE_OBSERVABILITY_TOKEN_DIR` override the
 * server and tests already use applies to locks too.
 */
export function lockFilePath(port: number): string {
  return join(tokenDirectory(), `server-${port}.lock`);
}

/**
 * Liveness probe via signal 0. `EPERM` means the process exists but belongs to
 * someone else (or is unsignalable on Windows), so it still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a claim can be replaced. A lock whose `createdAt` is older than
 * `LOCK_STALE_MS` is stale regardless of pid liveness, because a recycled pid
 * can otherwise keep a dead server's claim alive indefinitely. A record with
 * no parseable timestamp falls back to the pid probe alone.
 */
function isLockStale(record: LockRecord, now: number = Date.now()): boolean {
  const createdAt = Date.parse(record.createdAt);
  if (Number.isFinite(createdAt) && now - createdAt > LOCK_STALE_MS) return true;
  return !isProcessAlive(record.pid);
}

/** Reads a lock record; a missing or malformed file reads as `null`. */
export function readLock(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LockRecord>;
    if (
      parsed.version !== LOCK_VERSION ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0
    ) {
      return null;
    }
    return {
      version: LOCK_VERSION,
      pid: parsed.pid,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Claims the lock with an exclusive create. Returns `false` when the file
 * already exists or cannot be created; the caller then treats the port as
 * claimed rather than risk starting a second server.
 */
export function writeLock(file: string, pid: number): boolean {
  const record: LockRecord = {
    version: LOCK_VERSION,
    pid,
    createdAt: new Date().toISOString(),
  };
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the lock only when its `pid` is the one this caller claimed, so a
 * slower starter never deletes a newer starter's claim.
 */
export function removeLockIfOwned(file: string, pid: number): void {
  const record = readLock(file);
  if (!record || record.pid !== pid) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // A stale lock is harmless: the next starter treats it as reclaimable.
  }
}

/** Rewrites the claim with the child pid once the process exists. */
function adoptLock(file: string, pid: number): boolean {
  const record: LockRecord = {
    version: LOCK_VERSION,
    pid,
    createdAt: new Date().toISOString(),
  };
  try {
    writeFileSync(file, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Claims the lock for `port`, clearing a lock whose pid is gone. A live foreign
 * pid (another starter is spawning or has already spawned) means "do not
 * spawn"; the caller polls health instead.
 */
function claimLock(file: string): "owned" | "busy" {
  if (writeLock(file, process.pid)) return "owned";
  const existing = readLock(file);
  if (existing && !isLockStale(existing)) return "busy";
  // Dead or malformed claim: drop it and retry the exclusive create once.
  try {
    rmSync(file, { force: true });
  } catch {
    // Fall through to the retry; a live claim still wins below.
  }
  // Another starter may have replaced the stale claim between our read and the
  // unlink. Re-read exactly once: a fresh live record means it owns the port, so
  // return "busy" without a retry write that would race it.
  const raced = readLock(file);
  if (raced && !isLockStale(raced)) return "busy";
  if (writeLock(file, process.pid)) return "owned";
  // A fresh claim that survived the retry belongs to another starter; a
  // permission failure also means "do not spawn" rather than two servers.
  return "busy";
}

/**
 * Starts the local UI detached so it outlives the TUI, and resolves with the
 * child pid. A missing entry rejects immediately; the child's own "error"
 * event is awaited briefly so an unspawnable runtime rejects too.
 */
export function spawnServer(entry: string, port: number): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    if (!existsSync(entry)) {
      rejectPromise(new Error(`tui-warmup: server entry not found: ${entry}`));
      return;
    }
    const child = spawn(
      process.execPath,
      [entry, "--host", SPAWN_HOST, "--port", String(port)],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      const pid = child.pid;
      if (typeof pid === "number" && pid > 0) resolvePromise(pid);
      else rejectPromise(new Error("tui-warmup: spawned server has no pid"));
    }, SPAWN_SETTLE_MS);
    timer.unref?.();

    // Kept attached after settling so a late event can never become unhandled.
    child.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      const pid = child.pid;
      if (typeof pid === "number" && pid > 0) resolvePromise(pid);
      else rejectPromise(new Error("tui-warmup: spawned server has no pid"));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    // Never hold the host process open just to finish a warm-up wait.
    timer.unref?.();
  });
}

/**
 * Polls the health endpoint until the UI answers or the budget expires.
 * Returns "down" past the budget; callers treat "ok" and "auth" as ready.
 */
export async function waitForHealth(
  base: string,
  timeoutMs: number,
  probe: (base: string) => Promise<WarmupStatus> = reachable,
  pollIntervalMs: number = POLL_INTERVAL_MS,
): Promise<WarmupStatus> {
  const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  const deadline = Date.now() + budget;
  for (;;) {
    const status = await probe(base);
    if (status === "ok" || status === "auth") return status;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "down";
    await delay(Math.min(Math.max(0, pollIntervalMs), remaining));
  }
}

/**
 * Waits for the spawned server's token file. The health endpoint can answer
 * "auth" a moment before the record is renamed into place; a short bounded poll
 * closes that window. The outcome is advisory only: the caller returns "auth"
 * either way, and `openView` reads the token itself afterwards.
 */
async function awaitTokenRecord(
  base: string,
  readToken: (base: string) => Promise<string | null>,
  timeoutMs: number = TOKEN_POLL_TIMEOUT_MS,
  pollIntervalMs: number = POLL_INTERVAL_MS,
): Promise<boolean> {
  const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
  const deadline = Date.now() + budget;
  for (;;) {
    if ((await readToken(base)) !== null) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(Math.max(0, pollIntervalMs), remaining));
  }
}

/** One in-flight warm-up per normalized base URL; concurrent callers share it. */
const inFlight = new Map<string, Promise<WarmupStatus>>();

/**
 * Makes sure the local UI answers at `base`, spawning it once when the knob
 * allows. Resolves "ok"/"auth" when it is or became reachable and "down" when
 * the budget expires; a spawn failure rejects with the spawn error.
 */
export function ensureServer(
  base: string,
  options: EnsureServerOptions = {},
): Promise<WarmupStatus> {
  const key = base.replace(/\/+$/, "");
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = runEnsureServer(key, options).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function runEnsureServer(
  base: string,
  options: EnsureServerOptions,
): Promise<WarmupStatus> {
  const probe = options.probe ?? reachable;
  const spawnFn = options.spawn ?? spawnServer;
  const readToken = options.readToken ?? tokenFromFile;
  const lockDirectory = options.lockDirectory ?? tokenDirectory();
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const autoStart = options.autoStart ?? true;

  const initial = await probe(base);
  const decision = decideWarmup(initial, autoStart);
  if (decision === "already-running") return initial;
  if (decision === "disabled") return "down";

  const port = basePort(base);
  const lockFile = join(lockDirectory, `server-${port}.lock`);

  if (claimLock(lockFile) === "busy") {
    // Another starter owns the port: wait for its server instead of racing it.
    return waitForHealth(base, timeoutMs, probe, pollIntervalMs);
  }

  let ownerPid = process.pid;
  try {
    const childPid = await spawnFn(options.entry ?? resolveServerEntry(), port);
    if (adoptLock(lockFile, childPid)) ownerPid = childPid;
    const status = await waitForHealth(base, timeoutMs, probe, pollIntervalMs);
    // Spawn path only: the server may need a moment to publish its token file
    // after the socket answers. The already-running fast path skips this.
    if (status === "auth") {
      await awaitTokenRecord(
        base,
        readToken,
        TOKEN_POLL_TIMEOUT_MS,
        TOKEN_POLL_INTERVAL_MS,
      );
      return status;
    }
    if (status !== "down") return status;
    // The child may have exited with EADDRINUSE because a slower starter won
    // the port; probe once more before declaring the UI down.
    return probe(base);
  } finally {
    removeLockIfOwned(lockFile, ownerPid);
  }
}
