import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  SqliteSource,
  UnsupportedSchemaError,
  detectSchema,
  openSqliteSource,
} from "../src/core/adapters/sqlite.ts";
import {
  DatabaseDiscoveryError,
  candidateDatabasePaths,
  candidateKey,
  discoverDatabase,
  listDatabaseCandidates,
} from "../src/core/adapters/paths.ts";
import { ObservabilityService } from "../src/core/service.ts";
import { simpleFixture, subagentFixture, writeFixtureDb } from "./fixtures/build.ts";

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeV1Db(): string {
  const directory = mkdtempSync(join(tmpdir(), "opencode-v1-"));
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec("create table session (id text primary key); create table message (id text primary key);");
  db.close();
  return path;
}

function writeUnknownDb(): string {
  const directory = mkdtempSync(join(tmpdir(), "opencode-unknown-"));
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec("create table unrelated (id text primary key);");
  db.close();
  return path;
}

test("reads sessions and messages from the OpenCode 2 SQLite shape", async () => {
  const fixture = simpleFixture();
  const { path } = writeFixtureDb(fixture);
  const source = openSqliteSource(path);
  try {
    const sessions = await source.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.id, "ses_simple");
    assert.equal(sessions[0]!.tokens?.cacheRead, 50);

    const session = await source.getSession("ses_simple");
    assert.equal(session?.title, "Session ses_simple");
    assert.equal(session?.model?.providerID, "test-provider");
    assert.equal(session?.time.idle, 1_700_000_000_700);

    const messages = await source.listMessages("ses_simple");
    assert.equal(messages.length, 3);
    assert.deepEqual(
      messages.map((message) => message.type),
      ["user", "assistant", "idle"],
    );
    assert.equal(messages[1]!.seq, 2);

    const bounds = await source.messageBounds("ses_simple");
    assert.deepEqual(bounds, { minSeq: 1, maxSeq: 3, count: 3 });

    const family = await source.getFamily("ses_simple");
    assert.equal(family.rootID, "ses_simple");
    assert.equal(family.parent, null);
    assert.equal(family.children.length, 0);
  } finally {
    source.close();
  }
});

test("returns the immediate parent and direct children", async () => {
  const fixture = subagentFixture();
  const { path } = writeFixtureDb(fixture);
  const source = new SqliteSource(path);
  try {
    const family = await source.getFamily("ses_child");
    assert.equal(family.rootID, "ses_parent");
    assert.equal(family.parent?.id, "ses_parent");
    const parentFamily = await source.getFamily("ses_parent");
    assert.equal(parentFamily.children.length, 1);
    assert.equal(parentFamily.children[0]!.id, "ses_child");
  } finally {
    source.close();
  }
});

test("opens read-only and never changes the database file", async () => {
  const { path } = writeFixtureDb(simpleFixture());
  const before = hash(path);
  const source = openSqliteSource(path);
  const service = new ObservabilityService(source);
  await service.analyze("ses_simple");
  await service.events({ sessionID: "ses_simple" });
  source.close();
  const after = hash(path);
  assert.equal(after, before, "read-only analysis must not modify the database");
});

test("a read-only SQLite connection rejects writes", () => {
  const { path } = writeFixtureDb(simpleFixture());
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.throws(() => db.exec("create table forbidden (x integer)"));
  } finally {
    db.close();
  }
});

test("detects and rejects an OpenCode 1 schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-v1-"));
  const path = join(directory, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec("create table session (id text primary key); create table message (id text primary key);");
  db.close();
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(detectSchema(check), "v1");
  check.close();
  assert.throws(() => new SqliteSource(path), UnsupportedSchemaError);
});

test("discovers an explicit database path and rejects an unknown schema", () => {
  const { path } = writeFixtureDb(simpleFixture());
  const found = discoverDatabase({ explicitPath: path });
  assert.equal(found.path, path);
  assert.equal(found.schema, "v2");

  const directory = mkdtempSync(join(tmpdir(), "opencode-unknown-"));
  const unknown = join(directory, "opencode.db");
  const db = new DatabaseSync(unknown);
  db.exec("create table unrelated (id text primary key);");
  db.close();
  assert.throws(() => discoverDatabase({ explicitPath: unknown }), UnsupportedSchemaError);
  assert.throws(
    () => discoverDatabase({ explicitPath: join(directory, "missing.db") }),
    DatabaseDiscoveryError,
  );
});

test("discovery prefers the isolated OpenCode 2 profile over legacy locations", () => {
  const source = writeFixtureDb(simpleFixture()).path;
  const home = mkdtempSync(join(tmpdir(), "opencode-home-"));
  const isolated = join(home, ".opencode2", "data", "opencode");
  const legacy = join(home, ".local", "share", "opencode");
  mkdirSync(isolated, { recursive: true });
  mkdirSync(legacy, { recursive: true });
  copyFileSync(source, join(isolated, "opencode.db"));
  copyFileSync(source, join(legacy, "opencode.db"));
  const found = discoverDatabase({
    env: {},
    platform: "linux",
    home,
  });
  assert.equal(found.path, join(isolated, "opencode.db"));
});

test("candidate paths include XDG and the isolated OpenCode 2 profile", () => {
  const paths = candidateDatabasePaths({
    env: { XDG_DATA_HOME: "C:/xdg", OPENCODE_DB: "C:/explicit/opencode.db" },
    platform: "win32",
    home: "C:/Users/test",
  });
  assert.ok(paths.some((path) => /[\\/]explicit[\\/]opencode\.db$/i.test(path)));
  assert.ok(paths.some((path) => /[\\/]xdg[\\/]opencode[\\/]opencode\.db$/i.test(path)));
  assert.ok(paths.some((path) => /[\\/]\.opencode2[\\/]data[\\/]opencode[\\/]opencode\.db$/i.test(path)));
  assert.ok(paths.some((path) => /[\\/]\.local[\\/]share[\\/]opencode[\\/]opencode\.db$/i.test(path)));
});

test("lists every candidate with its schema, existence and mtime", () => {
  const v2 = writeFixtureDb(simpleFixture()).path;
  const v1 = writeV1Db();
  const xdg = mkdtempSync(join(tmpdir(), "opencode-xdg-"));
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  copyFileSync(writeUnknownDb(), join(xdg, "opencode", "opencode.db"));
  const home = mkdtempSync(join(tmpdir(), "opencode-home-"));

  const candidates = listDatabaseCandidates({
    env: {
      OPENCODE_OBSERVABILITY_DB: v2,
      OPENCODE_DB: v1,
      XDG_DATA_HOME: xdg,
    },
    platform: "linux",
    home,
  });

  assert.equal(candidates[0]!.path, v2);
  assert.equal(candidates[0]!.exists, true);
  assert.equal(candidates[0]!.schema, "v2");
  assert.equal(typeof candidates[0]!.mtimeMs, "number");

  assert.equal(candidates[1]!.path, v1);
  assert.equal(candidates[1]!.exists, true);
  assert.equal(candidates[1]!.schema, "v1");

  const unknown = candidates.find(
    (candidate) => candidate.path === join(xdg, "opencode", "opencode.db"),
  );
  assert.equal(unknown?.exists, true);
  assert.equal(unknown?.schema, "unknown");

  const missing = candidates.filter((candidate) => !candidate.exists);
  assert.ok(missing.length > 0, "home profiles without a database are reported");
  for (const candidate of missing) {
    assert.equal(candidate.schema, "unknown");
    assert.equal(candidate.mtimeMs, undefined);
    assert.equal(candidate.error, undefined);
  }
});

test("collapses case-insensitive duplicate candidates and leaves inputs unchanged", () => {
  const v2 = writeFixtureDb(simpleFixture()).path;
  const home = mkdtempSync(join(tmpdir(), "opencode-home-"));
  const env = { OPENCODE_OBSERVABILITY_DB: v2, OPENCODE_DB: v2.toUpperCase() };
  const before = { ...env };

  const candidates = listDatabaseCandidates({ env, platform: "linux", home });

  const matching = candidates.filter(
    (candidate) => candidate.path.toLowerCase() === v2.toLowerCase(),
  );
  assert.equal(matching.length, 1, "case variants collapse to one candidate");
  assert.equal(matching[0]!.schema, "v2");
  assert.deepEqual(env, before, "candidate discovery must not mutate its inputs");
});

test("candidateKey is deterministic across equivalent representations", () => {
  const path = join(tmpdir(), "opencode-keys", "opencode.db");

  assert.match(candidateKey(path), /^[0-9a-f]{12}$/);
  assert.equal(candidateKey(path), candidateKey(path));
  // Case folds only on Windows; POSIX keeps distinct spellings distinct.
  assert.equal(candidateKey(path, "win32"), candidateKey(path.toUpperCase(), "win32"));
  assert.notEqual(candidateKey(path, "linux"), candidateKey(path.toUpperCase(), "linux"));

  const dotted = `${dirname(path)}${sep}nested${sep}..${sep}${basename(path)}`;
  assert.equal(candidateKey(dotted), candidateKey(path));

  const repeated = `${dirname(path)}${sep}${sep}${basename(path)}`;
  assert.equal(candidateKey(repeated), candidateKey(path));

  assert.notEqual(
    candidateKey(path),
    candidateKey(join(dirname(path), "other.db")),
  );
});

test("lists candidates without opening missing files or modifying existing ones", () => {
  const { path: v2 } = writeFixtureDb(simpleFixture());
  const before = hash(v2);
  const home = mkdtempSync(join(tmpdir(), "opencode-home-"));
  const absent = join(home, ".opencode2", "data", "opencode", "opencode.db");

  const candidates = listDatabaseCandidates({
    env: { OPENCODE_DB: v2 },
    platform: "linux",
    home,
  });

  assert.equal(hash(v2), before, "listing candidates must not modify the database");
  const missing = candidates.find((candidate) => candidate.path === absent);
  assert.equal(missing?.exists, false);
  assert.equal(existsSync(absent), false, "a missing candidate is never created or opened");
  // inspectDatabase opens existing candidates with `readOnly: true` and closes
  // the handle inside a `finally` block, so discovery cannot write or leak a
  // connection (see src/core/adapters/paths.ts).
});
