# Release process

How `opencode-session-observability` is versioned, packed, tested, released and — when
approved — published. The pipeline is `.github/workflows/release.yml`; the gates are
`npm run check`, `npm run release:gate`, `scripts/consumer-smoke.mjs` and
`scripts/host-smoke.mjs`.

Nothing in this document authorizes a release. See
[§11 Gated first-release execution checklist](#11-gated-first-release-execution-checklist).

The package is pre-1.0. There is no compatibility promise: pin the exact version you validated.

---

## 1. Distribution decision record

Two install modes ship today. Both are documented in `README.md`.

| Dimension | Local checkout (`"package": "<path-to-repo>"`) | Registry install (`plugins: ["opencode-session-observability"]`) |
| --- | --- | --- |
| **Update path** | `git pull` / `git checkout <ref>`, then restart the host. No rebuild when the committed bundles are used; `npm ci` only if the lockfile moved. | `npm install opencode-session-observability@<version>`, then restart the host. `npx` picks up `@latest` on the next run. Requires a published, immutable artifact. |
| **Version pinning** | By git ref or commit; the working tree can drift. Reproducibility is the user's discipline. | By exact semver in `package.json`/lockfile. Registry versions are immutable and, after trusted publishing is configured, carry provenance attestations. |
| **Host compatibility** | The exact shape the repository tests (`exports["."]` → `./src/plugin/index.ts`, TypeScript source). Works because the OpenCode 2 host is Bun-based and type-strips TS. | Identical package contents from a tarball, so host behaviour must be proven against the *installed* form. That is what the host-validation gate in §10 exists for. |
| **First-run cost** | `git clone` + `npm ci` (Vite, TypeScript, OpenTUI stack): minutes and a large `node_modules`, plus a Node toolchain even for read-only use. | `npm install --omit=dev` of a zero-runtime-dependency tarball: seconds, no build step, no toolchain beyond Node. `npx` needs nothing preinstalled but network access. |
| **Trust** | Trust = you read the code you run. No third-party supply chain beyond devDependencies. | Trust = registry immutability + maintainer identity + (after bootstrap) provenance, but the user runs a tarball. Mitigated by publishing the tested artifact with a recorded checksum and shipping no lifecycle scripts. |
| **Offline use** | Full: the checkout runs with no network once dependencies are installed. | The install needs the registry (or a Release tarball URL) once; afterwards the package runs offline. |

**Chosen strategy: npm publication**, with **GitHub Releases retained permanently** as the
artifact channel and the fallback. The registry mode is the only one that gives a
non-contributor a zero-clone, zero-toolchain, version-pinned install; the extra risk it
introduces (packaging surface, host load) is exactly what `pack:check`, `consumer-smoke.mjs`
and the host gate cover. If host validation ever fails, publication is blocked and compiling
the `exports["."]` entry becomes a follow-up issue — a broken package is never shipped.

### Phase 1 registry evidence (read-only, 2026-11-17)

Environment: Windows, Node `v24.18.0`, npm `11.16.0`. The registry was only read.

| Command | Result |
| --- | --- |
| `npm ping` | `PONG 448ms` — registry reachable (exit 0) |
| `npm view opencode-session-observability --json` | `E404 Not Found - GET https://registry.npmjs.org/opencode-session-observability` (exit 1) |
| `npm view opencode-session-observability versions dist-tags --json` | `E404`; no `versions`, no `dist-tags` payload (exit 1) |
| `npm owner ls opencode-session-observability` | `E404`; `Couldn't get owner data` (exit 1) |
| `npm whoami` | `ENEEDAUTH` — this machine is not logged in (exit 1) |
| `npm profile get` | `E401 Unauthorized` — 2FA/publish identity unreadable here (exit 1) |
| `GET https://www.npmjs.com/package/opencode-session-observability` | HTTP `403` to a non-browser fetch — inconclusive on its own |
| `GET https://registry.npmjs.org/opencode-session-observability` | HTTP `404`, body `{"error":"Not found"}` |
| `GET https://registry.npmjs.org/-/v1/search?text=opencode-session-observability&size=10` | HTTP `200`; zero exact-name matches among the 10 relevance-ranked hits |

**The rule.** `E404` on `npm view`, or an absent search result, means only *"no conflicting
published version found as of 2026-11-17"*. It is **not** proof that the name is available,
unclaimed or reserved for this repository. Only a successful publish or a post-publish
`npm owner ls` showing the maintainer account is conclusive. Name reservation, an
unpublish by a previous owner, an npm-side hold, and a name being taken between this check
and release day are all indistinguishable from this evidence — hence the re-verification in §2.

### Rename alignment (dependency #19) — re-verified, not redone

- `package.json` `repository.url` = `https://github.com/NicoGenti/opencode-session-observability.git`.
- Zero `opencode-statistics` matches in tracked files (`git grep -n opencode-statistics` → no matches).
- `README.md` badges, `README.md` plugin snippets and `cli.json.example` all use
  `opencode-session-observability`.

The npm badge in `README.md`, the npm package page and provenance metadata only go live
after the first successful publish. Until then the badge renders "not found" — that is
expected and is not a packaging defect.

---

## 2. First-version choice

No git tags exist as of 2026-11-17 (`git tag` and `git ls-remote --tags origin` both empty).
Do not treat that as a permanent fact: re-run the pinned checks on release day.

```bash
npm ping
npm view opencode-session-observability --json
npm view opencode-session-observability versions dist-tags --json
npm owner ls opencode-session-observability
npm whoami
npm profile get
```

Decision logic:

1. **No published versions under the exact name** (E404 on the package document, empty
   `versions`/`dist-tags`, no owner data) → the first release is **`0.1.0`** — which is what
   `package.json` and `const VERSION` in `src/server/index.ts` already say — tagged **`v0.1.0`**
   on branch **`release/v0.1.0`**.
2. **The name shows versions, owners, or any ambiguity** → **stop and escalate to the
   maintainer**. The maintainer chooses either a scoped name (e.g. `@nicogenti/opencode-session-observability`)
   or an unused version. Never bump silently, and never assume `0.1.0` is free because an
   earlier check was empty.

`npm whoami` / `npm profile get` failing is not a blocker for planning; it does block the
manual first publish, which needs an authenticated machine (see §5).

---

## 3. Release process

A release is a version bump, two rebuilt bundles, one packed tarball, a `release/vX.Y.Z`
branch and a `vX.Y.Z` tag. The **branch push** drives the workflow; the tag is the version
signature it verifies against. Pushing the tag starts nothing on its own.

**Naming.** The branch is `release/vX.Y.Z` and the tag is `vX.Y.Z`. The different prefixes
keep `refs/heads/...` and `refs/tags/...` unambiguous: a branch and a tag may both exist
without sharing a name, so neither can shadow the other.

1. **Start from an up-to-date `main`.**
   ```bash
   git checkout main && git pull --ff-only
   git checkout -b release/vX.Y.Z
   ```
2. **Bump both version literals together.** `package.json` `version` and
   `const VERSION = "<same>"` in `src/server/index.ts` (line 18). Then resync the lockfile root
   version, or `npm ci` will fail on the drift:
   ```bash
   npm install --package-lock-only
   ```
   (`npm version X.Y.Z --no-git-tag-version` is the one-command alternative: it rewrites
   `package.json` and `package-lock.json` together without committing or tagging.) The drift
   test `test/plugin-tui-entry.test.ts` fails if `package.json`, `src/server/index.ts` and
   `package-lock.json` disagree, and the `pack` job re-checks
   `node bin/opencode-observability.mjs --version` against `package.json`.
3. **Rebuild both bundles.**
   ```bash
   npm run build:tui && npm run build:server
   ```
   `dist-tui/tui.mjs` and `dist-server/server.mjs` are committed artifacts; `verify` re-runs
   both builds and fails on `git diff --exit-code`. Never release a tree whose bundles are stale.
4. **Run the local gate and commit on the release branch.**
   ```bash
   npm run release:gate
   git add package.json package-lock.json src/server/index.ts dist-tui/tui.mjs dist-server/server.mjs
   git commit -m "chore(release): vX.Y.Z"
   ```
5. **(Optional) dry-run the pipeline before tagging.** Dispatch `release.yml` on `main` (or any
   non-release ref) with `expected_version=X.Y.Z` (a leading `v` is tolerated). It runs
   `verify` → `pack` → `consumer` only: `github-release` and `npm-publish` require
   `github.event_name == 'push'`, so a dispatch never creates a Release or publishes.
   Dispatching on `release/vX.Y.Z` itself is possible only after step 7 has pushed the branch,
   and it queues behind the real run in the same concurrency group — it is not a pre-tag test.
6. **Tag the release commit** so the tag equals `v` + `package.json` version:
   ```bash
   git tag vX.Y.Z
   ```
7. **Push the tag first, then the branch — exactly once.** The order matters:
   ```bash
   git push origin vX.Y.Z          # triggers nothing: tags are no longer a trigger
   git push origin release/vX.Y.Z  # triggers the workflow
   ```
   `pack` fails closed unless the branch name matches `release/v<semver>`, that semver equals
   `package.json`, and the tag `v<version>` exists and points at the pushed commit. Any
   mismatch stops the run before packing. (`github.ref_type` is `branch` for both a branch
   push and a branch dispatch, which is why the publishing jobs also require `event_name ==
   'push'`.)
   **Push invariant:** re-pushing an unchanged release branch does not re-trigger the
   workflow. To retry a failed release, use **Re-run all jobs** on the failed run (it
   re-checks the same SHA, and by then the tag exists); never re-push expecting a new run.
8. **Watch the workflow to green before approving anything**: `verify` (Node 22 + 24) → `pack`
   → `consumer` (Node 22 + 24) → `github-release` and `npm-publish`. Both publishing jobs also
   hard-fail on an explicit early step unless the ref is a `release/vX.Y.Z` branch (and never
   on `main`), as defense in depth.
9. **Approve the `npm` environment deployment** when `npm-publish` waits on it (skip on the
   gated first release — see §5 and §11).

---

## 4. Artifact-reuse policy

The tarball that is published is the tarball that was tested. Byte for byte.

- `pack` is the only job that packs: it runs `npm pack` once, writes
  `opencode-session-observability-<version>.tgz` plus a `.sha256`, uploads the
  `package-tarball` artifact, and exposes `filename` / `sha256` as job outputs.
- `consumer`, `github-release` and `npm-publish` download that artifact and re-verify with
  `sha256sum -c` and against the `pack` output before use. Nothing rebuilds, repacks or renames it.
- Publish with **`npm publish <tarball>`**. Publishing a tarball runs no lifecycle scripts, so
  `prepublishOnly` cannot rebuild anything: the tested bytes ship.
- **Never run `npm publish` from the repository directory on release day.** That packs an
  untested working tree and bypasses the checksum chain.

Local equivalent:

```bash
npm run release:gate
npm pack
node scripts/consumer-smoke.mjs --tarball ./opencode-session-observability-<version>.tgz
```

---

## 5. Trusted-publishing bootstrap (chicken-and-egg)

The `npm-publish` job authenticates with **OIDC trusted publishing only**: `id-token: write`
plus the `environment: npm` approval gate. There is no `NPM_TOKEN` and no registry credential
in this repository, by design. Never commit a token.

npm only accepts a trusted-publisher registration for a package that already exists. So:

1. **The first publish is manual.** A maintainer, on a machine with maintainer access and npm
   2FA enabled, publishes the tested tarball with an OTP from the workflow run:
   `npm publish <tarball>`. This publish **cannot carry provenance** — provenance is minted
   from a CI OIDC identity, not from a laptop.
2. **Immediately after that publish**, register the trusted publisher on npmjs.com:
   **package → Settings → Trusted publishing**, with repository
   `NicoGenti/opencode-session-observability`, workflow `release.yml`, environment `npm`.
   Also create the `npm` environment with a required reviewer under
   **Settings → Environments** — a workflow cannot create it, and without it the publish job
   would run unattended.
3. **Every later publish is OIDC-only** and gets provenance automatically.

Until step 2 happens, `npm-publish` fails closed at the publish step. That failure is the
intended state, not a bug. npm 2FA is required on the maintainer account.

---

## 6. Prereleases and version policy

```bash
npm publish <tarball> --tag beta      # prerelease; does not move the `latest` dist-tag
npm view opencode-session-observability dist-tags
```

- Publish the prerelease from a branch like `release/v0.2.0-beta.1` with tag `v0.2.0-beta.1` on
  its HEAD, pushed in the §3 order (tag first, then branch); the same workflow enforcement and
  checksum chain apply. Mark the GitHub Release as a pre-release so it is not offered as the
  stable download.
- Pre-1.0 semver policy (`0.x`): **minor = features, patch = fixes**, and a breaking change
  bumps **minor**. `0.x` releases may break compatibility — say so in the release notes and
  ask users to pin the exact version they validated.

---

## 7. Rollback, deprecation and re-release

A published version is immutable. Do not try to fix it in place.

| Situation | Action |
| --- | --- |
| Bad version published, a fixed one is possible | Deprecate the range, then ship a patch: `npm deprecate opencode-session-observability@"0.1.0" "Broken in <what>; use 0.1.1"` and release `0.1.1`. Prefer this. |
| Version published minutes ago, nothing depends on it | `npm unpublish opencode-session-observability@<version>` — only within npm's 72-hour window and only with **zero dependents**. npm policy rejects the rest. |
| Whole package must go | Do not unpublish the package to "start over". Deprecate the versions and publish corrected ones. |
| Bad tag or release branch (`v0.1.0` / `release/v0.1.0` points at the wrong commit) | Fix on `main`, bump the version, then tag and open a fresh `release/vX.Y.Z` branch. **Never re-tag or move a published tag, and never force-push a released branch.** If nothing left the workflow, delete the unreleased tag and branch deliberately and redo once — never after a Release or a publish exists. |

Deprecation is visible on the package page and in `npm install` output, and it does not break
existing installs. That is why it is the default.

---

## 8. Maintainer release steps

1. Re-run the §2 registry checks and record the first-version decision.
2. `git checkout main && git pull --ff-only`, then `git checkout -b release/vX.Y.Z`.
3. Bump `package.json` and `src/server/index.ts` `const VERSION` together, then resync the
   lockfile root version with `npm install --package-lock-only`.
4. `npm run build:tui && npm run build:server`.
5. `npm run check`, `npm run lint:package`, `npm run release:gate`, `npm run audit:prod`.
6. `npm pack`; run `node scripts/consumer-smoke.mjs --tarball <tgz>` and
   `node scripts/host-smoke.mjs --tarball <tgz>` (plus the §10 manual checklist).
7. Commit everything in one go, tag `vX.Y.Z`, then push the tag **first** and the release
   branch **second**:
   ```bash
   git add package.json package-lock.json src/server/index.ts dist-tui/tui.mjs dist-server/server.mjs
   git commit -m "chore(release): vX.Y.Z"
   git tag vX.Y.Z
   git push origin vX.Y.Z          # triggers nothing
   git push origin release/vX.Y.Z  # triggers release.yml, exactly once
   ```
8. Watch `release.yml` to green: `verify` → `pack` → `consumer`.
9. Verify the GitHub Release assets: the tarball **and** its `.sha256`, matching the `pack` job
   output.
10. First release only: perform the manual publish (§5) and then configure the trusted
    publisher. Later releases: approve the `environment: npm` deployment.
11. `npm view opencode-session-observability version dist-tags` and confirm provenance on the
    package page.
12. Post-publish smoke test: `npx -y opencode-session-observability@<version> --version`.

---

## 9. GitHub-only fallback

If npm publication is deferred or blocked, the `github-release` job is the whole release path.
It needs only `contents: write`, and it already attaches the tested tarball and its checksum.

- Install without the registry:
  ```bash
  npm install <release-asset-tarball-url>
  ```
  or download the `.tgz` from the Release, verify it against the published `.sha256`, and
  install that file. `npx` will not find the package on this path — run the installed bin
  (`opencode-observability --version`) or `node node_modules/opencode-session-observability/bin/opencode-observability.mjs`.
- Nothing else changes: no npm metadata, no dist-tags, no version semantics.
- Leaving the `npm-publish` job unapproved is a supported steady state. Removing the job (or
  keeping it permanently gated) changes no artifact and no documentation other than §5.
- Re-verify the name with the §2 commands before any later attempt to switch to npm: an
  unused name today is not a reservation.

---

## 10. Native host validation gate

Required **before any publish**. The host gate is the empirical answer to the
`exports["."]`-ships-TypeScript question: the packed package must load in a real OpenCode 2
host, not just in Node.

Scripted half:

```bash
node scripts/host-smoke.mjs --tarball <tgz>
```

Exit codes: **0 = PASS** (the packed artifact loads and answers in a real host);
**2 = MANUAL-REQUIRED** (no drivable OpenCode 2 host here — the manual checklist below is then
mandatory); **1 = FAIL** — publication is blocked.

Manual checklist (authoritative; executed by a maintainer, results recorded in the release notes):

```text
Native host validation (executed by a maintainer, results recorded in the
release notes; `node scripts/host-smoke.mjs --tarball <tgz>` is the scripted
best-effort half of this gate):

1. Install the real tarball into a scratch prefix (never a repo checkout):
     npm install --prefix <scratch> ./opencode-session-observability-<version>.tgz --omit=dev
2. Point the OpenCode config at that installed package path:
     { "plugins": [ { "package": "<scratch>/node_modules/opencode-session-observability",
                      "options": { "autoStart": false } } ] }
3. Restart the host (or POST /api/location/reload) so the plugin loads fresh.
4. In the TUI: `/statistics`, `/trajectory` and `/observability` open the
   native panels, and the `prompt.footer.status` badge shows cost and cache
   hit rate (`n/a` when the local UI is offline).
5. Auto-start spawns `dist-server/server.mjs` — the bundled entry from
   `src/plugin/tui-warmup.ts` `BUNDLED_ENTRY_SEGMENTS = ["dist-server", "server.mjs"]`.
6. Token-file auth works: `npm start` writes the per-port token file, the TUI
   reads it, and a missing/wrong token produces the documented hint instead
   of opening an unauthenticated page.
7. No "failed to load plugin" message or toast for
   `opencode-session-observability`.
8. Record the host version(s) tested: 2.3.0 in use locally; the repo pins
   `@opencode/*` 2.2.7.
```

Result on record: **2026-11-17, `0.1.0` tarball — 13/13 automated checks PASS** against
OpenCode **2.3.0**: the host resolved `exports["."]` (`src/plugin/index.ts`), the plugin state
was `active`, and RPC `session-observability.health` answered `ok:true` with `readOnly:true`.
This machine's host is 2.3.0 while the repository pins `@opencode/*` 2.2.7; record both in the
release notes. Any later failure here blocks publication and turns the `.` entry into a
follow-up compile issue.

---

## 11. Gated first-release execution checklist

> **GATED:** requires separate explicit maintainer approval — creating tags, GitHub Releases or publishing is NOT authorized by the planning/implementation work; this issue does not publish a package, create a tag or trigger a release.

Do not start this list from a planning, implementation or review session. Every step is an
explicit maintainer action.

1. All release checks green: `npm run check`, `npm run lint:package`, `npm run release:gate`,
   `npm run audit:prod`, `scripts/consumer-smoke.mjs` on Node 22 and 24, and
   `scripts/host-smoke.mjs` (or the §10 checklist) — plus the §2 registry re-check.
2. Record the host-validation record (host version, automated 13/13 result, manual checklist
   outcome) so it can go into the release notes.
3. Maintainer explicitly approves the release (version, `release/vX.Y.Z` branch, tag `vX.Y.Z`,
   publish target).
4. **First publish:** manual, authenticated publish of the tested tarball with an OTP from a
   machine with maintainer access — `npm publish <tarball>` (no provenance). If a trusted
   publisher already exists for this package, the equivalent first action is the first
   `release.yml` run with the `environment: npm` deployment approved instead.
5. Verify: `npm view opencode-session-observability version dist-tags`,
   `npm owner ls opencode-session-observability`, the GitHub Release assets (tarball +
   `.sha256`), and `npx -y opencode-session-observability@<version> --version`.
6. Configure trusted publishing on npmjs.com (repository
   `NicoGenti/opencode-session-observability`, workflow `release.yml`, environment `npm`) and
   the `npm` environment's required reviewer, so later releases are OIDC-only with provenance.
7. Close out: record the published version, checksum, host version and date in the release
   notes and the issue.

---

## A. Field notes — the v0.1.0 first release (2026-11-19)

The worked example for §5 and §11, not a new procedure.

- `v0.1.0` pushed **first** and triggered nothing (expected — §3 step 7), then
  `release/v0.1.0` pushed and started `release.yml` (run #1).
- Run #1: `verify` (Node 22 + 24) → `pack` → `consumer` (Node 22 + 24), all green.
- `github-release` created the Release `v0.1.0` automatically with the tested tarball and its
  `.sha256`.
- `npm-publish` failed closed within seconds because the `npm` environment and the trusted
  publisher did not exist yet. That is the designed first-release outcome (§5), not a defect.
- The maintainer published manually from the **downloaded Release tarball**:
  `npm publish <release-asset>.tgz --access public` — no provenance, since provenance needs a
  CI OIDC identity.
- `latest` became `0.1.0` about two minutes later, after registry replication.

Three things to carry into the next release:

1. **Publish the Release asset, never a local `npm pack` output.** Identical sources still
   hash differently — gzip records an mtime — so a local pack breaks the "tested bytes are the
   published bytes" chain (§4).
2. **Close the bootstrap after the first manual publish**: create the `npm` environment with a
   required reviewer (**Settings → Environments**), then register trusted publishing on
   npmjs.com (**Settings → Trusted publishing**: repository
   `NicoGenti/opencode-session-observability`, workflow `release.yml`, environment `npm`).
   Later releases are then OIDC-only with provenance.
3. **Treat an empty `npm view` right after publishing as lag, not failure.** Check the package
   page, or re-run `npm view` after a couple of minutes.

- 2026-11-24 (v0.2.0): `npm publish "release/<file>.tgz"` made npm parse the bare relative
  path as a hosted-git shorthand (`release/<file>.tgz` -> `ssh://git@github.com/release/...`),
  dying at `git ls-remote` (publickey) before any OIDC exchange; npm's spec parser never
  consults the disk. Prefix the tarball argument with `./`. The 0.2.0 publish completed
  manually from the Release tarball; the `./` fix ships on `main` for the next release.
