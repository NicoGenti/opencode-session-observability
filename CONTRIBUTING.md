# Contributing

Thanks for taking a look. This project is a local-first, read-only observability layer for OpenCode 2 sessions; contributions that keep it read-only and dependency-light are welcome.

## Prerequisites

- **Node.js** `>=22.18` (`engines`); **24.x** is recommended and is what CI runs. The app uses the built-in `node:sqlite`, so no native module is compiled.
- **TypeScript 5.9** in strict mode, ESM, **no build step**: the sources run directly and `tsc` is used only for `--noEmit` typechecking.
- An OpenCode 2 session database is only needed to run the app against real data; the test suite builds its own fixtures.

## Setup

```bash
npm ci
```

Use `npm ci` rather than `npm install`: `package-lock.json` is committed and the lockfile is what CI installs.

## Commands

```bash
npm run check        # typecheck + typecheck:tui + full test suite — the standard gate
npm run typecheck    # tsc --noEmit only
npm run typecheck:tui # tsc --noEmit -p tsconfig.tui.json (Solid JSX sidecar)
npm test             # node:test, 34 files, 306 tests
npm run build:tui    # rebuild dist-tui/tui.mjs; CI verifies the artifact is fresh
npm run audit:prod   # production dependency audit
npm run serve        # start the local UI (alias of npm start)
```

`npm run check` must be green before you open a pull request. The suite is at 306 tests across 34 files and grows with each new suite.

After any change under `src/plugin/tui.*`, rebuild the committed bundle and prove it is fresh:

```bash
npm run build:tui
git diff --exit-code -- dist-tui/tui.mjs
```

## Architecture pointers

- `src/core/` — pure domain logic: normalization, projection, metrics, diagnostics, export, redaction, paging. No I/O.
- `src/core/adapters/` — read-only storage: OpenCode 2 SQLite, the OpenCode server API, and in-memory fixtures. The SQLite adapter opens with `SQLITE_OPEN_READONLY` and sets `PRAGMA query_only = ON`.
- `src/server/` — local HTTP API, authentication, token files, static UI hosting.
- `src/ui/` — vanilla ES modules and CSS; no framework and no bundler.
- `src/plugin/` — OpenCode 2 server plugin (read-only RPC) and TUI commands.
- `test/` — `node:test` suites plus synthetic fixtures in `test/fixtures/build.ts`.

Deeper context lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [DESIGN.md](DESIGN.md).

## Branching and commits

- One issue = one git worktree, branched off `main`, so the main checkout stays clean.
- Use conventional commit prefixes: `feat(core|server|ui|plugin): ...`, `fix(scope): ...`, `docs: ...`, `ci: ...`.
- One logical change per commit; keep refactors and behavior changes in separate commits.
- Rebase or merge `main` as the maintainer prefers; do not rewrite published history.

## Pull requests

- `npm run check` green locally.
- Tests added or updated for any behavior change.
- No secrets, no machine-specific absolute paths, no personal data in code, docs or fixtures.
- Screenshots for UI changes (dark and light when the change is visual).
- CI runs the same gate on Node 24.x and must be green.

## Read-only principles

- Never write sessions, messages or configuration. The session database is opened read-only and only session data is read — never `auth.json`, `service.json` or provider credentials.
- No telemetry and no network calls to third parties. The server binds loopback by default.
- Redaction stays on by default; reveal is opt-in and explicit.
- Keep the dependency surface small; prefer the standard library and the existing helpers.

## Reporting bugs and requesting features

Use the issue templates in `.github/ISSUE_TEMPLATE/`. Please redact tokens and payloads before pasting logs or trajectory excerpts.
