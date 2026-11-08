import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearTokenFile,
  readTokenFile,
  removeTokenFile,
  tokenFilePath,
  writeTokenFile,
} from "../src/server/token-file.ts";

async function withTokenDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "observability-token-"));
  const previous = process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR;
  process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR = directory;
  try {
    await run(directory);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR;
    } else {
      process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("token files round-trip per port and remove only their own token", async () => {
  await withTokenDirectory(async () => {
    const path = await writeTokenFile(4517, "token-a");
    assert.equal(path, tokenFilePath(4517));

    const record = await readTokenFile(4517);
    assert.equal(record?.version, 1);
    assert.equal(record?.port, 4517);
    assert.equal(record?.token, "token-a");
    assert.ok(record?.createdAt);

    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      token: string;
    };
    assert.equal(parsed.token, "token-a");
    assert.equal(await readTokenFile(4518), null);

    await removeTokenFile(4517, "token-b");
    assert.equal((await readTokenFile(4517))?.token, "token-a");

    await removeTokenFile(4517, "token-a");
    assert.equal(await readTokenFile(4517), null);
    await assert.rejects(readFile(path, "utf8"));

    await writeTokenFile(4517, "token-c");
    await clearTokenFile(4517);
    assert.equal(await readTokenFile(4517), null);
  });
});

test("invalid token files are ignored", async () => {
  await withTokenDirectory(async () => {
    await writeFile(tokenFilePath(4519), "not json");
    assert.equal(await readTokenFile(4519), null);

    await writeFile(
      tokenFilePath(4519),
      JSON.stringify({ version: 1, port: 4518, token: "other-port" }),
    );
    assert.equal(await readTokenFile(4519), null);

    await writeFile(
      tokenFilePath(4519),
      JSON.stringify({ version: 1, port: 4519, token: "" }),
    );
    assert.equal(await readTokenFile(4519), null);
  });
});
