# Release gate

## Overview

The release gate proves that `npm pack` ships a working, lint-clean, consumer-installable package. GitHub Actions chains three jobs by dependency: `check` → `package` (needs: check) → `consumer` (needs: package). Locally, `npm run release:gate` runs the single-command subset: `check`, `build:tui`, `build:server`, `lint:package`, `pack:check`. Packing and the consumer smoke are explicit follow-up steps (below).

## Local runbook

Run in order from the repo root:

1. `npm run check` — typecheck (`tsc --noEmit`), the TUI sidecar typecheck (`tsconfig.tui.json`), and the `node:test` suite.
2. `npm run build:tui && git diff --exit-code -- dist-tui/tui.mjs` — the committed TUI bundle must be fresh; any diff fails the gate.
3. `npm run lint:package` — `publint`, pinned exactly at `0.3.25`. Errors fail the gate; there is no fallback or ignore list.
4. `npm run pack:check` — `npm pack --dry-run --json` asserted by `scripts/check-pack.mjs`: 23 required paths must be present (`bin`, `src`, `dist`, `dist-tui/tui.mjs`, docs, examples, `package.json`, `README.md`, `LICENSE`) and forbidden entries must be absent (`test/`, `.github/`, `.npmrc`, `tsconfig*`, `DESIGN.md`, `CONTRIBUTING.md`, lockfiles, `node_modules/`, `*.db*`, `.env*`, `*.log`, design/audit docs, `.git`/`.gitignore`, extra `dist-tui/` files). `--selftest` proves the negative path.
5. `npm pack` — produces the real tarball at the repo root. `prepack` runs `build:server` automatically, so `dist/` is always emitted.
6. `node scripts/consumer-smoke.mjs --tarball opencode-session-observability-*.tgz` — installs the tarball into an isolated temp consumer (never the repo `node_modules`) and asserts: zero runtime dependencies, installed `--help` and `--version`, `/api/health` returns `ok`/`readOnly` with the package version, default responses never contain the fixture secrets, `?reveal=1` without `--reveal` returns `reveal_disabled`, and the fixture DB hash/size/mtime are unchanged.
7. `npm run audit:prod` — production dependency audit must report zero high-severity advisories.

## CI jobs

- `package` (`needs: check`, ubuntu, Node 24): `npm ci`, `build:tui` + freshness diff, `build:server`, `audit:prod`, `pack:check`, `lint:package`, `npm pack`, then `actions/upload-artifact@v4` uploads the tarball as `package-tarball` for 30 days.
- `consumer` (`needs: package`, ubuntu): matrix `node-version: ['22.x', '24.x']` with `fail-fast: false`; downloads `package-tarball` into `tarball/` and runs the smoke script against the downloaded tarball. It deliberately runs **no `npm ci`** — isolation from the repo's devDependencies is the point.

## Why the package ships compiled JS

Node refuses to type-strip TypeScript files that resolve inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Type stripping is on by default since Node 22.18, but the `node_modules` refusal applies on every current stable line and there is no consumer-side flag for non-private packages. A bin or export pointing at `src/*.ts` therefore cannot run when installed from npm.

The package therefore ships compiled JavaScript:

- `tsconfig.build.json` emits `dist/server`, `dist/core` and `dist/plugin` from the `.ts`-extension sources with `rewriteRelativeImportExtensions: true`.
- `bin/opencode-observability.mjs` imports `../dist/server/index.js`; the `./core` and `./rpc` exports default to the emitted `.js`.
- `prepack` runs `build:server`, so `npm pack` can never ship a stale or missing `dist/`.
- No runtime flags are needed on Node >= 22.18.

## Export contracts

- `.` is the OpenCode **host** entry: it stays a string pointing at the raw TypeScript source (`./src/plugin/index.ts`) because the host transpiles plugins itself. It is host-only, not a standalone import target.
- `./tui` is the prebuilt `dist-tui/tui.mjs` bundle, typed by `src/plugin/tui.ts`. Standalone consumers must install the optional peers `@opentui/core`, `@opentui/solid` and `solid-js` explicitly; the OpenCode host supplies them in-process.
- `./core` and `./rpc` are standalone-safe: a compiled JS `default` plus TypeScript `types`. They stay read-only, and the in-memory adapters are the only data source that needs no external service.

## Manual OpenCode host TUI checklist (not in CI)

The host integration is user-owned and cannot be exercised in CI. As a release sign-off step:

1. Register the plugin in the global `cli.json`: `"plugins": ["opencode-session-observability"]`.
2. Restart the host: `opencode serve --service`.
3. Verify the TUI registers the `/statistics`, `/trajectory` and `/observability` slash commands and the session status badge.
4. Confirm the OpenCode log contains no new `failed to load plugin` lines.

## Artifact lifecycle

The `package` job uploads the exact tarball the gate tested as `package-tarball`, retained for 30 days. The 154-file total is a point-in-time baseline for the current file set; `scripts/check-pack.mjs` pins the required-present allowlist, so required files cannot drift silently.
