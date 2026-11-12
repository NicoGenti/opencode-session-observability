#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Prefer the prebuilt, node-runnable ESM server (shipped as `dist-server/`), so
// the package works from `node_modules/` where Node refuses to type-strip `.ts`.
// The dev worktree has no bundle and keeps running the TypeScript source
// directly, which is allowed outside `node_modules/`.
const binDirectory = dirname(fileURLToPath(import.meta.url));
const bundledEntry = join(binDirectory, "..", "dist-server", "server.mjs");
const sourceEntry = join(binDirectory, "..", "src", "server", "index.ts");

const entry = existsSync(bundledEntry) ? bundledEntry : sourceEntry;
await import(pathToFileURL(entry).href);
