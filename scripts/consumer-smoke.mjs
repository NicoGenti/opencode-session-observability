import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message) {
  throw new Error(message);
}

function parseNodeVersion(version) {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  return { major, minor };
}

function assertSupportedNode() {
  const { major, minor } = parseNodeVersion(process.versions.node);
  const supported = major > 22 || (major === 22 && minor >= 18);
  if (!supported) {
    process.stderr.write(
      `consumer-smoke requires Node >= 22.18 (found ${process.versions.node}); ` +
        "the smoke relies on built-in type stripping to load the fixture module.\n",
    );
    process.exit(1);
  }
}

/** Resolves the npm CLI so install/exec never depend on PATH or a shell. */
function resolveNpmCli() {
  const fromEnv = process.env.npm_execpath;
  const candidates = [
    fromEnv && fromEnv.endsWith(".js") ? fromEnv : undefined,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) fail("could not locate npm-cli.js for the consumer install");
  return found;
}

function runNpm(npmCli, args, cwd) {
  return spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8" });
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Collects the fixture's secret values at runtime: sensitive-keyed strings and
 * secret-shaped tokens found anywhere in the fixture tree. Values stay in
 * memory and are never printed.
 */
function collectFixtureSecrets(fixture) {
  const secrets = new Set();
  const patterns = [
    /sk-[A-Za-z0-9_-]{8,}/g,
    /ghp_[A-Za-z0-9]{8,}/g,
    /Bearer\s+([A-Za-z0-9._-]{8,})/g,
    /token=([A-Za-z0-9._-]{8,})/g,
  ];
  const sensitiveKey = /api[_-]?key|password|secret|token|authorization/i;
  const add = (value) => {
    if (typeof value === "string" && value.length >= 6) secrets.add(value);
  };
  const walk = (node, key) => {
    if (typeof node === "string") {
      if (sensitiveKey.test(key)) add(node);
      for (const pattern of patterns) {
        for (const match of node.matchAll(pattern)) add(match[1] ?? match[0]);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, childValue] of Object.entries(node)) {
        if (typeof childValue === "string" && sensitiveKey.test(childKey)) {
          add(childValue);
        }
        walk(childValue, childKey);
      }
    }
  };
  walk(fixture, "");
  return [...secrets];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolves a literal tarball path or a single-match `*.tgz` pattern. */
function resolveTarball(arg) {
  const resolved = resolve(ROOT, arg);
  if (!resolved.includes("*")) {
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      fail(`tarball not found: ${resolved}`);
    }
    return resolved;
  }
  const directory = dirname(resolved);
  const pattern = basename(resolved);
  if (!existsSync(directory)) fail(`tarball directory not found: ${directory}`);
  const matcher = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  const matches = readdirSync(directory)
    .filter((entry) => matcher.test(entry))
    .map((entry) => join(directory, entry))
    .filter((entry) => statSync(entry).isFile());
  if (matches.length === 0) fail(`no tarball matched ${pattern} in ${directory}`);
  if (matches.length > 1) {
    fail(
      `multiple tarballs matched ${pattern}: ${matches.map((entry) => basename(entry)).join(", ")}`,
    );
  }
  return matches[0];
}

async function parseBind(stdoutChunks, deadline, child) {
  while (Date.now() < deadline) {
    const match = /Bind:\s+([^\s:]+):(\d+)/.exec(stdoutChunks.join(""));
    if (match) return Number(match[2]);
    if (child.exitCode !== null) {
      fail(`installed server exited early with code ${child.exitCode}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  fail("installed server did not print its bind line within 10s");
}

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--tarball");
  const tarballArg = index === -1 ? undefined : args[index + 1];
  if (!tarballArg) fail("usage: node scripts/consumer-smoke.mjs --tarball <package.tgz>");
  const tarball = resolveTarball(tarballArg);

  const repoPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const repoVersion = repoPkg.version;
  const npmCli = resolveNpmCli();
  const fixtureModule = await import(
    pathToFileURL(join(ROOT, "test", "fixtures", "build.ts")).href
  );

  const consumerDir = mkdtempSync(join(tmpdir(), "opencode-consumer-smoke-"));
  const installDir = join(consumerDir, "node_modules", "opencode-session-observability");
  const binPath = join(installDir, "bin", "opencode-observability.mjs");
  let dbDirectory;
  let server;

  try {
    // npm on Windows reports "up to date" for a cwd install without a
    // package.json; --prefix is the reliable way to materialize
    // <consumer>/node_modules/opencode-session-observability.
    const install = runNpm(
      npmCli,
      [
        "install",
        tarball,
        "--prefix",
        consumerDir,
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--omit=dev",
      ],
      consumerDir,
    );
    if (install.status !== 0) {
      process.stderr.write(`${install.stderr ?? ""}\n`);
      fail(`npm install of the tarball failed (exit ${install.status})`);
    }
    if (!existsSync(binPath) || !existsSync(join(installDir, "dist", "server", "index.js"))) {
      fail("installed layout is missing bin/ or dist/server/index.js");
    }
    console.log("install: isolated node_modules layout OK");

    const installedPkg = JSON.parse(readFileSync(join(installDir, "package.json"), "utf8"));
    const dependencyNames = Object.keys(installedPkg.dependencies ?? {});
    if (dependencyNames.length !== 0) {
      fail(`installed package declares runtime dependencies: ${dependencyNames.join(", ")}`);
    }
    if (installedPkg.version !== repoVersion) {
      fail(`installed version ${installedPkg.version} != repo version ${repoVersion}`);
    }
    console.log(`deps: zero runtime dependencies, installed version ${installedPkg.version}`);

    const help = spawnSync(process.execPath, [binPath, "--help"], {
      cwd: consumerDir,
      encoding: "utf8",
    });
    if (help.status !== 0) fail(`installed --help exited with ${help.status}`);
    if (!(help.stdout ?? "").includes("Usage:")) {
      fail("installed --help did not print Usage:");
    }
    console.log("cli: installed bin --help OK (no TS type stripping needed)");

    const version = spawnSync(
      process.execPath,
      [npmCli, "exec", "--no", "--", "opencode-observability", "--version"],
      { cwd: consumerDir, encoding: "utf8" },
    );
    if (version.status !== 0) {
      process.stderr.write(`${version.stderr ?? ""}\n`);
      fail(`npx --no-install opencode-observability --version exited with ${version.status}`);
    }
    if ((version.stdout ?? "").trim() !== repoVersion) {
      fail(`npx version ${(version.stdout ?? "").trim()} != repo version ${repoVersion}`);
    }
    console.log(`cli: npx --no-install version ${repoVersion}`);

    const fixture = fixtureModule.secretsFixture();
    const sessionID = fixture.sessions[0].meta.id;
    const secrets = collectFixtureSecrets(fixture);
    if (secrets.length < 4) {
      fail(`expected several fixture secrets, found ${secrets.length}`);
    }
    const written = fixtureModule.writeFixtureDb(fixture);
    const dbPath = written.path;
    dbDirectory = written.directory;
    const before = statSync(dbPath);
    const beforeHash = sha256File(dbPath);

    const token = randomBytes(24).toString("hex");
    const stdoutChunks = [];
    const stderrChunks = [];
    server = spawn(
      process.execPath,
      [binPath, "--db", dbPath, "--host", "127.0.0.1", "--port", "0", `--token=${token}`],
      { cwd: consumerDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout.setEncoding("utf8");
    server.stderr.setEncoding("utf8");
    server.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    server.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    const port = await parseBind(stdoutChunks, Date.now() + 10_000, server);
    const base = `http://127.0.0.1:${port}`;
    console.log(`server: installed bin bound to 127.0.0.1:${port} (bind line parsed)`);

    const health = await fetch(`${base}/api/health`);
    const healthBody = await health.json();
    if (health.status !== 200 || healthBody.ok !== true || healthBody.readOnly !== true) {
      fail(`unauthenticated health was not a 200 read-only payload (${health.status})`);
    }
    if (healthBody.version !== repoVersion) {
      fail(`health version ${healthBody.version} != repo version ${repoVersion}`);
    }
    console.log(`health: 200 ok/readOnly true, version ${healthBody.version}`);

    // Static UI proof: the installed server must serve the shipped src/ui
    // assets, not a dist/ui copy (there is none).
    const repoIndexHtml = readFileSync(join(ROOT, "src", "ui", "index.html"), "utf8");
    const markerMatch = /<title>([^<]+)<\/title>/.exec(repoIndexHtml);
    if (!markerMatch) fail("could not extract a shell marker from src/ui/index.html");
    const marker = markerMatch[1].trim();
    const shell = await fetch(`${base}/`);
    const shellBody = await shell.text();
    const shellType = shell.headers.get("content-type") ?? "";
    if (shell.status !== 200 || !shellType.includes("text/html") || !shellBody.includes(marker)) {
      fail("installed server did not serve the UI shell with the expected marker");
    }
    const styles = await fetch(`${base}/ui/styles.css`);
    const stylesType = styles.headers.get("content-type") ?? "";
    if (styles.status !== 200 || !stylesType.includes("text/css")) {
      fail("installed server did not serve /ui/styles.css");
    }
    console.log("static ui: / 200 text/html with shell marker, /ui/styles.css 200 text/css");

    const headers = { Authorization: `Bearer ${token}` };
    const analysisResponse = await fetch(`${base}/api/sessions/${sessionID}/analysis`, {
      headers,
    });
    const analysisText = await analysisResponse.text();
    if (analysisResponse.status !== 200) {
      fail(`authenticated analysis returned ${analysisResponse.status} for ${sessionID}`);
    }
    const eventsResponse = await fetch(`${base}/api/sessions/${sessionID}/events?limit=200`, {
      headers,
    });
    const eventsText = await eventsResponse.text();
    if (eventsResponse.status !== 200) {
      fail(`authenticated events returned ${eventsResponse.status} for ${sessionID}`);
    }
    const leaked = secrets.filter(
      (secret) => analysisText.includes(secret) || eventsText.includes(secret),
    );
    if (leaked.length !== 0) {
      fail(`redaction failed: ${leaked.length} fixture secret value(s) appeared in responses`);
    }
    console.log(
      `redaction: ${secrets.length} fixture secret values absent from analysis + events ` +
        `(session ${sessionID})`,
    );

    const revealResponse = await fetch(
      `${base}/api/sessions/${sessionID}/events?reveal=1`,
      { headers },
    );
    const revealBody = await revealResponse.json();
    if (revealResponse.status !== 403 || revealBody.error !== "reveal_disabled") {
      fail(
        `reveal without --reveal expected 403 reveal_disabled, got ` +
          `${revealResponse.status} ${revealBody.error ?? "<no error>"}`,
      );
    }
    console.log("reveal: 403 reveal_disabled without --reveal");

    const after = statSync(dbPath);
    const afterHash = sha256File(dbPath);
    if (
      afterHash !== beforeHash ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      fail("fixture database changed during read-only requests");
    }
    console.log(`db: sha256/size/mtime unchanged (${before.size} bytes, read-only proof)`);

    console.log(`CONSUMER SMOKE OK (${repoVersion}, session ${sessionID})`);
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise((resolveExit) => server.once("exit", resolveExit)),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 3000)),
      ]);
      if (exited === undefined) server.kill("SIGKILL");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    rmSync(consumerDir, { recursive: true, force: true });
    if (dbDirectory) rmSync(dbDirectory, { recursive: true, force: true });
  }
}

assertSupportedNode();
main().catch((error) => {
  process.stderr.write(`CONSUMER SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
