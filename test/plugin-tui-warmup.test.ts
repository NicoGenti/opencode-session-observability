import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverDatabase } from "../src/core/adapters/paths.ts";
import { readTokenFile, tokenDirectory } from "../src/server/token-file.ts";
import { reachable } from "../src/plugin/tui-net.ts";
import {
  autoStartEnabled,
  basePort,
  decideWarmup,
  ensureServer,
  isProcessAlive,
  lockFilePath,
  readLock,
  removeLockIfOwned,
  resolvePackageRoot,
  resolveServerEntry,
  waitForHealth,
  writeLock,
  type WarmupStatus,
} from "../src/plugin/tui-warmup.ts";

const FALSY_ENV = ["0", "false", "no", "off"] as const;
const TRUTHY_ENV = ["1", "true", "yes", "on"] as const;

test("autoStartEnabled: default is on when neither knob nor env says otherwise", () => {
  assert.equal(autoStartEnabled(undefined, undefined), true);
  assert.equal(autoStartEnabled(true, undefined), true);
  assert.equal(autoStartEnabled(false, undefined), false);
  // Anything that is not an explicit `false` keeps the default-on behavior.
  assert.equal(autoStartEnabled("garbage", undefined), true);
  assert.equal(autoStartEnabled(42, undefined), true);
  assert.equal(autoStartEnabled(null, undefined), true);
});

test("autoStartEnabled: falsy env values disable auto-start over any option", () => {
  for (const env of FALSY_ENV) {
    assert.equal(autoStartEnabled(true, env), false, `option true, env ${env}`);
    assert.equal(autoStartEnabled(false, env), false, `option false, env ${env}`);
    assert.equal(autoStartEnabled("garbage", env), false, `option garbage, env ${env}`);
  }
});

test("autoStartEnabled: truthy env values enable auto-start over any option", () => {
  for (const env of TRUTHY_ENV) {
    assert.equal(autoStartEnabled(true, env), true, `option true, env ${env}`);
    assert.equal(autoStartEnabled(false, env), true, `option false, env ${env}`);
    assert.equal(autoStartEnabled("garbage", env), true, `option garbage, env ${env}`);
  }
});

test("autoStartEnabled: env parsing ignores case and surrounding whitespace", () => {
  assert.equal(autoStartEnabled(true, "  OFF "), false);
  assert.equal(autoStartEnabled(true, "False"), false);
  assert.equal(autoStartEnabled(false, " YES\n"), true);
  assert.equal(autoStartEnabled(false, "On"), true);
});

test("autoStartEnabled: an unrecognized env value defers to the option", () => {
  assert.equal(autoStartEnabled(false, "sometimes"), false);
  assert.equal(autoStartEnabled(true, "maybe"), true);
  // An empty env value counts as unset and defers to the option.
  assert.equal(autoStartEnabled(false, ""), false);
  assert.equal(autoStartEnabled(true, "   "), true);
});

test("decideWarmup: reachable statuses never spawn, down depends on the knob", () => {
  assert.equal(decideWarmup("ok", true), "already-running");
  assert.equal(decideWarmup("ok", false), "already-running");
  assert.equal(decideWarmup("auth", true), "already-running");
  assert.equal(decideWarmup("auth", false), "already-running");
  assert.equal(decideWarmup("down", true), "spawn");
  assert.equal(decideWarmup("down", false), "disabled");
});

test("basePort: reads the URL port and defaults to 4517 otherwise", () => {
  assert.equal(basePort("http://127.0.0.1:4517"), 4517);
  assert.equal(basePort("http://127.0.0.1:8080"), 8080);
  assert.equal(basePort("http://localhost:65535/"), 65535);
  assert.equal(basePort("http://127.0.0.1"), 4517);
  assert.equal(basePort("https://127.0.0.1"), 4517);
  assert.equal(basePort("not a url"), 4517);
  assert.equal(basePort("http://127.0.0.1:0"), 4517);
});

test("resolvePackageRoot: finds this worktree root from the dev layout", () => {
  const root = resolvePackageRoot();
  // This test lives in `<root>/test/`, so the root is one level up.
  const expected = resolve(fileURLToPath(new URL("..", import.meta.url)));
  assert.equal(root, expected);
  assert.equal(existsSync(join(root, "src", "server", "index.ts")), true);
  // The dev layout resolves two levels above `src/plugin/`, not to the module dir.
  assert.notEqual(root, resolve(fileURLToPath(new URL("../src/plugin/", import.meta.url))));
  assert.notEqual(root, resolve(fileURLToPath(new URL("../src/", import.meta.url))));
});

test("resolveServerEntry: resolves a real entry inside the worktree root", () => {
  const root = resolvePackageRoot();
  const entry = resolveServerEntry(root);
  assert.equal(resolveServerEntry(), entry);
  assert.equal(existsSync(entry), true);
  // The bundle wins when the build has run; the dev layout falls back to the
  // TypeScript source, which Node can still type-strip outside `node_modules`.
  const bundled = resolve(root, "dist-server", "server.mjs");
  assert.equal(
    entry,
    existsSync(bundled) ? bundled : resolve(root, "src", "server", "index.ts"),
  );
});

async function withPackageRoot(
  layout: { bundle: boolean; source: boolean },
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tui-warmup-root-"));
  try {
    if (layout.source) {
      await mkdir(join(root, "src", "server"), { recursive: true });
      await writeFile(join(root, "src", "server", "index.ts"), "");
    }
    if (layout.bundle) {
      await mkdir(join(root, "dist-server"), { recursive: true });
      await writeFile(join(root, "dist-server", "server.mjs"), "");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("resolveServerEntry: a built bundle is preferred over the TypeScript source", async () => {
  await withPackageRoot({ bundle: true, source: true }, async (root) => {
    assert.equal(
      resolveServerEntry(root),
      resolve(root, "dist-server", "server.mjs"),
    );
  });
});

test("resolveServerEntry: the dev layout falls back to the TypeScript source", async () => {
  await withPackageRoot({ bundle: false, source: true }, async (root) => {
    assert.equal(
      resolveServerEntry(root),
      resolve(root, "src", "server", "index.ts"),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 2: guarded spawn, lock, health wait and ensureServer seams.
// Every case injects probe/spawn and uses a temporary lock directory, so no
// port is bound, no child is spawned and no HTTP request is made.
// ---------------------------------------------------------------------------

/** A pid that cannot be running: far above every platform's pid ceiling. */
const DEAD_PID = 2_147_483_647;

async function withLockDir(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "tui-warmup-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Repeats the last value once the script runs out; counts calls. */
function probeScript(values: WarmupStatus[]): {
  probe: (base: string) => Promise<WarmupStatus>;
  calls: () => number;
} {
  let index = 0;
  return {
    probe: async () => values[Math.min(index++, values.length - 1)] ?? "down",
    calls: () => index,
  };
}

function lockFor(directory: string, port: number): string {
  return join(directory, `server-${port}.lock`);
}

test("lockFilePath: derives the per-port lock beside the token file", () => {
  assert.equal(lockFilePath(4517), join(tokenDirectory(), "server-4517.lock"));
  assert.equal(lockFilePath(8080), join(tokenDirectory(), "server-8080.lock"));
});

test("isProcessAlive: true for this process, false for a dead or invalid pid", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(DEAD_PID), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(1.5), false);
});

test("lock primitives: exclusive create, round-trip and ownership-checked removal", async () => {
  await withLockDir(async (directory) => {
    const file = lockFor(directory, 4601);
    assert.equal(readLock(file), null);
    assert.equal(writeLock(file, 1234), true);
    assert.equal(writeLock(file, 5678), false, "wx refuses a second writer");
    assert.deepEqual(readLock(file)?.pid, 1234);
    // Another owner's pid never removes the claim.
    removeLockIfOwned(file, 5678);
    assert.equal(readLock(file)?.pid, 1234);
    removeLockIfOwned(file, 1234);
    assert.equal(readLock(file), null);
    // A malformed lock reads as no lock at all.
    await writeFile(file, "{not a lock", "utf8");
    assert.equal(readLock(file), null);
  });
});

test("ensureServer: a dead-pid stale lock is replaced and the server starts", async () => {
  await withLockDir(async (directory) => {
    const port = 4602;
    const base = `http://127.0.0.1:${port}`;
    const file = lockFor(directory, port);
    assert.equal(writeLock(file, DEAD_PID), true);

    const script = probeScript(["down", "ok"]);
    let spawnCalls = 0;
    let claimAtSpawn: number | null = null;
    const result = await ensureServer(base, {
      autoStart: true,
      timeoutMs: 0,
      pollIntervalMs: 0,
      lockDirectory: directory,
      entry: "/virtual/server-entry.ts",
      probe: script.probe,
      spawn: async () => {
        spawnCalls += 1;
        claimAtSpawn = readLock(file)?.pid ?? null;
        return 4242;
      },
    });

    assert.equal(result, "ok");
    assert.equal(spawnCalls, 1, "the stale lock must not block the spawn");
    assert.equal(claimAtSpawn, process.pid, "the stale claim is replaced by ours");
    assert.equal(readLock(file), null, "the lock is released once healthy");
  });
});

test("ensureServer: a live foreign lock skips the spawn and waits on health", async () => {
  await withLockDir(async (directory) => {
    const port = 4603;
    const base = `http://127.0.0.1:${port}`;
    const file = lockFor(directory, port);
    const foreignPid = isProcessAlive(process.ppid) ? process.ppid : process.pid;
    assert.equal(writeLock(file, foreignPid), true);

    const script = probeScript(["down", "ok"]);
    const result = await ensureServer(base, {
      autoStart: true,
      timeoutMs: 0,
      pollIntervalMs: 0,
      lockDirectory: directory,
      entry: "/virtual/server-entry.ts",
      probe: script.probe,
      spawn: async () => {
        throw new Error("ensureServer must not spawn while a live claim exists");
      },
    });

    assert.equal(result, "ok");
    assert.equal(script.calls(), 2, "initial probe plus one health poll");
    assert.deepEqual(readLock(file)?.pid, foreignPid, "a foreign claim is left alone");
  });
});

test("ensureServer: the disabled knob neither writes a lock nor spawns", async () => {
  await withLockDir(async (directory) => {
    const port = 4604;
    const base = `http://127.0.0.1:${port}`;
    const result = await ensureServer(base, {
      autoStart: false,
      timeoutMs: 0,
      lockDirectory: directory,
      probe: async () => "down",
      spawn: async () => {
        throw new Error("ensureServer must not spawn when disabled");
      },
    });

    assert.equal(result, "down");
    assert.deepEqual(await readdir(directory), [], "no lock file is written");
  });
});

test("ensureServer: a spawn failure releases the lock and rejects", async () => {
  await withLockDir(async (directory) => {
    const port = 4605;
    const base = `http://127.0.0.1:${port}`;
    const failure = new Error("spawn ENOENT");
    await assert.rejects(
      ensureServer(base, {
        autoStart: true,
        timeoutMs: 0,
        lockDirectory: directory,
        entry: "/virtual/server-entry.ts",
        probe: async () => "down",
        spawn: async () => {
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.deepEqual(await readdir(directory), [], "the claim is released on failure");
  });
});

test("ensureServer: an EADDRINUSE loss re-probes and returns the winner", async () => {
  await withLockDir(async (directory) => {
    const port = 4606;
    const base = `http://127.0.0.1:${port}`;
    const file = lockFor(directory, port);
    // down (initial), down (health), ok (the second starter won the port).
    const script = probeScript(["down", "down", "ok"]);
    const result = await ensureServer(base, {
      autoStart: true,
      timeoutMs: 0,
      pollIntervalMs: 0,
      lockDirectory: directory,
      entry: "/virtual/server-entry.ts",
      probe: script.probe,
      spawn: async () => 4242,
    });

    assert.equal(result, "ok");
    assert.equal(script.calls(), 3, "the final re-probe ran");
    assert.equal(readLock(file), null, "the lock is released either way");
  });
});

test("ensureServer: a dead child with no winner stays down and releases the lock", async () => {
  await withLockDir(async (directory) => {
    const port = 4607;
    const base = `http://127.0.0.1:${port}`;
    const file = lockFor(directory, port);
    const script = probeScript(["down"]);
    const result = await ensureServer(base, {
      autoStart: true,
      timeoutMs: 0,
      pollIntervalMs: 0,
      lockDirectory: directory,
      entry: "/virtual/server-entry.ts",
      probe: script.probe,
      spawn: async () => 4242,
    });

    assert.equal(result, "down");
    assert.equal(script.calls(), 3, "initial, health and re-probe");
    assert.equal(readLock(file), null);
  });
});

test("ensureServer: a reachable base short-circuits with no spawn", async () => {
  await withLockDir(async (directory) => {
    const port = 4608;
    const result = await ensureServer(`http://127.0.0.1:${port}`, {
      autoStart: true,
      timeoutMs: 0,
      lockDirectory: directory,
      probe: async () => "ok",
      spawn: async () => {
        throw new Error("ensureServer must not spawn when the UI answers");
      },
    });
    assert.equal(result, "ok");
  });
});

test("ensureServer: concurrent callers share one in-flight warm-up", async () => {
  const port = 4609;
  const base = `http://127.0.0.1:${port}`;
  let probeCalls = 0;
  let spawnCalls = 0;
  const deps = {
    autoStart: true,
    timeoutMs: 0,
    probe: async (): Promise<WarmupStatus> => {
      probeCalls += 1;
      return "ok";
    },
    spawn: async () => {
      spawnCalls += 1;
      return 4242;
    },
  };

  const first = ensureServer(base, deps);
  const second = ensureServer(base, deps);
  assert.equal(first, second, "the same promise is returned while pending");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, "ok");
  assert.equal(b, "ok");
  assert.equal(probeCalls, 1, "one probe for both callers");
  assert.equal(spawnCalls, 0);

  // Once settled the cache is dropped, so a later call probes again.
  assert.equal(await ensureServer(base, deps), "ok");
  assert.equal(probeCalls, 2);
});

test("waitForHealth: polls until ready and returns down at the budget", async () => {
  const ready = probeScript(["down", "down", "auth"]);
  assert.equal(await waitForHealth("http://127.0.0.1:4610", 1_000, ready.probe, 0), "auth");
  assert.equal(ready.calls(), 3);

  const offline = probeScript(["down"]);
  assert.equal(await waitForHealth("http://127.0.0.1:4610", 0, offline.probe, 0), "down");
  assert.equal(offline.calls(), 1, "an expired budget probes once");
});

test("ensureServer: the spawn path waits for the token record after auth", async () => {
  await withLockDir(async (directory) => {
    const port = 4611;
    const base = `http://127.0.0.1:${port}`;
    const script = probeScript(["down", "auth"]);
    const tokenReads: string[] = [];
    const result = await ensureServer(base, {
      autoStart: true,
      timeoutMs: 0,
      pollIntervalMs: 0,
      lockDirectory: directory,
      entry: "/virtual/server-entry.ts",
      probe: script.probe,
      spawn: async () => 4242,
      readToken: async (url) => {
        tokenReads.push(url);
        // The first two reads race the server's write; then the record lands.
        return tokenReads.length >= 3 ? "secret-token" : null;
      },
    });

    assert.equal(result, "auth");
    assert.equal(tokenReads.length, 3, "two misses then the published record");
    assert.equal(tokenReads[0], base, "the token is read for the warmed base");
    assert.equal(readLock(lockFor(directory, port)), null);
  });
});

test("ensureServer: ok and the already-running fast path never poll the token", async () => {
  await withLockDir(async (directory) => {
    let reads = 0;
    const readToken = async (): Promise<string | null> => {
      reads += 1;
      return "secret-token";
    };

    // Initial probe is down, so the spawn path runs; health then answers "ok".
    const okScript = probeScript(["down", "ok"]);
    const okResult = await ensureServer(`http://127.0.0.1:4612`, {
      autoStart: true,
      timeoutMs: 0,
      pollIntervalMs: 0,
      lockDirectory: directory,
      entry: "/virtual/server-entry.ts",
      probe: okScript.probe,
      spawn: async () => 4242,
      readToken,
    });
    assert.equal(okResult, "ok");
    assert.equal(reads, 0, "an ok result skips the token wait");

    // Reachable on the first probe: the fast path never reaches the spawn code.
    const fastResult = await ensureServer(`http://127.0.0.1:4613`, {
      autoStart: true,
      timeoutMs: 0,
      lockDirectory: directory,
      probe: async () => "auth",
      spawn: async () => {
        throw new Error("the fast path must not spawn");
      },
      readToken,
    });
    assert.equal(fastResult, "auth");
    assert.equal(reads, 0, "the fast path skips the token wait");
  });
});

test("ensureServer: auth is returned after the token budget with no record", async () => {
  await withLockDir(async (directory) => {
    let reads = 0;
    const script = probeScript(["down", "auth"]);
    const started = Date.now();
    const result = await ensureServer(`http://127.0.0.1:4614`, {
      autoStart: true,
      timeoutMs: 0,
      pollIntervalMs: 0,
      lockDirectory: directory,
      entry: "/virtual/server-entry.ts",
      probe: script.probe,
      spawn: async () => 4242,
      readToken: async () => {
        reads += 1;
        return null;
      },
    });

    assert.equal(result, "auth", "auth survives the empty token wait");
    assert.ok(reads > 1, "the token file was polled repeatedly");
    assert.ok(
      Date.now() - started >= 900,
      "the wait used its ~1000 ms budget before giving up",
    );
  });
});

test("ensureServer: a lock older than 24 h is stale even with a live pid", async () => {
  await withLockDir(async (directory) => {
    const port = 4615;
    const file = lockFor(directory, port);
    // Our own pid is alive, but the claim is a day and an hour old.
    const createdAt = new Date(
      Date.now() - 25 * 60 * 60 * 1000,
    ).toISOString();
    await writeFile(
      file,
      `${JSON.stringify({ version: 1, pid: process.pid, createdAt })}\n`,
      "utf8",
    );

    const script = probeScript(["down", "ok"]);
    let claimAtSpawn: number | null = null;
    const result = await ensureServer(`http://127.0.0.1:${port}`, {
      autoStart: true,
      timeoutMs: 0,
      pollIntervalMs: 0,
      lockDirectory: directory,
      entry: "/virtual/server-entry.ts",
      probe: script.probe,
      spawn: async () => {
        claimAtSpawn = readLock(file)?.pid ?? null;
        return 4242;
      },
    });

    assert.equal(result, "ok");
    assert.equal(claimAtSpawn, process.pid, "the aged claim was replaced");
    assert.equal(readLock(file), null, "the lock is released once healthy");
  });
});

// ---------------------------------------------------------------------------
// Phase 4: one real child on one real port.
//
// Every case above injects `probe`/`spawn`; this one does not. It exercises the
// production path end to end: the real `spawnServer` starts `src/server/index.ts`
// against the discovered OpenCode 2 database, `/api/health` is polled until it
// answers, and the child is then terminated. It is additive and skips (rather
// than fails) when the machine cannot run it: no discoverable database, no free
// loopback port, or a platform that cannot spawn the child.
//
// Isolation: the child inherits `OPENCODE_OBSERVABILITY_TOKEN_DIR`, so its token
// file and the per-port lock land in a per-test temporary directory instead of
// the user's real token directory. The env var is restored in `finally`.
// ---------------------------------------------------------------------------

/**
 * A port the OS just handed out. Binding port 0 and closing leaves a small
 * window in which another process could take the port; that race is accepted
 * (and announced in this comment) because the alternative, hardcoding a port,
 * is strictly worse.
 */
function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) rejectPromise(error);
        else if (port > 0) resolvePromise(port);
        else rejectPromise(new Error("the OS assigned no port"));
      });
    });
  });
}

/** Polls the child's token file, which records the server pid. */
async function waitForTokenRecord(
  port: number,
  budgetMs: number,
): Promise<{ pid: number } | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const record = await readTokenFile(port);
    if (record) return record;
    if (Date.now() >= deadline) return null;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

/** Probes until the base stops answering; `true` once it is gone. */
async function waitForDown(base: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if ((await reachable(base)) === "down") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

function waitForExit(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  return new Promise<boolean>((resolvePromise) => {
    const tick = (): void => {
      if (!isProcessAlive(pid)) {
        resolvePromise(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolvePromise(false);
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** `taskkill /T` also covers a child that a shell wrapper might have introduced. */
function taskkillTree(pid: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    try {
      const killer = spawnProcess(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", () => resolvePromise());
      killer.once("exit", () => resolvePromise());
    } catch {
      resolvePromise();
    }
  });
}

/** Terminates the real child: plain signal first, taskkill/SIGKILL on Windows. */
async function terminateChild(pid: number): Promise<void> {
  try {
    process.kill(pid);
  } catch {
    // Already gone: nothing to terminate.
  }
  if (await waitForExit(pid, 3_000)) return;
  if (process.platform === "win32") {
    await taskkillTree(pid);
    if (await waitForExit(pid, 3_000)) return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await waitForExit(pid, 2_000);
}

test("ensureServer: a real spawned server answers on a free port and is terminated", async (t) => {
  // The child discovers the database itself (spawnServer passes no --db), so
  // the same precondition decides whether this case can run at all.
  try {
    discoverDatabase();
  } catch (error) {
    t.skip(
      `no discoverable OpenCode 2 database: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  let port: number;
  try {
    port = await freeLoopbackPort();
  } catch (error) {
    t.skip(
      `no free loopback port: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const previousTokenDir = process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR;
  const tokenDir = await mkdtemp(join(tmpdir(), "tui-warmup-live-"));
  // The spawned child inherits this, so its token file and the lock stay here.
  process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR = tokenDir;

  const base = `http://127.0.0.1:${port}`;
  const lockFile = join(tokenDir, `server-${port}.lock`);

  // `ensureServer` writes its own pid into the lock and then adopts the child's
  // pid; watching the file is the fallback when the token file is not written.
  let childPid: number | null = null;
  const watchLock = setInterval(() => {
    const record = readLock(lockFile);
    if (record && record.pid !== process.pid) childPid = record.pid;
  }, 10);
  watchLock.unref?.();

  let stopped = false;
  try {
    assert.equal(
      tokenDirectory(),
      tokenDir,
      "the case runs against an isolated token directory",
    );
    assert.notEqual(
      tokenDir,
      previousTokenDir ?? "",
      "the token-directory env changed for this case",
    );

    let status: WarmupStatus;
    try {
      status = await ensureServer(base, {
        autoStart: true,
        // Tests own a larger budget than the 10 s production default.
        timeoutMs: 30_000,
        pollIntervalMs: 200,
      });
    } catch (error) {
      t.skip(
        `the real spawn is unavailable on this platform: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    const tokenRecord = await waitForTokenRecord(port, 5_000);
    if (tokenRecord) childPid = tokenRecord.pid;
    if (childPid === null) {
      // The port was already served when ensureServer probed it (the free-port
      // race lost), so this case never owned a child to clean up.
      t.skip("the free port was taken before the case could spawn its child");
      return;
    }
    if (!tokenRecord && (status === "auth" || status === "ok")) {
      // A foreign server can take the port after our child booted and answered
      // health, in which case our child never published a token record (it lost
      // the port). Skip rather than assert on a process this case does not own.
      t.skip(
        "a foreign server owns the port: no token record was published for the spawned child",
      );
      return;
    }

    // The server answered. `/api/health` is unauthenticated, but the spawned
    // server still generates a per-run token, so its payload reports
    // `authRequired: true` and `reachable()` maps that to "auth" (ready).
    // "ok" occurs when auth is disabled; both mean the real child answered.
    assert.ok(
      status === "auth" || status === "ok",
      `expected a reachable status, got ${status}`,
    );

    const health = await fetch(`${base}/api/health`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(health.status, 200);
    const body = (await health.json()) as {
      ok?: unknown;
      authRequired?: unknown;
    };
    assert.equal(body.ok, true);
    assert.equal(
      status,
      body.authRequired === true ? "auth" : "ok",
      "the probe status matches the health payload",
    );
    assert.equal(existsSync(lockFile), false, "the lock is released after warm-up");
    assert.equal(
      isProcessAlive(childPid),
      true,
      "the spawned server is still running before cleanup",
    );

    const pid = childPid;
    await terminateChild(pid);
    stopped = true;
    assert.equal(isProcessAlive(pid), false, "the child process is gone");
    assert.equal(
      await waitForDown(base, 5_000),
      true,
      "the port stops answering once the child is terminated",
    );
    assert.equal(existsSync(lockFile), false, "no lock is left behind in tmp");
  } finally {
    clearInterval(watchLock);
    if (!stopped && childPid !== null) await terminateChild(childPid);
    if (previousTokenDir === undefined) {
      delete process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR;
    } else {
      process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR = previousTokenDir;
    }
    await rm(tokenDir, { recursive: true, force: true });
  }
});

