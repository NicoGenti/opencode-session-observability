import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  discoverDatabase,
} from "../src/core/adapters/paths.ts";
import { ObservabilityService } from "../src/core/service.ts";
import { simpleFixture, subagentFixture, writeFixtureDb } from "./fixtures/build.ts";

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
  assert.ok(paths.some((path) => path.endsWith("C:\\explicit\\opencode.db")));
  assert.ok(paths.some((path) => path.endsWith("C:\\xdg\\opencode\\opencode.db")));
  assert.ok(paths.some((path) => path.endsWith("C:\\Users\\test\\.opencode2\\data\\opencode\\opencode.db")));
  assert.ok(paths.some((path) => path.endsWith("C:\\Users\\test\\.local\\share\\opencode\\opencode.db")));
});
