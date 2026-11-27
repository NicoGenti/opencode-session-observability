# PROJECT_PROFILE

- **Project type**: CLI / automation / MCP tooling (reason: the primary delivery is a command run on the user's machine — `opencode-observability` with its local read-only HTTP server, TUI commands and browser UI; the plugin/npm exports are consumed by that host flow rather than being the product's core. Guide: `E:\MyProjects\tech-stack` — `docs/project-profiles.md` §1, §2.7.)

- **Delivery / business model**: product — SaaS overlay: no

- **Complexity**: M (why: multiple workflows across Trajectory/Statistics plus export, benchmark, live, native panels; meaningful business rules in redaction/reveal defaults, recorded-order and projection invariants, diagnostics and health thresholds, and advisory guardrails; explicit module boundaries across `src/core`/adapters/server/ui/plugin; single local ownership with no multi-domain or isolation requirement.)

- **Deployment profile**: Local (Software executed on the user's device with no hosted service required; loopback bind `127.0.0.1`, no availability/recovery/distribution requirement stated. Guide: `E:\MyProjects\tech-stack` — `docs/delivery-profiles.md` §1 Deployment profiles; §2 Hosting by deployment profile.)

- **Requirements**:
  - Node.js 22.18+ or 24.x, CI-gated on Node 22 and 24; no native compile (uses built-in `node:sqlite`) — README §Requirements, CONTRIBUTING §Prerequisites.
  - OpenCode 2.2.x session data only; OpenCode 1 schema is detected and refused rather than read — README §Requirements.
  - An OpenCode 2.x host for the server/TUI plugin; packed package validated in a real host — README §Requirements.
  - A local browser and/or the OpenCode 2 TUI to view analysis — README §Requirements.
  - Read-only access only: no writes to sessions, messages or configuration; adapter interface has no mutation method; server routes are GET/HEAD only — README §Read-only and privacy, CONTRIBUTING §Read-only principles.
  - No telemetry and no third-party network calls; server binds `127.0.0.1` by default; non-loopback binds require `--allow-remote` with authentication — README §Read-only and privacy, CONTRIBUTING §Read-only principles.
  - Redaction of credential-shaped data on by default; reveal opt-in via `--reveal`/`allowReveal` with confirmation — README §Read-only and privacy, CONTRIBUTING §Read-only principles.
  - Two analysis views (Trajectory ledger and Statistics) plus export (JSON/Markdown/HTML plus the deterministic LLM-review digest) — README §What you get, §Export.
  - Plugin/TUI integration: read-only RPC namespace, native `/statistics` and `/trajectory` panels, `--web` browser deep links, `/statistics:web` — README §OpenCode 2 plugin integration, §UI guide.
  - Open-source distribution as an npm package (`opencode-session-observability`, public access) plus GitHub Release artifacts; zero runtime dependencies and committed bundles with CI freshness gates — README §OpenCode 2 plugin integration (Install), CONTRIBUTING §Dependency updates.
  - TypeScript in strict mode, ESM, `tsc --noEmit` only, no application build step for the server/UI — CONTRIBUTING §Prerequisites, README §Requirements.

- **Selected stack** (adopted existing stack; links are into the guide, tables not reproduced):
  - Language/runtime: TypeScript (strict, ESM) on Node ≥22.18 with built-in `node:sqlite` — guide: `E:\MyProjects\tech-stack` — `TECH_STACK.md` §3 defaults matrix (CLI/automation row), `docs/project-profiles.md` §2.7 (host ecosystem).
  - Local service plane: loopback HTTP API (`127.0.0.1:4517`) with bearer-token auth and per-port token file — guide: `E:\MyProjects\tech-stack` — `docs/delivery-profiles.md` §1 (Local), §2 (Hosting by deployment profile), §3 (SaaS overlay: no applicable capabilities).
  - Web UI: vanilla ES modules + CSS, no framework and no bundler — guide: `E:\MyProjects\tech-stack` — `docs/frontend.md` (adopted stack preserved per `TECH_STACK.md` §4.8; no React requirement is stated).
  - TUI/plugin host surface: Solid JSX via `@opentui/*` with peer floors, bundled by Vite into the committed `dist-tui/tui.mjs`; read-only RPC over the OpenCode client — guide: `E:\MyProjects\tech-stack` — `docs/agents-tooling.md`, `docs/project-profiles.md` §2.8 (library/plugin surface where public API and versioning apply).
  - Storage: read-only adapters (OpenCode 2 SQLite, OpenCode server API, in-memory fixtures) behind the small `ObservabilitySource` interface — guide: `E:\MyProjects\tech-stack` — `docs/data-storage.md`.
  - Packaging/release: npm public publish plus GitHub Release artifact channel, committed bundles with freshness gates — guide: `E:\MyProjects\tech-stack` — `docs/devops-hosting.md`, `docs/delivery-profiles.md` §4 (conditional infrastructure: none adopted beyond base profile).

- **Deferred capabilities**:
  - Hosted/multi-user serving — no stated requirement exists; server binds loopback by default and authentication stays required for any non-loopback bind (CONTRIBUTING §Read-only principles).
  - Telemetry and third-party network calls — declined per the read-only/no-telemetry principles (README intro, CONTRIBUTING §Read-only principles).
  - Native desktop GUI panel (`./gui-experimental`) — not shipped; browser UI is the primary surface (README §Limitations, §OpenCode 2 plugin integration).
  - Broker/cache/container orchestration infrastructure — no stated requirement meets the conditional-infrastructure "when" clauses; a single local process persists (guide `docs/delivery-profiles.md` §4).
  - Automatic npm publishing via trusted publishing (OIDC) — environment and trusted publishing are configured, but the automated path is verified only on the next release and the explicit maintainer gate stays; manual/Release-asset path remains the rule (docs/RELEASE.md, decisions 2026-11-17/2026-11-19).

- **Revisit when**:
  - A documented requirement appears in README/CONTRIBUTING for non-loopback or multi-user serving (forces re-running the deployment profile, Local → Hosted, and the auth/token model).
  - A documented requirement appears for first-class macOS/Linux TUI support beyond the current ubuntu-latest CI matrix (forces platform test-matrix and bundle verification changes).
  - An external consumer treats `./core`, `./rpc` or `./tui` as a stable public API (forces formal semver and peer-floor governance).
  - The OpenCode or `@opentui/*`/`solid-js` host APIs move past the committed peer floors (forces a coordinated `tui-host-stack` upgrade review per CONTRIBUTING §Dependency updates).

- **Unknowns**:
  - Whether any use case will require non-loopback or multi-user serving — settles deployment profile (Local vs Hosted) and the auth/token model.
  - Whether macOS/Linux TUI support is a first-class guarantee rather than best-effort beyond the current CI matrix — settles the platform test matrix and Windows-specific handling.
  - Whether the plugin/TUI/RPC surface is a stable external API — settles versioning/semver discipline and the peer-floor pin governance.

## Stack selection record

One coherent stack chosen per guide workflow §4; adopted stack preserved (no change in scope).

```text
Profile: PROJECT_PROFILE.md at repo root (type, complexity, deployment, requirements, selected stack, deferred, unknowns — see sections above)
Project row: CLI / automation / MCP tooling / M / Local
SaaS overlay: none
Stack:
- Language/runtime: TypeScript strict ESM on Node ≥22.18 with built-in node:sqlite — requirement: Node ≥22.18 / no native compile and strict-ESM no-build-step (README §Requirements, CONTRIBUTING §Prerequisites) — guide: E:\MyProjects\tech-stack — TECH_STACK.md §3 (defaults matrix, CLI/automation row) and docs/project-profiles.md §2.7
- Local service plane: loopback HTTP API at 127.0.0.1:4517 with bearer-token auth and per-port token file — requirement: local browser UI entry point and authenticated access per default (README §Quick start, §Read-only and privacy) — guide: E:\MyProjects\tech-stack — docs/delivery-profiles.md §1, §2
- Web UI: vanilla ES modules + CSS (no framework, no bundler) — requirement: existing adopted web UI preserved unless a stated benefit justifies change (README §UI guide) — guide: E:\MyProjects\tech-stack — docs/frontend.md
- TUI/plugin host surface: Solid JSX (@opentui/* peer floors >=0.9.7/>=2.0.3 <3), bundled to dist-tui/tui.mjs; read-only RPC over the OpenCode client — requirement: OpenCode 2.x host integration with native panels and prebuilt bundles (README §OpenCode 2 plugin integration) — guide: E:\MyProjects\tech-stack — docs/agents-tooling.md, docs/project-profiles.md §2.8
- Storage: read-only adapters (OpenCode 2 SQLite, OpenCode server API, in-memory fixtures) behind ObservabilitySource — requirement: read-only access to OpenCode 2 session data and fixtures (README §Read-only and privacy) — guide: E:\MyProjects\tech-stack — docs/data-storage.md
- Packaging/release: npm public publish + GitHub Release artifact channel, committed bundles with CI freshness gates, zero runtime deps — requirement: open-source distribution and CI-gated release (README §OpenCode 2 plugin integration (Install), CONTRIBUTING §Dependency updates) — guide: E:\MyProjects\tech-stack — docs/devops-hosting.md
Ownership: business logic src/core (I/O-free domain: normalize/project/metrics/diagnostics/export/redact/paging) | authorization src/server (loopback bind, --allow-remote gate, bearer tokens); on the read-only RPC path, transport auth is owned by the OpenCode host and this tool only guarantees a read-only RPC allow-list | database writes none — read-only adapters (SQLITE_OPEN_READONLY + PRAGMA query_only; no mutation method on ObservabilitySource); the OpenCode host owns all writes
Conditional capabilities: none — no stated requirement justifies any beyond-row capability; no broker/cache/orchestration/object storage/search/tracing adopted (docs/delivery-profiles.md §4; verification: nothing beyond the base profile to verify)
Deferred: see "Deferred capabilities" list in PROJECT_PROFILE.md above — same capabilities and reasons, not duplicated here
Unknowns: see "Unknowns" list in PROJECT_PROFILE.md above — same questions and the choices they settle
Decision level: project note — no ADR: documented profile chosen from the guide with ordinary low-impact choices and no significant exception, hard-to-reverse decision, or material operational/security/cost consequence (docs/TECH_DECISIONS.md §"Decision records")
```

## Frontend conventions

Vanilla web UI for a local-only read-only console; no framework, bundler, or server rendering is introduced. TUI/Solid (`@opentui/*`) is out of this section's scope and governed by the TUI/plugin host surface in the stack selection record above.

```text
Frontend
- Framework and rendering: vanilla ES modules + CSS served unbundled by the local server (no React/Vite/Next) — server rendering needed: no — why: local loopback tool with one static HTML entry point, no SEO/public delivery, and no stated requirement for a framework or SSR (README §UI guide, §Requirements; guide E:\MyProjects\tech-stack — docs/frontend.md §2 React and Vite is the baseline React preference deliberately not adopted; §8 Outside the baseline covers framework exceptions and jQuery/Bootstrap avoidance)
- Routing: framework-free hash router (parseHash()/onHashChange, `#/s/:session/:view?event=...`, `#/benchmark?filters`) — requirement: browser/TUI deep links and `--web` entry points open an exact session/view/event without server-side routing (README §Deep links, §OpenCode 2 plugin integration)
- Organization: single-page app with one ES module per concern (DOM-free builder modules under src/ui/*.js composed by app.js; settings.js preference store; virtual.js list), no shell architecture pattern — requirement: adopted unbundled ESM layout with no bundler and persisted preferences (CONTRIBUTING §Architecture pointers; README §Project layout)
- Components and styling: hand-written DOM builders + plain CSS with CSS custom-property design tokens; OpenCode theme palettes applied via settings.js; no shadcn/Radix component suite, icon set, or utility framework — use-when condition met: token-based modular CSS is justified by the bespoke, documented design system (DESIGN.md; README §UI guide) and shadcn/ui/Radix requires a React surface that is not adopted
- State boundaries: server state direct fetch of read-only JSON projections from the local HTTP API (business logic computed in src/core, service) | URL state location.hash routes (`#/s/:session/:view`, event query, benchmark filters) are the single source of navigation truth | client state in-memory view/filter/dialog/scroll state plus per-tab settings (theme, view mode, groups, guardrails) in src/ui/settings.js; token in sessionStorage
- Forms and validation: no form-submission surfaces (read-only UI); search/filter inputs and settings/guardrail controls only, with API query parameters validated by src/server and bounded guardrail inputs by settings.js — use-when condition met: React Hook Form/Zod require meaningful forms/validation needs, which are not stated
- Animation: CSS transitions only (120–160 ms) plus a global `prefers-reduced-motion: reduce` rule disabling transitions/animations and smooth scrolling — licence or verification note: confirmed (no animation library or third-party asset; zero runtime dependencies)
- Testing: node:test suites covering DOM-free builder modules (import-instantiation plus source-text wiring assertions against app.js/index.html/styles.css) plus manual browser validation; no Vitest/Playwright/MSW/e2e automation — per testing expectations (TECH_DECISIONS.md §Testing expectations, frontend.md §7)
- Deferred libraries: React + Vite framework, React Router, TanStack Query, Zustand, React Hook Form, Zod, Tailwind/shadcn/ui + Radix/lucide-react, GSAP — no stated requirement justifies them and each conflicts with the adopted vanilla, zero-runtime, no-build stack (guide E:\MyProjects\tech-stack — docs/frontend.md §2, §5, §6; §8 outside baseline)
- Unknowns: browser support baseline (supported browsers/versions) — would set the allowed ES/CSS feature floor and any need for transpilation under the no-build constraint; formal accessibility conformance target and assistive-technology coverage beyond the documented WCAG AA token contrast in DESIGN.md — would change ARIA patterns and whether automated accessibility testing is justified; real-time delivery beyond the existing 5-second live poll (SSE/WebSocket) — would change state-boundary design and server/UI contracts (already-recorded "live" route versus a streaming upgrade)
```

## Backend boundaries

Local read-only HTTP backend for an observability console: one Node process serves JSON projections and the bundled UI; business logic stays in the pure core, writes belong to the OpenCode host.

```text
Backend
- Owner: single local backend — owns business logic: yes (src/core, I/O-free normalization/projection/metrics/diagnostics/export/redact/paging) | authorization: yes (src/server, loopback bind + --allow-remote gate + bearer tokens/per-port token files) | database writes: no (read-only adapters; OpenCode host owns writes)
- Runtime and framework: Node ≥22.18 with stdlib node:http and hand-rolled routing in src/server/http.ts (no Express/Fastify or .NET host) — requirement: zero runtime dependencies and a local JSON/file-serving API surface (CONTRIBUTING §Dependencies, README §Requirements; guide E:\MyProjects\tech-stack — docs/backend.md §1 runtime/framework and §2 native choice by host ecosystem; guide's .NET/Minimal API candidate is a non-adoption with stated requirement)
- Organization: core/ domain (src/core) separated from presentation (src/server) and UI (src/ui); read-only adapters behind the small ObservabilitySource interface; feature-oriented handler blocks in src/server/http.ts around session/analysis/events/export/benchmark/live/family-recovery/digest — requirement: M-level explicit module boundaries and a read-only adapter contract (ARCHITECTURE.md §Layers/Adapter isolation, CONTRIBUTING §Architecture pointers)
- API style: REST over JSON (GET/HEAD only) at /api/health, /api/sessions, /api/sessions/:id, /api/sessions/:id/analysis, /api/.../events,/api/.../export (JSON/MD/HTML/digest), /api/benchmark, /api/.../live, /api/.../family-recovery; plus static UI assets and a VERSION string of 0.1.0 in src/server and package.json — contract or versioning note: unversioned local internal endpoints (no API version prefix or compatibility promise documented); plugin uses a separate typed RPC contract via ./rpc and ./core exports, not these HTTP routes
- Communication: synchronous request/response over HTTP; asynchronous: none — trigger: no message-broker/cache/queue requirement meets conditional-infrastructure criteria (delivery-profiles.md §4); the in-process 4-second dataset cache and 5-second UI live poll are local cadence, not messaging
- Libraries, concern by concern:
  - HTTP routing: node:http + hand-rolled handler (zero runtime deps) — use-when condition met: no stated requirement for a hosted-framework runtime and smallest admissible stdlib surface under zero-dependency posture
  - Query/body validation: hand-rolled bounded parsers in src/server (window bounds, filters, gr.* guardrail params) and settings.js; no FluentValidation/Joi/Zod — use-when condition met: filters/bounds are the surface, no stated rule-heavy validation requirement
  - Authentication: 256-bit per-run bearer token, constant-time comparison, --token/--no-auth/--allow-remote gating, per-port token file with user-only permissions — use-when condition met: every non-health /api route requires a token by default (README §Read-only and privacy)
  - Rate limiting: bounded per-source-IP ClientRateLimiter (merged 2026-11-20) — use-when condition met: source-IP flood protection (decision 2026-11-20)
  - Redaction: redactValue (recursive, credential-shaped, token counts preserved) by default, reveal gated — use-when condition met: redaction stays on by default (user-approved constraint)
  - Export serialization: hand-rolled JSON/Markdown/HTML report plus deterministic digest in src/core/export and src/core/digest — use-when condition met: stated export formats in README §Export
- Security controls: loopback bind 127.0.0.1 default with --allow-remote gate for non-loopback binds and required auth; per-run token not written to logs or error bodies, explicit --token value never persisted; PRAGMA query_only and SQLITE_OPEN_READONLY adapter (no mutation method, write-rejection test); Host/Origin validation against the listener (DNS-rebinding guard) with no CORS reliance; reveals opt-in (--reveal / allowReveal) with browser confirmation while active — use-when condition met: per §5 authentication and API security, each control maps to a stated read-only/local-binding/redaction principle (CONTRIBUTING §Read-only principles, README §Read-only and privacy)
- Testing scope: core pure unit tests + adapter/server HTTP integration tests against synthetic SQLite fixtures on an ephemeral port, including SHA-256 before/after DB-hash guarantee and read-only write-rejection; npm run check gate (typecheck + typecheck:tui + suite + TUI/server bundle freshness) — per testing expectations (docs/TECH_DECISIONS.md §Testing expectations, backend.md §6)
- Deferred practices: CQRS/event sourcing — single-user read-only domain with no writes; message broker/queue — no conditional-infrastructure trigger (delivery-profiles.md §4); microservices/independent deployables — single local process, no isolation requirement (TECH_STACK.md §2 forbids it with the L classification); ORM — read adapters over a fixed OpenCode 2 schema with no model ownership; write API or mutation surface — violates the read-only principle; multi-tenancy/organizations — no SaaS overlay (SaaS overlay: none)
- Unknowns: expected concurrency/load on the local API (single user vs. scripted multi-client polling) — would change connection handling, paging defaults, and the need for backpressure; integration by other editors/hosts beyond OpenCode 2 — would formalize an API contract and versioning policy (currently unversioned local endpoints); server-side streaming/live push (SSE/WebSocket) in place of the 5-second poll and in-process cache — would change connection and cache contracts (shared with the frontend unknown)
```