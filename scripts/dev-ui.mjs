#!/usr/bin/env node
/**
 * Dev-only launcher for the React UI.
 *
 * It reuses the production server seam unchanged — `createObservabilityServer`
 * with an explicit `uiRoot` of `<repoRoot>/dist-ui` — and the same loopback,
 * port and token semantics as `src/server/index.ts main()`. It composes only
 * exported building blocks: no file under `src/server/` or `src/core/` is
 * modified or reimplemented.
 *
 * The watcher is a separate process, per the Phase 0 dev-loop decision:
 *
 *   terminal 1:  npm run build:ui -- --watch
 *   terminal 2:  node scripts/dev-ui.mjs
 *
 * The server rebuilds nothing; it serves whatever `dist-ui/` currently holds.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateToken } from "../src/server/auth.ts";
import { createObservabilityServer } from "../src/server/http.ts";
import {
  clearTokenFile,
  removeTokenFile,
  writeTokenFile,
} from "../src/server/token-file.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const uiRoot = join(repoRoot, "dist-ui");

const HELP = `Dev launcher for the React UI (serves dist-ui/ through the real server)

Usage:
  node scripts/dev-ui.mjs [options]

Options:
  --db <path>       Path to the OpenCode 2 SQLite database
                    (default: discover XDG/OpenCode 2 locations)
  --port <port>     Port (default: 4517; 0 picks a free port)
  --host <host>     Bind address, loopback only (default: 127.0.0.1)
  --token           Generate a per-run access token (default) and print it
  --token=<value>   Use an explicit access token (at least 16 characters)
  --no-auth         Disable the access token (loopback only)
  --help, -h        Show this help

Run \`npm run build:ui -- --watch\` alongside to rebuild dist-ui/ on change.
`;

function parseArgs(argv) {
  const options = { host: "127.0.0.1", port: 4517, noAuth: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-auth") {
      options.noAuth = true;
    } else if (arg === "--token") {
      options.authToken = generateToken();
      options.generatedToken = true;
    } else if (arg.startsWith("--token=")) {
      const value = arg.slice("--token=".length).trim();
      if (value.length < 16) throw new Error("--token must be at least 16 characters");
      options.authToken = value;
      options.generatedToken = false;
    } else if (arg === "--db") {
      const value = argv[++index];
      if (!value) throw new Error("--db requires a path");
      options.dbPath = value;
    } else if (arg.startsWith("--db=")) {
      options.dbPath = arg.slice("--db=".length);
    } else if (arg === "--host") {
      const value = argv[++index];
      if (!value) throw new Error("--host requires a value");
      options.host = value;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--port") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      options.port = value;
    } else if (arg.startsWith("--port=")) {
      const value = Number(arg.slice("--port=".length));
      if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      options.port = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.noAuth && options.authToken !== undefined) {
    throw new Error("--token and --no-auth are mutually exclusive");
  }
  if (options.host !== undefined && !LOOPBACK_HOSTS.has(options.host.toLowerCase())) {
    throw new Error(
      `Refusing to bind ${options.host}: this dev launcher is loopback-only.`,
    );
  }
  if (options.noAuth) {
    options.authToken = undefined;
    options.generatedToken = false;
  } else if (options.authToken === undefined) {
    options.authToken = generateToken();
    options.generatedToken = true;
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  if (!existsSync(join(uiRoot, "index.html"))) {
    process.stderr.write(
      `Warning: ${join(uiRoot, "index.html")} is missing. ` +
        "Run `npm run build:ui -- --watch` in another terminal.\n",
    );
  }

  const running = await createObservabilityServer({
    dbPath: options.dbPath,
    host: options.host,
    port: options.port,
    allowReveal: false,
    authToken: options.authToken,
    uiRoot,
  });

  let tokenFile = null;
  if (options.authToken && options.generatedToken) {
    try {
      tokenFile = await writeTokenFile(running.port, options.authToken);
    } catch (error) {
      process.stderr.write(
        `Warning: could not write the token file: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  } else {
    // An explicit token is not persisted; clear any stale file for this port.
    await clearTokenFile(running.port);
  }

  const url = options.authToken
    ? `${running.url}/#/?token=${encodeURIComponent(options.authToken)}`
    : running.url;

  process.stdout.write(
    [
      "OpenCode Session Observability (dev UI)",
      `UI root:  ${uiRoot}`,
      `Database: ${running.dbPath}`,
      `Bind:     ${running.host}:${running.port}`,
      `URL:      ${url}`,
      options.authToken
        ? `Auth:     token required (${options.generatedToken ? "generated" : "explicit"}); do not share this URL`
        : "Auth:     disabled (--no-auth; loopback only)",
      ...(tokenFile ? [`Token:    ${tokenFile} (read by the TUI)`] : []),
      "Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await running.close();
    } finally {
      if (tokenFile && options.authToken) {
        await removeTokenFile(running.port, options.authToken);
      }
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
