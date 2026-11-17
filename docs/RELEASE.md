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
   `package.json` and `const VERSION` in `src/server/index.ts` already say — tagged **`v0.1.0`**.
2. **The name shows versions, owners, or any ambiguity** → **stop and escalate to the
   maintainer**. The maintainer chooses either a scoped name (e.g. `@nicogenti/opencode-session-observability`)
   or an unused version. Never bump silently, and never assume `0.1.0` is free because an
   earlier check was empty.

`npm whoami` / `npm profile get` failing is not a blocker for planning; it does block the
manual first publish, which needs an authenticated machine (see §5).

---

## 3. Release process

A release is a version bump, two rebuilt bundles, one packed tarball, and a tag that drives
the workflow.

1. **Bump both version literals together.** `package.json` `version` and
   `const VERSION = "<same>"` in `src/server/index.ts` (line 18). The drift test
   `test/plugin-tui-entry.test.ts` → *"the CLI version literal stays in sync with the package
   version"* fails if they disagree, and the `pack` job re-checks `node bin/opencode-observability.mjs --version`
   against `package.json`.
2. **Rebuild both bundles and commit them.**
   ```bash
   npm run build:tui && npm run build:server
   ```
   `dist-tui/tui.mjs` and `dist-server/server.mjs` are committed artifacts; `verify` re-runs
   both builds and fails on `git diff --exit-code`. Never release a tree whose bundles are stale.
3. **Tag `vX.Y.Z`** so the tag equals `v` + `package.json` version. The `pack` job refuses any
   other pairing (`git describe --exact-match --tags HEAD` must equal `v<version>`).
4. **Push the tag**: `git push origin vX.Y.Z`. That is the only trigger that can release or
   publish; `workflow_dispatch` is a dry run (the release and publish jobs are
   `if: github.ref_type == 'tag'`).
5. **Watch the workflow to green before approving anything**: `verify` (Node 22 + 24) → `pack`
   → `consumer` (Node 22 + 24) → `github-release` and `npm-publish`.

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

- Publish the prerelease from a tag like `v0.2.0-beta.1`; the same workflow and checksum chain
  apply. Mark the GitHub Release as a pre-release so it is not offered as the stable download.
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
| Bad tag (`v0.1.0` points at the wrong commit) | Fix on `main`, bump the version, tag the new version. **Never re-tag or move a published tag.** If the tag is unreleased and no artifact left the workflow, delete it deliberately and retag once — never after a Release or a publish exists. |

Deprecation is visible on the package page and in `npm install` output, and it does not break
existing installs. That is why it is the default.

---

## 8. Maintainer release steps

1. Re-run the §2 registry checks and record the first-version decision.
2. Bump `package.json` and `src/server/index.ts` `const VERSION` together.
3. `npm run build:tui && npm run build:server`; commit both bundles.
4. `npm run check`, `npm run lint:package`, `npm run release:gate`, `npm run audit:prod`.
5. `npm pack`; run `node scripts/consumer-smoke.mjs --tarball <tgz>` and
   `node scripts/host-smoke.mjs --tarball <tgz>` (plus the §10 manual checklist).
6. Commit, tag `vX.Y.Z`, push the tag.
7. Watch `release.yml` to green: `verify` → `pack` → `consumer`.
8. Verify the GitHub Release assets: the tarball **and** its `.sha256`, matching the `pack` job
   output.
9. First release only: perform the manual publish (§5) and then configure the trusted
   publisher. Later releases: approve the `environment: npm` deployment.
10. `npm view opencode-session-observability version dist-tags` and confirm provenance on the
    package page.
11. Post-publish smoke test: `npx -y opencode-session-observability@<version> --version`.

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
3. Maintainer explicitly approves the release (version, tag `vX.Y.Z`, publish target).
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
