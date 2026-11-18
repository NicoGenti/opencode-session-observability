import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createComponent, createElement, createTextNode, effect, insert, insertNode, memo, setProp } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { PluginContextProvider, usePlugin } from "@opencode/plugin/tui";
// \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __esmMin = (fn, res, err) => () => {
	if (err) throw err[0];
	try {
		return fn && (res = fn(fn = 0)), res;
	} catch (e) {
		throw err = [e], e;
	}
};
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
// src/plugin/define.ts
function defineTuiPlugin(plugin) {
	return plugin;
}
var init_define = __esmMin((() => {}));
// src/server/token-file.ts
/** Tests and portable installs can override the directory. */
function tokenDirectory() {
	const override = process.env.OPENCODE_OBSERVABILITY_TOKEN_DIR;
	if (override) return override;
	if (process.platform === "win32") {
		const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
		return join(base, "opencode-observability");
	}
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (runtime) return join(runtime, "opencode-observability");
	return join(homedir(), ".config", "opencode-observability");
}
function tokenFilePath(port) {
	return join(tokenDirectory(), `token-${port}.json`);
}
async function readTokenFile(port) {
	try {
		const raw = await readFile(tokenFilePath(port), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed.version !== 1 || parsed.port !== port || typeof parsed.token !== "string" || parsed.token.length === 0) return null;
		return parsed;
	} catch {
		return null;
	}
}
var init_token_file = __esmMin((() => {}));
// src/plugin/tui-net.ts
function pluginToken(value) {
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	const env = process.env.OPENCODE_OBSERVABILITY_TOKEN;
	return typeof env === "string" && env.trim().length > 0 ? env.trim() : null;
}
async function tokenFromFile(base) {
	try {
		const url = new URL(base);
		const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
		if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
		return (await readTokenFile(port))?.token ?? null;
	} catch {
		return null;
	}
}
function baseUrl(value) {
	if (typeof value !== "string" || value.length === 0) return DEFAULT_URL;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_URL;
		if (!LOOPBACK.has(url.hostname.toLowerCase())) return DEFAULT_URL;
		return url.toString().replace(/\/$/, "");
	} catch {
		return DEFAULT_URL;
	}
}
async function reachable(url, fetchImpl = fetch) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 1500);
	try {
		const response = await fetchImpl(`${url}/api/health`, {
			signal: controller.signal,
			headers: { Accept: "application/json" }
		});
		if (!response.ok) return "down";
		return (await response.json().catch(() => null))?.authRequired === true ? "auth" : "ok";
	} catch {
		return "down";
	} finally {
		clearTimeout(timer);
	}
}
var DEFAULT_URL, LOOPBACK;
var init_tui_net = __esmMin((() => {
	init_token_file();
	DEFAULT_URL = "http://127.0.0.1:4517";
	LOOPBACK = /* @__PURE__ */ new Set([
		"127.0.0.1",
		"localhost",
		"[::1]",
		"::1"
	]);
}));
// src/plugin/tui-warmup.ts
function envFlag(value) {
	const normalized = value.trim().toLowerCase();
	if (FALSE_VALUES.has(normalized)) return false;
	if (TRUE_VALUES.has(normalized)) return true;
}
/**
* Whether the local UI should be started on demand.
*
* A recognized env value wins over the plugin option in both directions; an
* unrecognized or blank env value defers to the option, and the default is on
* (`option !== false`).
*/
function autoStartEnabled(option, envValue) {
	return (typeof envValue === "string" ? envFlag(envValue) : void 0) ?? option !== false;
}
/** What the warm-up launcher should do for a given reachability probe. */
function decideWarmup(status, autoStart) {
	if (status === "ok" || status === "auth") return "already-running";
	return autoStart ? "spawn" : "disabled";
}
/** Port of a configured base URL, falling back to the default local UI port. */
function basePort(base) {
	try {
		const url = new URL(base);
		if (url.port.length === 0) return DEFAULT_PORT;
		const port = Number(url.port);
		return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
	} catch {
		return DEFAULT_PORT;
	}
}
/**
* Package root, found by walking up from this module until a directory that
* contains `src/server/index.ts` is reached. Serves both the dev layout and the
* installed layout, and fails with the probed chain rather than inventing one.
*/
function resolvePackageRoot() {
	const probed = [];
	let current = MODULE_DIR;
	for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
		probed.push(current);
		if (existsSync(join(current, ...SERVER_ENTRY_SEGMENTS))) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`tui-warmup: package root not found (looked for ${SERVER_ENTRY_SEGMENTS.join("/")}); probed: ${probed.join(" -> ")}`);
}
/**
* Absolute path of the server entry point inside `root` (defaults to the
* package root). The prebuilt bundle wins when it exists: that is the single
* layout that runs under `node_modules/`, where Node will not type-strip `.ts`.
* Without it the dev layout falls back to the TypeScript source.
*/
function resolveServerEntry(root = resolvePackageRoot()) {
	const bundled = resolve(root, ...BUNDLED_ENTRY_SEGMENTS);
	if (existsSync(bundled)) return bundled;
	return resolve(root, ...SERVER_ENTRY_SEGMENTS);
}
/**
* Liveness probe via signal 0. `EPERM` means the process exists but belongs to
* someone else (or is unsignalable on Windows), so it still counts as alive.
*/
function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
/**
* Whether a claim can be replaced. A lock whose `createdAt` is older than
* `LOCK_STALE_MS` is stale regardless of pid liveness, because a recycled pid
* can otherwise keep a dead server's claim alive indefinitely. A record with
* no parseable timestamp falls back to the pid probe alone.
*/
function isLockStale(record, now = Date.now()) {
	const createdAt = Date.parse(record.createdAt);
	if (Number.isFinite(createdAt) && now - createdAt > LOCK_STALE_MS) return true;
	return !isProcessAlive(record.pid);
}
/** Reads a lock record; a missing or malformed file reads as `null`. */
function readLock(file) {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed.version !== LOCK_VERSION || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
		return {
			version: LOCK_VERSION,
			pid: parsed.pid,
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
		};
	} catch {
		return null;
	}
}
/**
* Claims the lock with an exclusive create. Returns `false` when the file
* already exists or cannot be created; the caller then treats the port as
* claimed rather than risk starting a second server.
*/
function writeLock(file, pid) {
	const record = {
		version: LOCK_VERSION,
		pid,
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	try {
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		writeFileSync(file, `${JSON.stringify(record)}\n`, {
			encoding: "utf8",
			mode: 384,
			flag: "wx"
		});
		return true;
	} catch {
		return false;
	}
}
/**
* Removes the lock only when its `pid` is the one this caller claimed, so a
* slower starter never deletes a newer starter's claim.
*/
function removeLockIfOwned(file, pid) {
	const record = readLock(file);
	if (!record || record.pid !== pid) return;
	try {
		rmSync(file, { force: true });
	} catch {}
}
/** Rewrites the claim with the child pid once the process exists. */
function adoptLock(file, pid) {
	const record = {
		version: LOCK_VERSION,
		pid,
		createdAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	try {
		writeFileSync(file, `${JSON.stringify(record)}\n`, {
			encoding: "utf8",
			mode: 384
		});
		return true;
	} catch {
		return false;
	}
}
/**
* Claims the lock for `port`, clearing a lock whose pid is gone. A live foreign
* pid (another starter is spawning or has already spawned) means "do not
* spawn"; the caller polls health instead.
*/
function claimLock(file) {
	if (writeLock(file, process.pid)) return "owned";
	const existing = readLock(file);
	if (existing && !isLockStale(existing)) return "busy";
	try {
		rmSync(file, { force: true });
	} catch {}
	const raced = readLock(file);
	if (raced && !isLockStale(raced)) return "busy";
	if (writeLock(file, process.pid)) return "owned";
	return "busy";
}
/**
* Starts the local UI detached so it outlives the TUI, and resolves with the
* child pid. A missing entry rejects immediately; the child's own "error"
* event is awaited briefly so an unspawnable runtime rejects too.
*/
function spawnServer(entry, port) {
	return new Promise((resolvePromise, rejectPromise) => {
		if (!existsSync(entry)) {
			rejectPromise(/* @__PURE__ */ new Error(`tui-warmup: server entry not found: ${entry}`));
			return;
		}
		const child = spawn(process.execPath, [
			entry,
			"--host",
			SPAWN_HOST,
			"--port",
			String(port)
		], {
			detached: true,
			stdio: "ignore",
			windowsHide: true
		});
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.unref();
			const pid = child.pid;
			if (typeof pid === "number" && pid > 0) resolvePromise(pid);
			else rejectPromise(/* @__PURE__ */ new Error("tui-warmup: spawned server has no pid"));
		}, SPAWN_SETTLE_MS);
		timer.unref?.();
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectPromise(error);
		});
		child.once("spawn", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.unref();
			const pid = child.pid;
			if (typeof pid === "number" && pid > 0) resolvePromise(pid);
			else rejectPromise(/* @__PURE__ */ new Error("tui-warmup: spawned server has no pid"));
		});
	});
}
function delay(ms) {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms).unref?.();
	});
}
/**
* Polls the health endpoint until the UI answers or the budget expires.
* Returns "down" past the budget; callers treat "ok" and "auth" as ready.
*/
async function waitForHealth(base, timeoutMs, probe = reachable, pollIntervalMs = POLL_INTERVAL_MS) {
	const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
	const deadline = Date.now() + budget;
	for (;;) {
		const status = await probe(base);
		if (status === "ok" || status === "auth") return status;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return "down";
		await delay(Math.min(Math.max(0, pollIntervalMs), remaining));
	}
}
/**
* Waits for the spawned server's token file. The health endpoint can answer
* "auth" a moment before the record is renamed into place; a short bounded poll
* closes that window. The outcome is advisory only: the caller returns "auth"
* either way, and `openView` reads the token itself afterwards.
*/
async function awaitTokenRecord(base, readToken, timeoutMs = TOKEN_POLL_TIMEOUT_MS, pollIntervalMs = POLL_INTERVAL_MS) {
	const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
	const deadline = Date.now() + budget;
	for (;;) {
		if (await readToken(base) !== null) return true;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await delay(Math.min(Math.max(0, pollIntervalMs), remaining));
	}
}
/**
* Makes sure the local UI answers at `base`, spawning it once when the knob
* allows. Resolves "ok"/"auth" when it is or became reachable and "down" when
* the budget expires; a spawn failure rejects with the spawn error.
*/
function ensureServer(base, options = {}) {
	const key = base.replace(/\/+$/, "");
	const existing = inFlight.get(key);
	if (existing) return existing;
	const promise = runEnsureServer(key, options).finally(() => {
		inFlight.delete(key);
	});
	inFlight.set(key, promise);
	return promise;
}
async function runEnsureServer(base, options) {
	const probe = options.probe ?? reachable;
	const spawnFn = options.spawn ?? spawnServer;
	const readToken = options.readToken ?? tokenFromFile;
	const lockDirectory = options.lockDirectory ?? tokenDirectory();
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const autoStart = options.autoStart ?? true;
	const initial = await probe(base);
	const decision = decideWarmup(initial, autoStart);
	if (decision === "already-running") return initial;
	if (decision === "disabled") return "down";
	const port = basePort(base);
	const lockFile = join(lockDirectory, `server-${port}.lock`);
	if (claimLock(lockFile) === "busy") return waitForHealth(base, timeoutMs, probe, pollIntervalMs);
	let ownerPid = process.pid;
	try {
		const childPid = await spawnFn(options.entry ?? resolveServerEntry(), port);
		if (adoptLock(lockFile, childPid)) ownerPid = childPid;
		const status = await waitForHealth(base, timeoutMs, probe, pollIntervalMs);
		if (status === "auth") {
			await awaitTokenRecord(base, readToken, TOKEN_POLL_TIMEOUT_MS, TOKEN_POLL_INTERVAL_MS);
			return status;
		}
		if (status !== "down") return status;
		return probe(base);
	} finally {
		removeLockIfOwned(lockFile, ownerPid);
	}
}
var DEFAULT_PORT, SERVER_ENTRY_SEGMENTS, BUNDLED_ENTRY_SEGMENTS, MAX_ANCESTOR_DEPTH, TRUE_VALUES, FALSE_VALUES, POLL_INTERVAL_MS, DEFAULT_TIMEOUT_MS, TOKEN_POLL_TIMEOUT_MS, TOKEN_POLL_INTERVAL_MS, LOCK_STALE_MS, SPAWN_SETTLE_MS, SPAWN_HOST, LOCK_VERSION, MODULE_DIR, inFlight;
var init_tui_warmup = __esmMin((() => {
	init_token_file();
	init_tui_net();
	DEFAULT_PORT = 4517;
	SERVER_ENTRY_SEGMENTS = [
		"src",
		"server",
		"index.ts"
	];
	BUNDLED_ENTRY_SEGMENTS = ["dist-server", "server.mjs"];
	MAX_ANCESTOR_DEPTH = 8;
	TRUE_VALUES = /* @__PURE__ */ new Set([
		"1",
		"true",
		"yes",
		"on"
	]);
	FALSE_VALUES = /* @__PURE__ */ new Set([
		"0",
		"false",
		"no",
		"off"
	]);
	POLL_INTERVAL_MS = 100;
	DEFAULT_TIMEOUT_MS = 1e4;
	TOKEN_POLL_TIMEOUT_MS = 1e3;
	TOKEN_POLL_INTERVAL_MS = 100;
	LOCK_STALE_MS = 864e5;
	SPAWN_SETTLE_MS = 250;
	SPAWN_HOST = "127.0.0.1";
	LOCK_VERSION = 1;
	MODULE_DIR = dirname(fileURLToPath(import.meta.url));
	inFlight = /* @__PURE__ */ new Map();
}));
// src/plugin/tui-native.ts
function isValidName(name) {
	return typeof name === "string" && name.trim().length > 0;
}
/**
* Announces a native view for `name`. Registrations are ref-counted: the
* returned cleanup removes exactly one reference, and calling it twice removes
* one. Blank names are rejected so they cannot corrupt the registry.
*
* @deprecated Router-page seam (issue #6, decision D1). Statistics renders
* through the `session.panel` slot, so no view is registered in production.
* The registry stays exported and functional for host compatibility; new views
* should claim `session.panel` and skip this registration step.
*/
function registerNativeView(name) {
	if (!isValidName(name)) throw new TypeError("registerNativeView requires a non-empty page name");
	nativeViews.set(name, (nativeViews.get(name) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const remaining = (nativeViews.get(name) ?? 0) - 1;
		if (remaining > 0) nativeViews.set(name, remaining);
		else nativeViews.delete(name);
	};
}
/** Whether at least one native view is currently registered for `name`. */
function hasNativeView(name) {
	return isValidName(name) && (nativeViews.get(name) ?? 0) > 0;
}
/**
* The session currently shown in the TUI, or `null` when the router is not on a
* session: home and plugin routes carry no session of their own.
*/
function currentSessionID(route) {
	if (!route || route.type !== "session") return null;
	const sessionID = route.sessionID;
	return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : null;
}
/**
* Opens the native Statistics route when a view is registered. Otherwise it
* explains the gap and hands over to the browser fallback. Never reads HTTP:
* the page itself loads its data.
*/
function openNativeStatistics(context, browserFallback) {
	if (!hasNativeView("statistics")) {
		context.ui.toast.show({
			title: TOAST_TITLE,
			message: NATIVE_VIEW_MISSING,
			variant: "info",
			duration: 8e3
		});
		if (browserFallback) browserFallback();
		return false;
	}
	context.ui.router.navigate({
		type: "plugin",
		id: TUI_PLUGIN_ID,
		name: STATISTICS_ROUTE,
		data: { sessionID: currentSessionID(context.ui.router.current()) }
	});
	return true;
}
var STATISTICS_ROUTE, TRAJECTORY_ROUTE, TUI_PLUGIN_ID, TOAST_TITLE, NATIVE_VIEW_MISSING, nativeViews;
var init_tui_native = __esmMin((() => {
	STATISTICS_ROUTE = "statistics";
	TRAJECTORY_ROUTE = "trajectory";
	TUI_PLUGIN_ID = "opencode-session-observability.tui";
	TOAST_TITLE = "Session observability";
	NATIVE_VIEW_MISSING = "Native view not installed yet.";
	nativeViews = /* @__PURE__ */ new Map();
}));
// src/plugin/tui-status.ts
function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function formatCost$1(cost) {
	return isFiniteNumber(cost) ? `$${cost.toFixed(2)}` : NOT_AVAILABLE;
}
function formatCacheHitRate(rate) {
	if (!isFiniteNumber(rate) || rate < 0 || rate > 1) return NOT_AVAILABLE;
	return `${Math.round(rate * 100)}%`;
}
/**
* Formats the one-line status badge: `"$0.12 · cache 38%"`. A missing,
* non-finite or out-of-domain value renders `n/a` for that field only.
*/
function formatStatusBadge(input) {
	return `${formatCost$1(input.cost)}${SEPARATOR}cache ${formatCacheHitRate(input.cacheHitRate)}`;
}
function sessionCost(context, sessionID) {
	try {
		const session = context.data.session;
		if (!session || typeof session.cost !== "function") return null;
		const cost = session.cost(sessionID);
		return isFiniteNumber(cost) ? cost : null;
	} catch {
		return null;
	}
}
/** Reads `analysis.totals.cacheHitRate.value`, rejecting anything off-domain. */
function parseCacheHitRate(body) {
	if (!body || typeof body !== "object") return null;
	const analysis = body.analysis;
	if (!analysis || typeof analysis !== "object") return null;
	const totals = analysis.totals;
	if (!totals || typeof totals !== "object") return null;
	const metric = totals.cacheHitRate;
	if (!metric || typeof metric !== "object") return null;
	const value = metric.value;
	if (!isFiniteNumber(value) || value < 0 || value > 1) return null;
	return value;
}
function resolveTtl(ttlMs) {
	return isFiniteNumber(ttlMs) ? Math.max(MIN_TTL_MS, ttlMs) : MIN_TTL_MS;
}
/**
* Probes health, then reads one analysis response. Resolves to the cache hit
* rate, or `null` for every failure shape (offline, auth gap, non-2xx,
* unparsable body). Never rejects.
*/
async function loadCacheHitRate(context, sessionID, options) {
	const fetchImpl = options.fetch ?? fetch;
	const base = baseUrl(context.options.url);
	const probe = options.health ?? ((url) => reachable(url, fetchImpl));
	let status;
	try {
		status = await probe(base);
	} catch {
		return null;
	}
	if (status === "down") return null;
	let token = null;
	if (status === "auth") {
		try {
			token = pluginToken(context.options.token) ?? await tokenFromFile(base);
		} catch {
			return null;
		}
		if (!token) return null;
	}
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1500);
		try {
			const headers = { Accept: "application/json" };
			if (token) headers.Authorization = `Bearer ${token}`;
			const response = await fetchImpl(`${base}/api/sessions/${encodeURIComponent(sessionID)}/analysis`, {
				headers,
				signal: controller.signal
			});
			if (!response.ok) return null;
			return parseCacheHitRate(await response.json().catch(() => null));
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
}
/**
* Returns the current session's cost and cache hit rate for the status badge.
* The cost comes from the SDK (`context.data.session.cost`); the cache hit rate
* comes from the local analysis route and is cached per session for at least
* 15 s, with one in-flight request shared by concurrent callers. Negative
* results are cached the same way. Never throws and never toasts.
*
* A missing or blank session id yields no data and touches neither the cache nor
* the network: there is nothing to key on and nothing to probe.
*/
async function fetchSessionStatus(context, sessionID, options = {}) {
	if (typeof sessionID !== "string" || sessionID.trim().length === 0) return {
		cost: null,
		cacheHitRate: null
	};
	const cost = sessionCost(context, sessionID);
	const now = options.now ?? Date.now;
	const ttl = resolveTtl(options.ttlMs);
	const cached = cache.get(sessionID);
	if (cached) {
		if (cached.expiresAt > now()) return {
			cost,
			cacheHitRate: cached.cacheHitRate
		};
		cache.delete(sessionID);
	}
	let pending = inflight.get(sessionID);
	if (!pending) {
		pending = loadCacheHitRate(context, sessionID, options).then((cacheHitRate) => {
			cache.set(sessionID, {
				cacheHitRate,
				expiresAt: now() + ttl
			});
			return cacheHitRate;
		}).finally(() => {
			inflight.delete(sessionID);
		});
		inflight.set(sessionID, pending);
	}
	return {
		cost,
		cacheHitRate: await pending
	};
}
/**
* Resolves the one-line text the `prompt.footer.status` badge renders: `null`
* when there is no session to describe, otherwise the formatted cost/cache
* line. A blank session id short-circuits before any cache or network work, so
* a host that renders the badge without a session costs nothing.
*
* This is the badge's whole data path: it never throws, never toasts and never
* writes session state. An offline server, a 401 or an unparsable body degrades
* that field to `n/a` inside `formatStatusBadge`.
*/
async function statusBadgeText(context, sessionID, options = {}) {
	if (typeof sessionID !== "string" || sessionID.trim().length === 0) return null;
	return formatStatusBadge(await fetchSessionStatus(context, sessionID, options));
}
/**
* Whether a badge render must drop its previous line: only a session change
* (including losing the session) invalidates it. A same-session re-render keeps
* the last line until the new resolution lands, so the footer does not blink.
*/
function badgeLineInvalidated(previous, next) {
	return (previous ?? null) !== (next ?? null);
}
var NOT_AVAILABLE, SEPARATOR, MIN_TTL_MS, cache, inflight;
var init_tui_status = __esmMin((() => {
	init_tui_net();
	NOT_AVAILABLE = "n/a";
	SEPARATOR = " · ";
	MIN_TTL_MS = 15e3;
	cache = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Map();
}));
// src/core/format.ts
function formatNumber(value) {
	if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
	return numberFormat.format(value);
}
function formatCompact(value) {
	if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
	if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
	if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return String(Math.round(value));
}
function formatDuration(ms) {
	if (ms === null || ms === void 0 || !Number.isFinite(ms)) return "—";
	const abs = Math.abs(ms);
	if (abs < 1e3) return `${Math.round(ms)} ms`;
	if (abs < 6e4) return `${(ms / 1e3).toFixed(2)} s`;
	if (abs < 36e5) {
		const minutes = Math.floor(abs / 6e4);
		const seconds = Math.round(abs % 6e4 / 1e3);
		return `${ms < 0 ? "-" : ""}${minutes}m ${seconds}s`;
	}
	const hours = Math.floor(abs / 36e5);
	const minutes = Math.round(abs % 36e5 / 6e4);
	return `${ms < 0 ? "-" : ""}${hours}h ${minutes}m`;
}
function formatPercent(ratio) {
	if (ratio === null || ratio === void 0 || !Number.isFinite(ratio)) return "—";
	return `${(ratio * 100).toFixed(1)}%`;
}
function formatCost(value) {
	if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
	if (value === 0) return "$0";
	if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
	if (Math.abs(value) >= .01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(6)}`;
}
function basisMark(basis) {
	if (basis === "measured") return "M";
	if (basis === "derived") return "D";
	if (basis === "estimated") return "E";
	return "—";
}
function slugify(value, max = 60) {
	return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "") || "session";
}
var numberFormat;
var init_format = __esmMin((() => {
	numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
}));
// src/plugin/tui/digestFile.ts
/** Deterministic, sanitized path for one session's review prompt file. */
function reviewPromptFilePath(tmpDir, sessionID) {
	return join(tmpDir, `${FILE_PREFIX}-${slugify(sessionID)}${FILE_EXTENSION}`);
}
/** Writes (or overwrites) the prompt file through an injectable writer. */
async function writeReviewPromptFile(path, content, write = writeUtf8) {
	await write(path, content);
}
var FILE_PREFIX, FILE_EXTENSION, writeUtf8;
var init_digestFile = __esmMin((() => {
	init_format();
	FILE_PREFIX = "opencode-observability-review";
	FILE_EXTENSION = ".md";
	writeUtf8 = (path, content) => writeFile(path, content, {
		encoding: "utf8",
		mode: 384
	});
}));
// src/plugin/tui/statistics/status.ts
function statusMark(status) {
	return MARKS[status] ?? FALLBACK;
}
function statusSymbol(status) {
	return statusMark(status).symbol;
}
/**
* The statistics panel's recommendation count line.
*
* The number counts `severity: "advisory"` rows — the hypotheses — and names
* that vocabulary so the line can never read as a score, a priority or a
* ranking. Non-finite and negative input degrades to `0 advisory`; the panel
* has no recommendation detail surface, the browser is the primary one.
*/
function recommendationsStatusLine(count) {
	return `Recommendations: ${Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0} advisory`;
}
/**
* The statistics panel's guardrail count line.
*
* The TUI evaluates the pure module with `DEFAULT_GUARDRAILS` — browser-owned
* thresholds are localStorage state and never cross the RPC — so the line names
* the defaults. The count is the number of crossed budgets; there is no detail
* surface here (the browser is the primary one) and the word "advisory" keeps
* the line from reading as a block, a score or a priority. Non-finite and
* negative input degrades to `0 advisory`.
*/
function guardrailsStatusLine(count) {
	return `Guardrails (defaults): ${Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0} advisory`;
}
var MARKS, FALLBACK;
var init_status = __esmMin((() => {
	MARKS = {
		completed: {
			symbol: "OK",
			label: "Completed",
			paletteKey: "good"
		},
		error: {
			symbol: "ERR",
			label: "Error",
			paletteKey: "critical"
		},
		interrupted: {
			symbol: "INT",
			label: "Interrupted",
			paletteKey: "warning"
		},
		running: {
			symbol: "RUN",
			label: "Running",
			paletteKey: "accent"
		},
		incomplete: {
			symbol: "INC",
			label: "Incomplete",
			paletteKey: "warning"
		},
		unknown: {
			symbol: "?",
			label: "Unknown",
			paletteKey: "muted"
		}
	};
	FALLBACK = MARKS.unknown;
}));
// src/plugin/tui/statistics/columns.ts
function resolveLayout(width) {
	const safe = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
	if (safe >= BREAKPOINTS.full) return {
		width: safe,
		mode: "full",
		columns: FULL_COLUMNS
	};
	if (safe >= BREAKPOINTS.wideMid) return {
		width: safe,
		mode: "mid",
		columns: WIDE_MID_COLUMNS
	};
	if (safe >= BREAKPOINTS.mid) return {
		width: safe,
		mode: "mid",
		columns: MID_COLUMNS
	};
	if (safe >= BREAKPOINTS.narrowMid) return {
		width: safe,
		mode: "mid",
		columns: NARROW_MID_COLUMNS
	};
	return {
		width: safe,
		mode: "compact",
		columns: COMPACT_COLUMNS
	};
}
function columnLabel(id) {
	return COLUMN_LABELS[id];
}
function columnWidth(id) {
	return COLUMN_WIDTHS[id];
}
function metricOf(metric) {
	return metric ?? UNAVAILABLE$1;
}
function numberText(value) {
	return formatCompact(value);
}
function marked$1(metric, formatter) {
	const current = metricOf(metric);
	if (current.value === null || !Number.isFinite(current.value)) return "—";
	const basis = current.basis ?? "unavailable";
	return `${formatter(current.value)} ${basisMark(basis)}`;
}
function markedCompact(metric) {
	return marked$1(metric, (value) => formatCompact(value));
}
/**
* The compact `tokens` cell keeps the latest and cumulative prompt sizes
* adjacent, latest first, as documented for the narrow layout.
*/
function contextPair(turn) {
	return `${markedCompact(turn.promptTokensLatest)}/${markedCompact(turn.promptTokensCumulative)}`;
}
/** Primitive cell text for every column id, keyed by the column id. */
function turnCellValues(turn) {
	const tokens = turn.tokens;
	const status = turn.status ?? "unknown";
	return {
		turn: String(turn.index),
		steps: String(turn.steps?.length ?? 0),
		tokIn: numberText(tokens?.input),
		tokOut: numberText(tokens?.output),
		reasoning: numberText(tokens?.reasoning),
		cacheRead: numberText(tokens?.cacheRead),
		cacheWrite: numberText(tokens?.cacheWrite),
		cacheHit: marked$1(turn.cacheHitRate, (value) => formatPercent(value)),
		modelMs: marked$1(turn.modelTime, (value) => formatDuration(value)),
		toolMs: marked$1(turn.toolTime, (value) => formatDuration(value)),
		residual: marked$1(turn.residualTime, (value) => formatDuration(value)),
		cost: marked$1(turn.cost, (value) => formatCost(value)),
		status: statusSymbol(status),
		tokens: contextPair(turn)
	};
}
function padCell$1(id, value) {
	const width = columnWidth(id);
	const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
	if (id === "status") return clipped.padEnd(width);
	return clipped.padStart(width);
}
/** Header line for the resolved column set, aligned with `formatRow`. */
function formatHeader(columns) {
	return `  ${columns.map((id) => padCell$1(id, columnLabel(id))).join(" ")}`;
}
/**
* Formats one turn row. Status is split out because the view colors it by
* palette key while keeping the terminal-safe symbol in the same cell.
*
* When `expanded` is provided the two-character selection marker becomes the
* selection glyph plus the accordion marker (`+` collapsed, `-` expanded, or a
* blank for turns without steps). Omitting it keeps the phase-2 output.
*/
function formatRow(turn, columns, selected, expanded) {
	const values = turnCellValues(turn);
	const selection = selected ? ">" : " ";
	const marker = expanded === void 0 ? `${selection} ` : `${selection}${(turn.steps?.length ?? 0) === 0 ? " " : expanded ? "-" : "+"}`;
	const cells = [];
	let status = "";
	for (const id of columns) {
		const cell = padCell$1(id, values[id]);
		if (id === "status") {
			status = ` ${cell}`;
			continue;
		}
		cells.push(cell);
	}
	return {
		prefix: `${marker}${cells.join(" ")}`,
		status
	};
}
var BREAKPOINTS, FULL_COLUMNS, WIDE_MID_COLUMNS, MID_COLUMNS, NARROW_MID_COLUMNS, COMPACT_COLUMNS, COLUMN_LABELS, COLUMN_WIDTHS, UNAVAILABLE$1;
var init_columns = __esmMin((() => {
	init_format();
	init_status();
	BREAKPOINTS = {
		full: 120,
		wideMid: 100,
		mid: 90,
		narrowMid: 81,
		compact: 80
	};
	FULL_COLUMNS = [
		"turn",
		"steps",
		"tokIn",
		"tokOut",
		"reasoning",
		"cacheRead",
		"cacheWrite",
		"cacheHit",
		"modelMs",
		"toolMs",
		"residual",
		"cost",
		"status"
	];
	WIDE_MID_COLUMNS = FULL_COLUMNS.filter((id) => id !== "reasoning");
	MID_COLUMNS = WIDE_MID_COLUMNS.filter((id) => id !== "cacheWrite");
	NARROW_MID_COLUMNS = [
		"turn",
		"steps",
		"tokIn",
		"tokOut",
		"cost",
		"status"
	];
	COMPACT_COLUMNS = [
		"turn",
		"tokens",
		"cost",
		"status"
	];
	COLUMN_LABELS = {
		turn: "#",
		steps: "Steps",
		tokIn: "In",
		tokOut: "Out",
		reasoning: "Reason",
		cacheRead: "CacheR",
		cacheWrite: "CacheW",
		cacheHit: "Hit",
		modelMs: "Model",
		toolMs: "Tool",
		residual: "Resid",
		cost: "Cost",
		status: "Status",
		tokens: "Tokens"
	};
	COLUMN_WIDTHS = {
		turn: 4,
		steps: 5,
		tokIn: 8,
		tokOut: 8,
		reasoning: 7,
		cacheRead: 8,
		cacheWrite: 8,
		cacheHit: 8,
		modelMs: 9,
		toolMs: 9,
		residual: 9,
		cost: 10,
		status: 6,
		tokens: 17
	};
	UNAVAILABLE$1 = {
		value: null,
		basis: "unavailable"
	};
}));
// src/plugin/tui/statistics/stepRows.ts
/**
* Step rows degrade like the turn table: extra context disappears on narrow
* terminals while index, tokens, cost and status always survive.
*/
function stepFields(width) {
	const safe = Number.isFinite(width) ? Math.trunc(width) : 0;
	if (safe >= 120) return ALL_FIELDS;
	if (safe >= 90) return [
		"index",
		"trigger",
		"model",
		"tokens",
		"cost",
		"time",
		"status"
	];
	if (safe >= 81) return [
		"index",
		"trigger",
		"tokens",
		"cost",
		"status"
	];
	return [
		"index",
		"tokens",
		"cost",
		"status"
	];
}
function text(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : EM_DASH;
}
function marked(metric, formatter) {
	if (!metric || metric.value === null || !Number.isFinite(metric.value)) return EM_DASH;
	return `${formatter(metric.value)} ${basisMark(metric.basis)}`;
}
function modelLabel(step) {
	const id = step.model?.id;
	if (typeof id === "string" && id.trim().length > 0) return id.trim();
	return text(step.provider);
}
function toolSummary(step) {
	const names = Array.isArray(step.toolNames) ? step.toolNames.filter((name) => typeof name === "string" && name.trim().length > 0) : [];
	if (names.length > 0) return names.join(",");
	const calls = Array.isArray(step.toolCalls) ? step.toolCalls.length : 0;
	if (calls > 0) return calls === 1 ? "1 call" : `${calls} calls`;
	return EM_DASH;
}
function tokensLabel(step) {
	const tokens = step.tokens;
	if (!tokens) return EM_DASH;
	return `${formatCompact(tokens.input)}→${formatCompact(tokens.output)}`;
}
/** Primitive cell text for one accordion row. */
function stepCellValues(step) {
	const trigger = typeof step.trigger === "string" && step.trigger.trim().length > 0 ? step.trigger.trim() : text(step.agent);
	return {
		index: Number.isFinite(step.index) ? String(Math.trunc(step.index)) : "0",
		trigger,
		model: modelLabel(step),
		tools: toolSummary(step),
		tokens: tokensLabel(step),
		cost: formatCost(step.cost),
		time: marked(step.modelTime, formatDuration),
		status: statusMark(step.status).symbol
	};
}
function padCell(field, value) {
	const width = STEP_WIDTHS[field];
	const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
	return LEFT_ALIGNED.has(field) ? clipped.padEnd(width) : clipped.padStart(width);
}
/**
* Formats one step row below its turn. The four-space indent keeps the row
* visibly nested under the turn table while staying monospace-aligned.
*/
function formatStepRow(step, width, fields = stepFields(width)) {
	const values = stepCellValues(step);
	const cells = [];
	let status = "";
	for (const field of fields) {
		const cell = padCell(field, values[field]);
		if (field === "status") {
			status = ` ${cell}`;
			continue;
		}
		cells.push(cell);
	}
	return {
		prefix: `    ${cells.join(" ")}`,
		status
	};
}
var EM_DASH, STEP_WIDTHS, LEFT_ALIGNED, ALL_FIELDS;
var init_stepRows = __esmMin((() => {
	init_format();
	init_status();
	EM_DASH = "—";
	STEP_WIDTHS = {
		index: 3,
		trigger: 18,
		model: 22,
		tools: 20,
		tokens: 17,
		cost: 10,
		time: 10,
		status: 5
	};
	LEFT_ALIGNED = /* @__PURE__ */ new Set([
		"trigger",
		"model",
		"tools"
	]);
	ALL_FIELDS = [
		"index",
		"trigger",
		"model",
		"tools",
		"tokens",
		"cost",
		"time",
		"status"
	];
}));
// src/core/health.ts
/**
* A compaction recorded inside the run's span ends the run. A turn that owns
* the compaction is included in the run that it terminates; a compaction
* recorded between two turns ends the run at the preceding turn.
*/
function compactionBreaks(previous, next, compactions) {
	const previousEnd = previous.endTime ?? previous.startTime;
	const nextEnd = next.endTime ?? next.startTime;
	return compactions.some((item) => {
		if (item.turnID === previous.id || item.turnID === next.id) return true;
		return item.timestamp > previousEnd && item.timestamp <= nextEnd;
	});
}
/**
* Longest run of consecutive turns whose context delta is positive.
*
* Exported so the guardrail context-run budget shares the exact health
* vocabulary (compaction breaks included) instead of reimplementing it.
*/
function longestGrowthRun(analysis) {
	const runs = [];
	let current = [];
	const flush = () => {
		if (current.length > 0) runs.push(current);
		current = [];
	};
	for (const turn of analysis.turns) {
		const delta = turn.contextDelta.value;
		if (delta === null || delta <= 0) {
			flush();
			continue;
		}
		if (current.length > 0) {
			const previous = current[current.length - 1];
			if (compactionBreaks(previous, turn, analysis.compactions)) flush();
		}
		current.push(turn);
		if (analysis.compactions.some((item) => item.turnID === turn.id)) flush();
	}
	flush();
	let best = null;
	for (const run of runs) if (best === null || run.length > best.length) best = run;
	if (best === null) return null;
	return {
		first: best[0],
		last: best[best.length - 1],
		length: best.length
	};
}
var init_health = __esmMin((() => {
	Object.freeze({
		errorRate: Object.freeze({
			watchRate: .25,
			watchErrors: 4,
			strongRate: .6,
			strongErrors: 6
		}),
		retryCount: Object.freeze({
			watch: 8,
			strong: 15
		}),
		toolFailureRecurrence: Object.freeze({
			watchIncidents: 4,
			strongIncidents: 7,
			watchMaxAttempts: 5,
			strongMaxAttempts: 9
		}),
		contextGrowth: Object.freeze({
			watchRun: 5,
			strongRun: 8,
			watchFinalContext: 15e4,
			strongFinalContext: 25e4
		}),
		costPerTurn: Object.freeze({
			watch: 2,
			strong: 10
		}),
		lowCacheHit: Object.freeze({
			lowBelow: .2,
			watchLowTurns: 5,
			strongLowTurns: 9,
			watchShare: .6,
			strongShare: .8
		}),
		maxEventLinks: 10,
		maxTurnLinks: 6
	});
}));
// src/core/guardrails.ts
/** A finite, non-negative threshold; anything else falls back to the default. */
function limitFor(thresholds, key) {
	const value = thresholds[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_GUARDRAILS[key];
}
/** Deduplicates, drops empty ids and caps the list in recorded order. */
function capIDs(ids, limit) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const id of ids) {
		if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		if (out.length >= limit) break;
	}
	return out;
}
/** `input + output + reasoning + cache read + cache write`, like `sumTokens`. */
function totalTokens(tokens) {
	return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;
}
/** Highest-token turns, descending, ties resolved by recorded order. */
function heaviestTurns(turns, limit) {
	return [...turns].sort((left, right) => totalTokens(right.tokens) - totalTokens(left.tokens) || left.index - right.index).filter((turn) => totalTokens(turn.tokens) > 0).slice(0, limit).map((turn) => turn.id);
}
/** Highest-cost turns, descending, ties resolved by recorded order. */
function costliestTurns(turns, limit) {
	return [...turns].filter((turn) => turn.cost.value !== null).sort((left, right) => (right.cost.value ?? 0) - (left.cost.value ?? 0) || left.index - right.index).slice(0, limit).map((turn) => turn.id);
}
function warning(id, observed, threshold, eventIDs = [], turnIDs = []) {
	return {
		id,
		label: LABELS[id],
		observed,
		threshold,
		basis: "derived",
		advisory: true,
		eventIDs: capIDs(eventIDs, 10),
		turnIDs: capIDs(turnIDs, 6)
	};
}
function skip(id, note) {
	return {
		kind: "skip",
		skip: {
			id,
			label: LABELS[id],
			note
		}
	};
}
function tokensBudget(analysis, limit) {
	const tokens = totalTokens(analysis.totals.tokens);
	if (tokens === 0 && !analysis.capabilities.tokenUsage) return skip("tokens-total", "token usage was not recorded");
	const observed = `${tokens} total token(s) recorded`;
	if (tokens < limit) return NONE;
	return {
		kind: "warning",
		warning: warning("tokens-total", observed, limit, [], heaviestTurns(analysis.turns, 3))
	};
}
function costBudget(analysis, limit) {
	const cost = analysis.totals.cost.value;
	if (cost === null) return skip("cost-total", "cost was not recorded");
	const observed = `$${cost.toFixed(2)} total recorded cost`;
	if (cost < limit) return NONE;
	return {
		kind: "warning",
		warning: warning("cost-total", observed, limit, [], costliestTurns(analysis.turns, 3))
	};
}
function contextRunBudget(analysis, limit) {
	const available = analysis.turns.filter((turn) => turn.contextDelta.value !== null).length;
	if (available < 2) return skip("context-run", `${available} turn(s) recorded a context delta; at least 2 are required`);
	const run = longestGrowthRun(analysis);
	const length = run?.length ?? 0;
	const observed = `longest growth run ${length} turn(s)`;
	if (length < limit) return NONE;
	return {
		kind: "warning",
		warning: warning("context-run", observed, limit, [], run ? [run.first.id, run.last.id] : [])
	};
}
function retriesBudget(analysis, limit) {
	const retries = analysis.totals.retries;
	const observed = `${retries} retry event(s) recorded`;
	if (retries < limit) return NONE;
	return {
		kind: "warning",
		warning: warning("retries", observed, limit, analysis.events.filter((event) => event.kind === "retry").map((event) => event.id))
	};
}
function toolFailuresBudget(analysis, limit) {
	const incidents = analysis.diagnostics?.incidents ?? [];
	const observed = `${incidents.length} tool-failure incident(s) recorded`;
	if (incidents.length < limit) return NONE;
	return {
		kind: "warning",
		warning: warning("tool-failures", observed, limit, incidents.map((incident) => incident.firstFailureEventID))
	};
}
/**
* Wall time between the first and the last recorded event. Only a complete
* analysis bounds the whole session, so a windowed one is skipped rather than
* timed from a partial event set.
*/
function elapsedBudget(analysis, limit) {
	if (!analysis.coverage.complete) return skip("elapsed-minutes", "the analysis covers a window, not the full session");
	const events = analysis.events;
	if (events.length === 0) return skip("elapsed-minutes", "no events were recorded");
	let first = events[0];
	let last = events[0];
	for (const event of events) {
		if (event.timestamp < first.timestamp) first = event;
		if (event.timestamp > last.timestamp) last = event;
	}
	const minutes = Math.max(0, last.timestamp - first.timestamp) / 6e4;
	const observed = `${minutes.toFixed(1)} minute(s) from the first to the last recorded event`;
	if (minutes < limit) return NONE;
	return {
		kind: "warning",
		warning: warning("elapsed-minutes", observed, limit, [first.id, last.id])
	};
}
/**
* Primary entry point. Pure, deterministic and local; the default thresholds
* are `DEFAULT_GUARDRAILS`. A malformed injected threshold (not finite or
* negative) falls back to the default for that budget, so a hostile query
* cannot disable a budget or make the evaluator throw.
*/
function evaluateGuardrails(analysis, thresholds = DEFAULT_GUARDRAILS) {
	const limits = {
		tokensTotal: limitFor(thresholds, "tokensTotal"),
		costTotal: limitFor(thresholds, "costTotal"),
		contextRun: limitFor(thresholds, "contextRun"),
		retries: limitFor(thresholds, "retries"),
		toolFailures: limitFor(thresholds, "toolFailures"),
		elapsedMinutes: limitFor(thresholds, "elapsedMinutes")
	};
	const outcomes = [
		tokensBudget(analysis, limits.tokensTotal),
		costBudget(analysis, limits.costTotal),
		contextRunBudget(analysis, limits.contextRun),
		retriesBudget(analysis, limits.retries),
		toolFailuresBudget(analysis, limits.toolFailures),
		elapsedBudget(analysis, limits.elapsedMinutes)
	];
	const warnings = [];
	const skipped = [];
	for (const outcome of outcomes) if (outcome.kind === "skip") skipped.push(outcome.skip);
	else if (outcome.kind === "warning") warnings.push(outcome.warning);
	return {
		warnings,
		skipped
	};
}
var DEFAULT_GUARDRAILS, GUARDRAIL_MAX, LABELS, NONE;
var init_guardrails = __esmMin((() => {
	init_health();
	DEFAULT_GUARDRAILS = Object.freeze({
		tokensTotal: 2e6,
		costTotal: 5,
		contextRun: 6,
		retries: 10,
		toolFailures: 5,
		elapsedMinutes: 60
	});
	GUARDRAIL_MAX = Object.freeze({
		tokensTotal: 0xe8d4a51000,
		costTotal: 0xe8d4a51000,
		contextRun: 0xe8d4a51000,
		retries: 0xe8d4a51000,
		toolFailures: 0xe8d4a51000,
		elapsedMinutes: 1e5
	});
	GUARDRAIL_MAX.elapsedMinutes;
	LABELS = Object.freeze({
		"tokens-total": "Token budget",
		"cost-total": "Cost budget",
		"context-run": "Context growth budget",
		retries: "Retry budget",
		"tool-failures": "Tool-failure budget",
		"elapsed-minutes": "Elapsed-time budget"
	});
	NONE = { kind: "none" };
}));
// src/plugin/rpc-define.ts
/**
* `Rpc.define` only rejects error names that use the reserved `rpc.` prefix
* and returns its input. Replicating that check keeps the contract identical
* without importing the SDK at runtime.
*/
function defineRpc(definition) {
	const reserved = Object.values(definition.methods).flatMap((method) => Object.keys(method.errors ?? {})).find((name) => name.startsWith("rpc."));
	if (reserved) throw new Error(`RPC error names starting with "rpc." are reserved: ${reserved}`);
	return definition;
}
var init_rpc_define = __esmMin((() => {}));
// src/plugin/rpc.ts
var stringArray, looseObject, emptyInput, Observability;
var init_rpc = __esmMin((() => {
	init_rpc_define();
	stringArray = {
		type: "array",
		items: { type: "string" }
	};
	looseObject = {
		type: "object",
		additionalProperties: true
	};
	emptyInput = {
		type: "object",
		properties: {},
		additionalProperties: false
	};
	Observability = defineRpc({
		id: "session-observability",
		methods: {
			health: {
				input: emptyInput,
				output: {
					type: "object",
					properties: {
						ok: { type: "boolean" },
						version: { type: "string" },
						source: { type: "string" },
						revealAllowed: { type: "boolean" },
						readOnly: { type: "boolean" }
					},
					required: [
						"ok",
						"version",
						"source",
						"revealAllowed",
						"readOnly"
					],
					additionalProperties: false
				}
			},
			sessions: {
				input: {
					type: "object",
					properties: {
						query: { type: "string" },
						limit: { type: "number" },
						reveal: { type: "boolean" }
					},
					additionalProperties: false
				},
				output: {
					type: "object",
					properties: {
						sessions: {
							type: "array",
							items: looseObject
						},
						revealAllowed: { type: "boolean" }
					},
					required: ["sessions", "revealAllowed"],
					additionalProperties: false
				}
			},
			session: {
				input: {
					type: "object",
					properties: {
						sessionID: { type: "string" },
						reveal: { type: "boolean" }
					},
					required: ["sessionID"],
					additionalProperties: false
				},
				output: {
					type: "object",
					properties: {
						session: looseObject,
						family: looseObject,
						revealAllowed: { type: "boolean" }
					},
					required: [
						"session",
						"family",
						"revealAllowed"
					],
					additionalProperties: false
				}
			},
			analysis: {
				input: {
					type: "object",
					properties: {
						sessionID: { type: "string" },
						fromSeq: { type: "number" },
						toSeq: { type: "number" },
						reveal: { type: "boolean" }
					},
					required: ["sessionID"],
					additionalProperties: false
				},
				output: {
					type: "object",
					properties: {
						analysis: looseObject,
						revealAllowed: { type: "boolean" }
					},
					required: ["analysis", "revealAllowed"],
					additionalProperties: false
				}
			},
			eventPage: {
				input: {
					type: "object",
					properties: {
						sessionID: { type: "string" },
						q: { type: "string" },
						kinds: stringArray,
						agents: stringArray,
						models: stringArray,
						providers: stringArray,
						tools: stringArray,
						statuses: stringArray,
						errorsOnly: { type: "boolean" },
						retriesOnly: { type: "boolean" },
						compactionsOnly: { type: "boolean" },
						subagentsOnly: { type: "boolean" },
						contextOnly: { type: "boolean" },
						from: { type: "number" },
						to: { type: "number" },
						minPromptTokens: { type: "number" },
						maxPromptTokens: { type: "number" },
						limit: { type: "number" },
						before: { type: "string" },
						after: { type: "string" },
						around: { type: "string" },
						direction: {
							type: "string",
							enum: ["forward", "backward"]
						},
						reveal: { type: "boolean" }
					},
					required: ["sessionID"],
					additionalProperties: false
				},
				output: {
					type: "object",
					properties: {
						events: {
							type: "array",
							items: looseObject
						},
						page: looseObject,
						coverage: looseObject,
						capabilities: looseObject,
						redacted: { type: "boolean" },
						revealAllowed: { type: "boolean" }
					},
					required: [
						"events",
						"page",
						"coverage",
						"capabilities",
						"redacted",
						"revealAllowed"
					],
					additionalProperties: false
				}
			},
			event: {
				input: {
					type: "object",
					properties: {
						sessionID: { type: "string" },
						eventID: { type: "string" },
						reveal: { type: "boolean" }
					},
					required: ["sessionID", "eventID"],
					additionalProperties: false
				},
				output: {
					type: "object",
					properties: {
						event: looseObject,
						revealAllowed: { type: "boolean" }
					},
					required: ["event", "revealAllowed"],
					additionalProperties: false
				}
			},
			export: {
				input: {
					type: "object",
					properties: {
						sessionID: { type: "string" },
						format: {
							type: "string",
							enum: [
								"json",
								"markdown",
								"html",
								"digest"
							]
						},
						includeEvents: { type: "boolean" },
						prompt: { type: "boolean" },
						reveal: { type: "boolean" }
					},
					required: ["sessionID", "format"],
					additionalProperties: false
				},
				output: {
					type: "object",
					properties: {
						filename: { type: "string" },
						mime: { type: "string" },
						content: { type: "string" },
						redacted: { type: "boolean" }
					},
					required: [
						"filename",
						"mime",
						"content",
						"redacted"
					],
					additionalProperties: false
				}
			}
		},
		events: {}
	});
}));
// src/plugin/tui/analysisResponse.ts
/**
* Whether a value is a plain object: the shared shape guard for payloads that
* cross the RPC boundary.
*/
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function looksLikeAnalysis(value) {
	return isRecord(value) && Array.isArray(value.turns) && isRecord(value.totals) && isRecord(value.session);
}
/**
* Accepts the raw RPC envelope (`{ output: … }`), the handler result
* (`{ analysis, revealAllowed }`) and a bare `Analysis`. Anything else becomes
* a short, non-leaking error message.
*/
function parseAnalysisResponse(response) {
	let current = response;
	for (let depth = 0; depth < 4; depth++) {
		if (!isRecord(current)) break;
		if (looksLikeAnalysis(current)) return {
			ok: true,
			analysis: current
		};
		if ("analysis" in current) {
			const inner = current.analysis;
			if (looksLikeAnalysis(inner)) return {
				ok: true,
				analysis: inner
			};
			return {
				ok: false,
				message: "No analysis is available for this session."
			};
		}
		if ("output" in current) {
			current = current.output;
			continue;
		}
		if ("error" in current) return {
			ok: false,
			message: "The analysis request returned an error."
		};
		break;
	}
	return {
		ok: false,
		message: "The analysis response was not recognized."
	};
}
var init_analysisResponse = __esmMin((() => {}));
// src/plugin/tui/polling.ts
/**
* True when the session recorded a terminal outcome, no turn is running and
* the recorded clock says the session is not busy (`busy <= idle`, or no busy
* stamp at all).
*/
function isSettledAnalysis(analysis) {
	if (!analysis) return false;
	const session = analysis.session;
	if (!session) return false;
	const { busy, idle } = session.time ?? {};
	if (typeof busy === "number" && (typeof idle !== "number" || busy > idle)) return false;
	const turns = Array.isArray(analysis.turns) ? analysis.turns : [];
	if (turns.some((turn) => turn.status === "running")) return false;
	if (session.outcome) return true;
	const last = turns[turns.length - 1];
	return last !== void 0 && TERMINAL_TURN_STATUS.has(last.status);
}
var TERMINAL_TURN_STATUS;
var init_polling = __esmMin((() => {
	TERMINAL_TURN_STATUS = /* @__PURE__ */ new Set([
		"completed",
		"error",
		"interrupted"
	]);
}));
// src/plugin/tui/statistics/state.ts
/** Clamps an index into `[0, count - 1]`; an empty list always yields 0. */
function clampIndex(index, count) {
	const total = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
	if (total === 0) return 0;
	return Math.min(Math.max(Number.isFinite(index) ? Math.trunc(index) : 0, 0), total - 1);
}
/**
* Pure selection step. Exported for phase-4 unit tests: given the current
* index, a delta and the turn count, it returns the clamped next index.
*/
function moveSelection(current, delta, count) {
	const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
	return clampIndex((Number.isFinite(current) ? Math.trunc(current) : 0) + step, count);
}
function asMetric(value) {
	return value ?? UNAVAILABLE;
}
/**
* Counts the advisory rows of the already-validated `analysis.recommendations`
* rider. The TUI shows the count only: no detail surface, no ordering, and a
* missing or malformed rider reads as `0`.
*/
function advisoryRecommendationCount(analysis) {
	const rows = analysis?.recommendations?.rows;
	if (!Array.isArray(rows)) return 0;
	let count = 0;
	for (const row of rows) if (row?.severity === "advisory") count += 1;
	return count;
}
/**
* Counts the advisory guardrail warnings the pure evaluator reports under
* `DEFAULT_GUARDRAILS`.
*
* The TUI has no per-user settings store: the browser's budgets live in
* localStorage and never travel across the RPC, so this panel deliberately
* evaluates the defaults and the status line says so. Only a full analysis
* shape is evaluated (the evaluator reads totals, turns, compactions, events
* and coverage); a truncated or malformed payload reads as `0` instead of
* throwing in the panel.
*/
function advisoryGuardrailCount(analysis) {
	if (!analysis || !Array.isArray(analysis.turns) || !Array.isArray(analysis.events) || !Array.isArray(analysis.compactions) || !analysis.totals || typeof analysis.totals !== "object" || !analysis.coverage || typeof analysis.coverage !== "object") return 0;
	try {
		return evaluateGuardrails(analysis, DEFAULT_GUARDRAILS).warnings.length;
	} catch {
		return 0;
	}
}
/**
* Validates an export response the same way `parseAnalysisResponse` validates
* the analysis: the payload crosses the RPC boundary, so it can arrive as the
* raw envelope (`{ output: … }`), the handler result (`{ filename, content, … }`)
* or something unexpected. Messages stay short and never echo payload text.
* The requested `sessionID` rides along so the caller can name the file after
* the session the prompt was actually rendered for.
*/
function parseReviewPromptResponse(response, sessionID) {
	let current = response;
	for (let depth = 0; depth < 4; depth++) {
		if (!isRecord(current)) break;
		if (typeof current.filename === "string" && typeof current.content === "string") return {
			ok: true,
			sessionID,
			filename: current.filename,
			content: current.content
		};
		if ("output" in current) {
			current = current.output;
			continue;
		}
		if ("error" in current) return {
			ok: false,
			error: "The review prompt request returned an error."
		};
		break;
	}
	return {
		ok: false,
		error: "The review prompt response was not recognized."
	};
}
function createStatisticsState(client) {
	const rpc = client.rpc(Observability);
	const [analysis, setAnalysis] = createSignal(null);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal(null);
	const [sessionID, setSessionID] = createSignal("");
	const [selectedIndex, setSelectedIndexSignal] = createSignal(0);
	const [expandedTurns, setExpandedTurns] = createSignal(/* @__PURE__ */ new Set());
	let request = 0;
	let liveTimer = null;
	let liveTarget = "";
	let liveInFlight = false;
	const totals = () => {
		const value = analysis();
		if (!value) return null;
		const source = value.totals;
		return {
			totalContext: asMetric(source?.finalContext),
			cacheHitRate: asMetric(source?.cacheHitRate),
			cost: asMetric(source?.cost),
			turns: typeof source?.turns === "number" ? source.turns : value.turns?.length ?? 0,
			recommendations: advisoryRecommendationCount(value),
			guardrails: advisoryGuardrailCount(value)
		};
	};
	const turns = () => analysis()?.turns ?? [];
	function setSelectedIndex(index) {
		setSelectedIndexSignal(clampIndex(index, turns().length));
	}
	function moveSelectionBy(delta) {
		setSelectedIndexSignal((current) => moveSelection(current, delta, turns().length));
	}
	/**
	* Toggles one turn's accordion row. Turns carry no per-turn transient view
	* state today, so there is nothing else to reset when a turn expands.
	*/
	function toggleTurnExpand(turnID) {
		const id = typeof turnID === "string" ? turnID.trim() : "";
		if (id.length === 0) return;
		setExpandedTurns((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}
	function isSelected(turn) {
		const list = turns();
		const index = selectedIndex();
		return index >= 0 && index < list.length && list[index] === turn;
	}
	/** Drops expanded ids that no longer exist and clamps the selection. */
	function reconcile(analysisValue) {
		const list = analysisValue.turns ?? [];
		setSelectedIndexSignal((current) => clampIndex(current, list.length));
		const alive = new Set(list.map((turn) => turn.id));
		setExpandedTurns((current) => {
			const next = new Set([...current].filter((id) => alive.has(id)));
			return next.size === current.size ? current : next;
		});
	}
	async function fetchAnalysis(nextSessionID) {
		const target = typeof nextSessionID === "string" ? nextSessionID.trim() : "";
		const ticket = ++request;
		const sameSession = target === untrack(sessionID);
		if (!sameSession) {
			setSelectedIndexSignal(0);
			setExpandedTurns(/* @__PURE__ */ new Set());
		}
		setSessionID(target);
		if (!sameSession) setAnalysis(null);
		setError(null);
		if (target.length === 0) {
			setLoading(false);
			setError("No session is selected.");
			return;
		}
		setLoading(true);
		try {
			const response = await rpc.analysis({ sessionID: target });
			if (ticket !== request) return;
			const parsed = parseAnalysisResponse(response);
			if (!parsed.ok) {
				if (!sameSession) setAnalysis(null);
				setError(parsed.message);
				return;
			}
			reconcile(parsed.analysis);
			setAnalysis(parsed.analysis);
		} catch {
			if (ticket !== request) return;
			if (!sameSession) setAnalysis(null);
			setError("The analysis could not be loaded. Reopen the panel to retry.");
		} finally {
			if (ticket === request) setLoading(false);
		}
	}
	/** Clears the live poll timer and its in-flight guard. */
	function stopLivePolling() {
		if (liveTimer !== null) {
			clearInterval(liveTimer);
			liveTimer = null;
		}
		liveTarget = "";
		liveInFlight = false;
	}
	/**
	* Re-fetches the current analysis every `LIVE_POLL_MS` while the panel is
	* open. The RPC is the existing `analysis` one — no new surface — and one
	* request at a time keeps a slow host from piling up polls. A settled
	* session (terminal outcome, nothing busy, no running turn) stops the timer:
	* there is nothing left to re-fetch.
	*/
	function startLivePolling(nextSessionID) {
		stopLivePolling();
		const target = typeof nextSessionID === "string" ? nextSessionID.trim() : "";
		if (target.length === 0) return;
		liveTarget = target;
		liveTimer = setInterval(() => {
			if (liveInFlight) return;
			liveInFlight = true;
			fetchAnalysis(liveTarget).finally(() => {
				liveInFlight = false;
				if (isSettledAnalysis(analysis())) stopLivePolling();
			});
		}, LIVE_POLL_MS);
	}
	async function fetchReviewPrompt() {
		const target = sessionID().trim();
		if (target.length === 0) return {
			ok: false,
			error: "No session is selected."
		};
		try {
			return parseReviewPromptResponse(await rpc.export({
				sessionID: target,
				format: "digest",
				prompt: true
			}), target);
		} catch {
			return {
				ok: false,
				error: "The review prompt could not be generated."
			};
		}
	}
	return {
		analysis,
		loading,
		error,
		sessionID,
		selectedIndex,
		expandedTurns,
		totals,
		turns,
		setSelectedIndex,
		moveSelection: moveSelectionBy,
		toggleTurnExpand,
		isSelected,
		fetchAnalysis,
		startLivePolling,
		stopLivePolling,
		fetchReviewPrompt
	};
}
var LIVE_POLL_MS, UNAVAILABLE;
var init_state$1 = __esmMin((() => {
	init_guardrails();
	init_rpc();
	init_analysisResponse();
	init_polling();
	LIVE_POLL_MS = 5e3;
	UNAVAILABLE = {
		value: null,
		basis: "unavailable"
	};
}));
// src/plugin/tui/statistics/StatisticsView.tsx
var StatisticsView_exports = /* @__PURE__ */ __exportAll({
	StatisticsView: () => StatisticsView,
	statisticsPanelElement: () => statisticsPanelElement
});
function colorOf$1(palette, key) {
	return palette[key] ?? palette.text ?? palette.text2 ?? FALLBACK_FOREGROUND$1;
}
function backgroundOf$1(palette) {
	return palette.page ?? FALLBACK_BACKGROUND$1;
}
function bannerMetric(metric, formatter) {
	if (!metric || metric.value === null || !Number.isFinite(metric.value)) return "—";
	return `${formatter(metric.value)} ${basisMark(metric.basis)}`;
}
/**
* `SessionMeta` carries no `status` or `active` field, so the badge uses its
* recorded `outcome` first and falls back to the most recent turn status.
*/
function sessionStatus(analysis) {
	const outcome = analysis.session?.outcome;
	if (outcome === "succeeded") return "completed";
	if (outcome === "failed") return "error";
	if (outcome === "interrupted") return "interrupted";
	const turns = analysis.turns ?? [];
	return turns[turns.length - 1]?.status ?? "unknown";
}
function Banner(props) {
	const status = () => statusMark(sessionStatus(props.analysis));
	const sessionID = () => props.analysis.session?.id ?? "unknown session";
	const turnCount = () => props.totals?.turns ?? props.analysis.turns?.length ?? 0;
	return (() => {
		var _el$ = createElement("box"), _el$2 = createElement("box"), _el$3 = createElement("text"), _el$5 = createElement("text"), _el$6 = createElement("text"), _el$9 = createElement("text"), _el$0 = createElement("box"), _el$1 = createElement("text"), _el$10 = createElement("text"), _el$11 = createElement("text"), _el$12 = createElement("text"), _el$13 = createElement("text");
		insertNode(_el$, _el$2);
		insertNode(_el$, _el$0);
		setProp(_el$, "flexDirection", "column");
		setProp(_el$, "flexShrink", 0);
		setProp(_el$, "marginBottom", 1);
		insertNode(_el$2, _el$3);
		insertNode(_el$2, _el$5);
		insertNode(_el$2, _el$6);
		insertNode(_el$2, _el$9);
		setProp(_el$2, "flexDirection", "row");
		setProp(_el$2, "gap", 1);
		insertNode(_el$3, createTextNode(`Session`));
		insert(_el$5, sessionID);
		insert(_el$6, () => `${status().symbol} ${status().label}`);
		insert(_el$2, createComponent(Show, {
			get when() {
				return props.analysis.redacted;
			},
			get children() {
				var _el$7 = createElement("text");
				insertNode(_el$7, createTextNode(`redacted`));
				effect((_$p) => setProp(_el$7, "fg", colorOf$1(props.palette, "warning"), _$p));
				return _el$7;
			}
		}), _el$9);
		insert(_el$9, () => `${turnCount()} turns`);
		insertNode(_el$0, _el$1);
		insertNode(_el$0, _el$10);
		insertNode(_el$0, _el$11);
		insertNode(_el$0, _el$12);
		insertNode(_el$0, _el$13);
		setProp(_el$0, "flexDirection", "row");
		setProp(_el$0, "gap", 2);
		insert(_el$1, () => `Context ${bannerMetric(props.totals?.totalContext, formatNumber)}`);
		insert(_el$10, () => `Cache hit ${bannerMetric(props.totals?.cacheHitRate, formatPercent)}`);
		insert(_el$11, () => `Cost ${bannerMetric(props.totals?.cost, formatCost)}`);
		insert(_el$12, () => recommendationsStatusLine(props.totals?.recommendations ?? 0));
		insert(_el$13, () => guardrailsStatusLine(props.totals?.guardrails ?? 0));
		effect((_p$) => {
			var _v$ = colorOf$1(props.palette, "text2"), _v$2 = colorOf$1(props.palette, "text"), _v$3 = colorOf$1(props.palette, status().paletteKey), _v$4 = colorOf$1(props.palette, "muted"), _v$5 = colorOf$1(props.palette, "text"), _v$6 = colorOf$1(props.palette, "text"), _v$7 = colorOf$1(props.palette, "text"), _v$8 = colorOf$1(props.palette, "text2"), _v$9 = colorOf$1(props.palette, "text2");
			_v$ !== _p$.e && (_p$.e = setProp(_el$3, "fg", _v$, _p$.e));
			_v$2 !== _p$.t && (_p$.t = setProp(_el$5, "fg", _v$2, _p$.t));
			_v$3 !== _p$.a && (_p$.a = setProp(_el$6, "fg", _v$3, _p$.a));
			_v$4 !== _p$.o && (_p$.o = setProp(_el$9, "fg", _v$4, _p$.o));
			_v$5 !== _p$.i && (_p$.i = setProp(_el$1, "fg", _v$5, _p$.i));
			_v$6 !== _p$.n && (_p$.n = setProp(_el$10, "fg", _v$6, _p$.n));
			_v$7 !== _p$.s && (_p$.s = setProp(_el$11, "fg", _v$7, _p$.s));
			_v$8 !== _p$.h && (_p$.h = setProp(_el$12, "fg", _v$8, _p$.h));
			_v$9 !== _p$.r && (_p$.r = setProp(_el$13, "fg", _v$9, _p$.r));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0,
			o: void 0,
			i: void 0,
			n: void 0,
			s: void 0,
			h: void 0,
			r: void 0
		});
		return _el$;
	})();
}
function StateMessage$1(props) {
	return (() => {
		var _el$14 = createElement("box");
		setProp(_el$14, "flexDirection", "column");
		setProp(_el$14, "flexGrow", 1);
		setProp(_el$14, "justifyContent", "center");
		setProp(_el$14, "alignItems", "center");
		insert(_el$14, createComponent(Show, {
			get when() {
				return props.state.loading();
			},
			get children() {
				var _el$15 = createElement("text");
				insertNode(_el$15, createTextNode(`Loading…`));
				effect((_$p) => setProp(_el$15, "fg", colorOf$1(props.palette, "muted"), _$p));
				return _el$15;
			}
		}), null);
		insert(_el$14, createComponent(Show, {
			get when() {
				return memo(() => !!!props.state.loading())() && props.state.error();
			},
			get children() {
				return [(() => {
					var _el$17 = createElement("text");
					insert(_el$17, () => props.state.error());
					effect((_$p) => setProp(_el$17, "fg", colorOf$1(props.palette, "critical"), _$p));
					return _el$17;
				})(), (() => {
					var _el$18 = createElement("text");
					insertNode(_el$18, createTextNode(`Reopen the panel to retry.`));
					effect((_$p) => setProp(_el$18, "fg", colorOf$1(props.palette, "muted"), _$p));
					return _el$18;
				})()];
			}
		}), null);
		insert(_el$14, createComponent(Show, {
			get when() {
				return memo(() => !!!props.state.loading())() && !props.state.error();
			},
			get children() {
				var _el$20 = createElement("text");
				insertNode(_el$20, createTextNode(`Preparing…`));
				effect((_$p) => setProp(_el$20, "fg", colorOf$1(props.palette, "muted"), _$p));
				return _el$20;
			}
		}), null);
		return _el$14;
	})();
}
function Table(props) {
	return createComponent(Show, {
		get when() {
			return props.turns.length > 0;
		},
		get fallback() {
			return (() => {
				var _el$24 = createElement("text");
				insertNode(_el$24, createTextNode(`No turns for this session.`));
				effect((_$p) => setProp(_el$24, "fg", colorOf$1(props.palette, "muted"), _$p));
				return _el$24;
			})();
		},
		get children() {
			return [(() => {
				var _el$22 = createElement("text");
				setProp(_el$22, "wrapMode", "none");
				insert(_el$22, () => formatHeader(props.layout.columns));
				effect((_$p) => setProp(_el$22, "fg", colorOf$1(props.palette, "text2"), _$p));
				return _el$22;
			})(), (() => {
				var _el$23 = createElement("scrollbox");
				setProp(_el$23, "flexGrow", 1);
				setProp(_el$23, "scrollY", true);
				insert(_el$23, createComponent(For, {
					get each() {
						return props.turns;
					},
					children: (turn) => {
						const selected = () => props.isSelected(turn);
						const expanded = () => props.expanded.has(turn.id);
						const row = () => formatRow(turn, props.layout.columns, selected(), expanded());
						return [(() => {
							var _el$26 = createElement("box"), _el$27 = createElement("text"), _el$28 = createElement("text");
							insertNode(_el$26, _el$27);
							insertNode(_el$26, _el$28);
							setProp(_el$26, "flexDirection", "row");
							setProp(_el$27, "wrapMode", "none");
							insert(_el$27, () => row().prefix);
							setProp(_el$28, "wrapMode", "none");
							insert(_el$28, () => row().status);
							effect((_p$) => {
								var _v$0 = colorOf$1(props.palette, selected() ? "accent" : "text"), _v$1 = colorOf$1(props.palette, statusMark(turn.status).paletteKey);
								_v$0 !== _p$.e && (_p$.e = setProp(_el$27, "fg", _v$0, _p$.e));
								_v$1 !== _p$.t && (_p$.t = setProp(_el$28, "fg", _v$1, _p$.t));
								return _p$;
							}, {
								e: void 0,
								t: void 0
							});
							return _el$26;
						})(), createComponent(Show, {
							get when() {
								return memo(() => !!expanded())() && (turn.steps?.length ?? 0) > 0;
							},
							get children() {
								return createComponent(For, {
									get each() {
										return turn.steps ?? [];
									},
									children: (step) => {
										const stepRow = () => formatStepRow(step, props.layout.width);
										return (() => {
											var _el$29 = createElement("box"), _el$30 = createElement("text"), _el$31 = createElement("text");
											insertNode(_el$29, _el$30);
											insertNode(_el$29, _el$31);
											setProp(_el$29, "flexDirection", "row");
											setProp(_el$30, "wrapMode", "none");
											insert(_el$30, () => stepRow().prefix);
											setProp(_el$31, "wrapMode", "none");
											insert(_el$31, () => stepRow().status);
											effect((_p$) => {
												var _v$10 = colorOf$1(props.palette, "text2"), _v$11 = colorOf$1(props.palette, statusMark(step.status).paletteKey);
												_v$10 !== _p$.e && (_p$.e = setProp(_el$30, "fg", _v$10, _p$.e));
												_v$11 !== _p$.t && (_p$.t = setProp(_el$31, "fg", _v$11, _p$.t));
												return _p$;
											}, {
												e: void 0,
												t: void 0
											});
											return _el$29;
										})();
									}
								});
							}
						})];
					}
				}));
				effect((_$p) => setProp(_el$23, "backgroundColor", backgroundOf$1(props.palette), _$p));
				return _el$23;
			})()];
		}
	});
}
function StatisticsPanel(props) {
	const context = usePlugin();
	const state = createStatisticsState(context.client);
	const palette = createMemo(() => themePalette(context) ?? {});
	const currentLayout = createMemo(() => resolveLayout(props.width));
	const keyboardHandlers = {
		moveSelection: (delta) => state.moveSelection(delta),
		toggleExpand: () => {
			const turn = state.turns()[state.selectedIndex()];
			if (turn) state.toggleTurnExpand(turn.id);
		},
		reviewPrompt: () => {
			writeReviewPrompt();
		}
	};
	/**
	* Always redacted by construction: `fetchReviewPrompt` never sends `reveal`.
	* The TUI host has no clipboard, so the prompt is delivered as one
	* deterministic temp file and the toast carries its path.
	*/
	async function writeReviewPrompt() {
		const outcome = await state.fetchReviewPrompt();
		if (!outcome.ok) {
			context.ui.toast.show({
				message: outcome.error,
				variant: "error"
			});
			return;
		}
		const path = reviewPromptFilePath(tmpdir(), outcome.sessionID);
		try {
			await writeReviewPromptFile(path, outcome.content);
		} catch {
			context.ui.toast.show({
				message: "The review prompt file could not be written.",
				variant: "error"
			});
			return;
		}
		context.ui.toast.show({
			message: `Review prompt written to ${path}`,
			variant: "success"
		});
	}
	onMount(() => {
		props.keyboard.handlers = keyboardHandlers;
	});
	onCleanup(() => {
		state.stopLivePolling();
		if (props.keyboard.handlers === keyboardHandlers) {
			props.keyboard.handlers = null;
			props.keyboard.focused = null;
		}
	});
	createEffect(() => {
		props.keyboard.focused = bridgeFocus(props.focused);
	});
	createEffect(() => {
		const sessionID = props.sessionID;
		state.fetchAnalysis(sessionID);
		state.startLivePolling(sessionID);
	});
	return (() => {
		var _el$32 = createElement("box");
		setProp(_el$32, "flexDirection", "column");
		setProp(_el$32, "flexGrow", 1);
		setProp(_el$32, "padding", 1);
		insert(_el$32, createComponent(Show, {
			get when() {
				return state.analysis();
			},
			get fallback() {
				return createComponent(StateMessage$1, {
					state,
					get palette() {
						return palette();
					}
				});
			},
			children: (analysis) => [createComponent(Banner, {
				get analysis() {
					return analysis();
				},
				get totals() {
					return state.totals();
				},
				get palette() {
					return palette();
				}
			}), createComponent(Show, {
				get when() {
					return state.loading();
				},
				get fallback() {
					return createComponent(Table, {
						get layout() {
							return currentLayout();
						},
						get turns() {
							return state.turns();
						},
						get isSelected() {
							return state.isSelected;
						},
						get expanded() {
							return state.expandedTurns();
						},
						get palette() {
							return palette();
						}
					});
				},
				get children() {
					var _el$33 = createElement("text");
					insertNode(_el$33, createTextNode(`Loading…`));
					effect((_$p) => setProp(_el$33, "fg", colorOf$1(palette(), "muted"), _$p));
					return _el$33;
				}
			})]
		}));
		effect((_$p) => setProp(_el$32, "backgroundColor", backgroundOf$1(palette()), _$p));
		return _el$32;
	})();
}
function StatisticsView(props) {
	return createComponent(PluginContextProvider, {
		get value() {
			return props.context;
		},
		get children() {
			return createComponent(StatisticsPanel, {
				get sessionID() {
					return props.sessionID;
				},
				get width() {
					return props.width;
				},
				get focused() {
					return props.focused;
				},
				get keyboard() {
					return props.keyboard;
				}
			});
		}
	});
}
/**
* Slot render body. The host renders slot claims outside the plugin's own
* Solid root, so the plugin context is re-provided here.
*/
function statisticsPanelElement(context, input, keyboard) {
	return createComponent(StatisticsView, {
		context,
		get sessionID() {
			return input.sessionID;
		},
		get width() {
			return input.width;
		},
		get focused() {
			return input.focused;
		},
		keyboard
	});
}
var FALLBACK_FOREGROUND$1, FALLBACK_BACKGROUND$1;
var init_StatisticsView = __esmMin((() => {
	init_format();
	init_tui();
	init_digestFile();
	init_columns();
	init_status();
	init_stepRows();
	init_state$1();
	FALLBACK_FOREGROUND$1 = "#ffffff";
	FALLBACK_BACKGROUND$1 = "#000000";
}));
// src/plugin/tui/trajectory/state.ts
function createTrajectoryState(client) {
	const rpc = client.rpc(Observability);
	const [analysis, setAnalysis] = createSignal(null);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal(null);
	const [sessionID, setSessionID] = createSignal("");
	const [selectedIndex, setSelectedIndexSignal] = createSignal(0);
	const [expandedTurns, setExpandedTurns] = createSignal(/* @__PURE__ */ new Set());
	let request = 0;
	let liveTimer = null;
	let liveTarget = "";
	let liveInFlight = false;
	const turns = () => analysis()?.turns ?? [];
	function setSelectedIndex(index) {
		setSelectedIndexSignal(clampIndex(index, turns().length));
	}
	function moveSelectionBy(delta) {
		setSelectedIndexSignal((current) => moveSelection(current, delta, turns().length));
	}
	function toggleTurnExpand(turnID) {
		const id = typeof turnID === "string" ? turnID.trim() : "";
		if (id.length === 0) return;
		setExpandedTurns((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}
	function isSelected(turn) {
		const list = turns();
		const index = selectedIndex();
		return index >= 0 && index < list.length && list[index] === turn;
	}
	/** Drops expanded ids that no longer exist and clamps the selection. */
	function reconcile(analysisValue) {
		const list = analysisValue.turns ?? [];
		setSelectedIndexSignal((current) => clampIndex(current, list.length));
		const alive = new Set(list.map((turn) => turn.id));
		setExpandedTurns((current) => {
			const next = new Set([...current].filter((id) => alive.has(id)));
			return next.size === current.size ? current : next;
		});
	}
	async function fetchAnalysis(nextSessionID) {
		const target = typeof nextSessionID === "string" ? nextSessionID.trim() : "";
		const ticket = ++request;
		const sameSession = target === untrack(sessionID);
		if (!sameSession) {
			setSelectedIndexSignal(0);
			setExpandedTurns(/* @__PURE__ */ new Set());
		}
		setSessionID(target);
		if (!sameSession) setAnalysis(null);
		setError(null);
		if (target.length === 0) {
			setLoading(false);
			setError("No session is selected.");
			return;
		}
		setLoading(true);
		try {
			const response = await rpc.analysis({ sessionID: target });
			if (ticket !== request) return;
			const parsed = parseAnalysisResponse(response);
			if (!parsed.ok) {
				if (!sameSession) setAnalysis(null);
				setError(parsed.message);
				return;
			}
			reconcile(parsed.analysis);
			setAnalysis(parsed.analysis);
		} catch {
			if (ticket !== request) return;
			if (!sameSession) setAnalysis(null);
			setError("The analysis could not be loaded. Reopen the panel to retry.");
		} finally {
			if (ticket === request) setLoading(false);
		}
	}
	/** Clears the live poll timer and its in-flight guard. */
	function stopLivePolling() {
		if (liveTimer !== null) {
			clearInterval(liveTimer);
			liveTimer = null;
		}
		liveTarget = "";
		liveInFlight = false;
	}
	/**
	* Re-fetches the current analysis every `LIVE_POLL_MS` while the panel is
	* open. The RPC is the existing `analysis` one — no new surface — and one
	* request at a time keeps a slow host from piling up polls. A settled
	* session (terminal outcome, nothing busy, no running turn) stops the timer:
	* there is nothing left to re-fetch.
	*/
	function startLivePolling(nextSessionID) {
		stopLivePolling();
		const target = typeof nextSessionID === "string" ? nextSessionID.trim() : "";
		if (target.length === 0) return;
		liveTarget = target;
		liveTimer = setInterval(() => {
			if (liveInFlight) return;
			liveInFlight = true;
			fetchAnalysis(liveTarget).finally(() => {
				liveInFlight = false;
				if (isSettledAnalysis(analysis())) stopLivePolling();
			});
		}, LIVE_POLL_MS);
	}
	return {
		analysis,
		loading,
		error,
		sessionID,
		selectedIndex,
		expandedTurns,
		turns,
		setSelectedIndex,
		moveSelection: moveSelectionBy,
		toggleTurnExpand,
		isSelected,
		fetchAnalysis,
		startLivePolling,
		stopLivePolling
	};
}
var init_state = __esmMin((() => {
	init_rpc();
	init_analysisResponse();
	init_polling();
	init_state$1();
}));
// src/plugin/tui/trajectory/TrajectoryView.tsx
var TrajectoryView_exports = /* @__PURE__ */ __exportAll({
	TrajectoryView: () => TrajectoryView,
	trajectoryPanelElement: () => trajectoryPanelElement
});
function colorOf(palette, key) {
	return palette[key] ?? palette.text ?? palette.text2 ?? FALLBACK_FOREGROUND;
}
function backgroundOf(palette) {
	return palette.page ?? FALLBACK_BACKGROUND;
}
function Header(props) {
	const sessionID = () => props.analysis.session?.id ?? "unknown session";
	return (() => {
		var _el$ = createElement("box"), _el$2 = createElement("box"), _el$3 = createElement("text"), _el$5 = createElement("text"), _el$8 = createElement("text"), _el$9 = createElement("text");
		insertNode(_el$, _el$2);
		insertNode(_el$, _el$9);
		setProp(_el$, "flexDirection", "column");
		setProp(_el$, "flexShrink", 0);
		setProp(_el$, "marginBottom", 1);
		insertNode(_el$2, _el$3);
		insertNode(_el$2, _el$5);
		insertNode(_el$2, _el$8);
		setProp(_el$2, "flexDirection", "row");
		setProp(_el$2, "gap", 1);
		insertNode(_el$3, createTextNode(`Session`));
		insert(_el$5, sessionID);
		insert(_el$2, createComponent(Show, {
			get when() {
				return props.analysis.redacted;
			},
			get children() {
				var _el$6 = createElement("text");
				insertNode(_el$6, createTextNode(`redacted`));
				effect((_$p) => setProp(_el$6, "fg", colorOf(props.palette, "warning"), _$p));
				return _el$6;
			}
		}), _el$8);
		insert(_el$8, () => `${props.turns} turns`);
		insertNode(_el$9, createTextNode(`Turn ledger · expand a turn to see its steps`));
		effect((_p$) => {
			var _v$ = colorOf(props.palette, "text2"), _v$2 = colorOf(props.palette, "text"), _v$3 = colorOf(props.palette, "muted"), _v$4 = colorOf(props.palette, "muted");
			_v$ !== _p$.e && (_p$.e = setProp(_el$3, "fg", _v$, _p$.e));
			_v$2 !== _p$.t && (_p$.t = setProp(_el$5, "fg", _v$2, _p$.t));
			_v$3 !== _p$.a && (_p$.a = setProp(_el$8, "fg", _v$3, _p$.a));
			_v$4 !== _p$.o && (_p$.o = setProp(_el$9, "fg", _v$4, _p$.o));
			return _p$;
		}, {
			e: void 0,
			t: void 0,
			a: void 0,
			o: void 0
		});
		return _el$;
	})();
}
function StateMessage(props) {
	return (() => {
		var _el$1 = createElement("box");
		setProp(_el$1, "flexDirection", "column");
		setProp(_el$1, "flexGrow", 1);
		setProp(_el$1, "justifyContent", "center");
		setProp(_el$1, "alignItems", "center");
		insert(_el$1, createComponent(Show, {
			get when() {
				return props.state.loading();
			},
			get children() {
				var _el$10 = createElement("text");
				insertNode(_el$10, createTextNode(`Loading…`));
				effect((_$p) => setProp(_el$10, "fg", colorOf(props.palette, "muted"), _$p));
				return _el$10;
			}
		}), null);
		insert(_el$1, createComponent(Show, {
			get when() {
				return memo(() => !!!props.state.loading())() && props.state.error();
			},
			get children() {
				return [(() => {
					var _el$12 = createElement("text");
					insert(_el$12, () => props.state.error());
					effect((_$p) => setProp(_el$12, "fg", colorOf(props.palette, "critical"), _$p));
					return _el$12;
				})(), (() => {
					var _el$13 = createElement("text");
					insertNode(_el$13, createTextNode(`Reopen the panel to retry.`));
					effect((_$p) => setProp(_el$13, "fg", colorOf(props.palette, "muted"), _$p));
					return _el$13;
				})()];
			}
		}), null);
		insert(_el$1, createComponent(Show, {
			get when() {
				return memo(() => !!!props.state.loading())() && !props.state.error();
			},
			get children() {
				var _el$15 = createElement("text");
				insertNode(_el$15, createTextNode(`Preparing…`));
				effect((_$p) => setProp(_el$15, "fg", colorOf(props.palette, "muted"), _$p));
				return _el$15;
			}
		}), null);
		return _el$1;
	})();
}
/**
* Turn ledger with the per-turn step accordion. Rows come from the same pure
* formatters the statistics table uses, so both panels stay aligned.
*/
function TurnLedger(props) {
	return createComponent(Show, {
		get when() {
			return props.turns.length > 0;
		},
		get fallback() {
			return (() => {
				var _el$19 = createElement("text");
				insertNode(_el$19, createTextNode(`No turns for this session.`));
				effect((_$p) => setProp(_el$19, "fg", colorOf(props.palette, "muted"), _$p));
				return _el$19;
			})();
		},
		get children() {
			return [(() => {
				var _el$17 = createElement("text");
				setProp(_el$17, "wrapMode", "none");
				insert(_el$17, () => formatHeader(props.layout.columns));
				effect((_$p) => setProp(_el$17, "fg", colorOf(props.palette, "text2"), _$p));
				return _el$17;
			})(), (() => {
				var _el$18 = createElement("scrollbox");
				setProp(_el$18, "flexGrow", 1);
				setProp(_el$18, "scrollY", true);
				insert(_el$18, createComponent(For, {
					get each() {
						return props.turns;
					},
					children: (turn) => {
						const selected = () => props.isSelected(turn);
						const expanded = () => props.expanded.has(turn.id);
						const row = () => formatRow(turn, props.layout.columns, selected(), expanded());
						return [(() => {
							var _el$21 = createElement("box"), _el$22 = createElement("text"), _el$23 = createElement("text");
							insertNode(_el$21, _el$22);
							insertNode(_el$21, _el$23);
							setProp(_el$21, "flexDirection", "row");
							setProp(_el$22, "wrapMode", "none");
							insert(_el$22, () => row().prefix);
							setProp(_el$23, "wrapMode", "none");
							insert(_el$23, () => row().status);
							effect((_p$) => {
								var _v$5 = colorOf(props.palette, selected() ? "accent" : "text"), _v$6 = colorOf(props.palette, statusMark(turn.status).paletteKey);
								_v$5 !== _p$.e && (_p$.e = setProp(_el$22, "fg", _v$5, _p$.e));
								_v$6 !== _p$.t && (_p$.t = setProp(_el$23, "fg", _v$6, _p$.t));
								return _p$;
							}, {
								e: void 0,
								t: void 0
							});
							return _el$21;
						})(), createComponent(Show, {
							get when() {
								return memo(() => !!expanded())() && (turn.steps?.length ?? 0) > 0;
							},
							get children() {
								return createComponent(For, {
									get each() {
										return turn.steps ?? [];
									},
									children: (step) => {
										const stepRow = () => formatStepRow(step, props.layout.width);
										return (() => {
											var _el$24 = createElement("box"), _el$25 = createElement("text"), _el$26 = createElement("text");
											insertNode(_el$24, _el$25);
											insertNode(_el$24, _el$26);
											setProp(_el$24, "flexDirection", "row");
											setProp(_el$25, "wrapMode", "none");
											insert(_el$25, () => stepRow().prefix);
											setProp(_el$26, "wrapMode", "none");
											insert(_el$26, () => stepRow().status);
											effect((_p$) => {
												var _v$7 = colorOf(props.palette, "text2"), _v$8 = colorOf(props.palette, statusMark(step.status).paletteKey);
												_v$7 !== _p$.e && (_p$.e = setProp(_el$25, "fg", _v$7, _p$.e));
												_v$8 !== _p$.t && (_p$.t = setProp(_el$26, "fg", _v$8, _p$.t));
												return _p$;
											}, {
												e: void 0,
												t: void 0
											});
											return _el$24;
										})();
									}
								});
							}
						})];
					}
				}));
				effect((_$p) => setProp(_el$18, "backgroundColor", backgroundOf(props.palette), _$p));
				return _el$18;
			})()];
		}
	});
}
function TrajectoryPanel(props) {
	const context = usePlugin();
	const state = createTrajectoryState(context.client);
	const palette = createMemo(() => themePalette(context) ?? {});
	const currentLayout = createMemo(() => resolveLayout(props.width));
	const keyboardHandlers = {
		moveSelection: (delta) => state.moveSelection(delta),
		toggleExpand: () => {
			const turn = state.turns()[state.selectedIndex()];
			if (turn) state.toggleTurnExpand(turn.id);
		}
	};
	onMount(() => {
		props.keyboard.handlers = keyboardHandlers;
	});
	onCleanup(() => {
		state.stopLivePolling();
		if (props.keyboard.handlers === keyboardHandlers) {
			props.keyboard.handlers = null;
			props.keyboard.focused = null;
		}
	});
	createEffect(() => {
		props.keyboard.focused = bridgeFocus(props.focused);
	});
	createEffect(() => {
		const sessionID = props.sessionID;
		state.fetchAnalysis(sessionID);
		state.startLivePolling(sessionID);
	});
	return (() => {
		var _el$27 = createElement("box");
		setProp(_el$27, "flexDirection", "column");
		setProp(_el$27, "flexGrow", 1);
		setProp(_el$27, "padding", 1);
		insert(_el$27, createComponent(Show, {
			get when() {
				return state.analysis();
			},
			get fallback() {
				return createComponent(StateMessage, {
					state,
					get palette() {
						return palette();
					}
				});
			},
			children: (analysis) => [createComponent(Header, {
				get analysis() {
					return analysis();
				},
				get turns() {
					return state.turns().length;
				},
				get palette() {
					return palette();
				}
			}), createComponent(Show, {
				get when() {
					return state.loading();
				},
				get fallback() {
					return createComponent(TurnLedger, {
						get layout() {
							return currentLayout();
						},
						get turns() {
							return state.turns();
						},
						get isSelected() {
							return state.isSelected;
						},
						get expanded() {
							return state.expandedTurns();
						},
						get palette() {
							return palette();
						}
					});
				},
				get children() {
					var _el$28 = createElement("text");
					insertNode(_el$28, createTextNode(`Loading…`));
					effect((_$p) => setProp(_el$28, "fg", colorOf(palette(), "muted"), _$p));
					return _el$28;
				}
			})]
		}));
		effect((_$p) => setProp(_el$27, "backgroundColor", backgroundOf(palette()), _$p));
		return _el$27;
	})();
}
function TrajectoryView(props) {
	return createComponent(PluginContextProvider, {
		get value() {
			return props.context;
		},
		get children() {
			return createComponent(TrajectoryPanel, {
				get sessionID() {
					return props.sessionID;
				},
				get width() {
					return props.width;
				},
				get focused() {
					return props.focused;
				},
				get keyboard() {
					return props.keyboard;
				}
			});
		}
	});
}
/**
* Slot render body. The host renders slot claims outside the plugin's own
* Solid root, so the plugin context is re-provided here.
*/
function trajectoryPanelElement(context, input, keyboard) {
	return createComponent(TrajectoryView, {
		context,
		get sessionID() {
			return input.sessionID;
		},
		get width() {
			return input.width;
		},
		get focused() {
			return input.focused;
		},
		keyboard
	});
}
var FALLBACK_FOREGROUND, FALLBACK_BACKGROUND;
var init_TrajectoryView = __esmMin((() => {
	init_tui();
	init_columns();
	init_status();
	init_stepRows();
	init_state();
	FALLBACK_FOREGROUND = "#ffffff";
	FALLBACK_BACKGROUND = "#000000";
}));
// src/plugin/tui/statusBadge.tsx
var statusBadge_exports = /* @__PURE__ */ __exportAll({ statusBadgeElement: () => statusBadgeElement });
function StatusBadge(props) {
	const [line, setLine] = createSignal(null);
	let lastSessionID;
	createEffect(() => {
		const sessionID = props.input.sessionID;
		let active = true;
		onCleanup(() => {
			active = false;
		});
		if (badgeLineInvalidated(lastSessionID, sessionID)) {
			lastSessionID = sessionID;
			setLine(null);
		}
		statusBadgeText(props.context, sessionID).then((text) => {
			if (active) setLine(text);
		});
	});
	return createComponent(Show, {
		get when() {
			return line();
		},
		get children() {
			var _el$ = createElement("text");
			insert(_el$, line);
			return _el$;
		}
	});
}
/**
* `prompt.footer.status` render body (issue #6, decision D3). It shows exactly
* one line and nothing when the host passes no session id. Visibility is owned
* by the host (`showDetails`); the badge never toasts and never throws.
*
* The data path is `statusBadgeText` in `tui-status.ts`; that module owns the
* cached fetch and the formatter, which keeps this component JSX-only and lets
* the Node test suite cover the behaviour without a JSX loader.
*/
function statusBadgeElement(context, input) {
	return createComponent(StatusBadge, {
		context,
		input
	});
}
var init_statusBadge = __esmMin((() => {
	init_tui_status();
}));
// src/plugin/tui.ts
/**
* Native-first opener shared by `/statistics`, `/trajectory` and
* `/observability`: open the panel, or toast once and hand over to the browser.
* It mirrors the issue-9 fallback: one toast, then the existing browser path,
* which reports its own success or start-up failure.
*/
function openPanelOrFallback(panel, open, toast, browserFallback) {
	if (open()) return true;
	const copy = PANEL_FALLBACK[panel];
	toast({
		title: "Session observability",
		message: copy.message,
		variant: copy.variant,
		duration: 6e3
	});
	browserFallback();
	return false;
}
/**
* Normalizes the host's `PanelInput.focused` for a bridge: only a real boolean
* is authoritative. `undefined` (an older host that does not publish the field)
* stays `null`, leaving the panel-name gate as the floor.
*/
function bridgeFocus(value) {
	return typeof value === "boolean" ? value : null;
}
function activePanelKeyboard(name, bridges) {
	const bridge = name === "statistics" ? bridges.statistics : name === "trajectory" ? bridges.trajectory : null;
	if (!bridge) return null;
	return bridge.focused === false ? null : bridge;
}
/**
* Panel-scoped navigation commands, shared by both native panels. Every
* dispatch re-resolves the gate instead of trusting the layer's `enabled`
* evaluation: if focus moved away (or the panel closed) in between, the key is
* a no-op. `escape` follows the same rule as `j`/`k`/`Enter`, so a stale
* enabled layer cannot close a panel the user is not driving.
*/
function panelKeymapCommands(active, close) {
	return [
		{
			id: "panel.moveDown",
			title: "Session panel: select next turn",
			group: "Session panel",
			bind: "j,down",
			run: () => {
				active()?.handlers?.moveSelection(1);
			}
		},
		{
			id: "panel.moveUp",
			title: "Session panel: select previous turn",
			group: "Session panel",
			bind: "k,up",
			run: () => {
				active()?.handlers?.moveSelection(-1);
			}
		},
		{
			id: "panel.toggleExpand",
			title: "Session panel: expand or collapse the selected turn",
			group: "Session panel",
			bind: "return",
			run: () => {
				active()?.handlers?.toggleExpand();
			}
		},
		{
			id: "panel.reviewPrompt",
			title: "Session panel: write the LLM review prompt to a file",
			group: "Session panel",
			bind: "d",
			run: () => {
				active()?.handlers?.reviewPrompt?.();
			}
		},
		{
			id: "panel.close",
			title: "Session panel: close the panel",
			group: "Session panel",
			bind: "escape",
			run: () => {
				if (active()) close();
			}
		}
	];
}
/**
* Classifies the raw `/statistics` or `/trajectory` argument. Only the
* documented browser tokens select the web UI; everything else (empty,
* whitespace, non-string) keeps the native route.
*/
function parseStatsArg(input) {
	if (typeof input !== "string") return "native";
	return WEB_FLAGS.has(input.trim().toLowerCase()) ? "web" : "native";
}
/**
* Builds the read-only Observability command surface. Pure: the caller
* supplies the view opener and the two native panel openers, so tests can scan
* the surface — and the `/statistics` and `/trajectory` routing — without the
* SDK.
*/
function tuiCommandDefinitions(openView, openNative = (browserFallback) => browserFallback(), openNativeTrajectory = (browserFallback) => browserFallback()) {
	const openStatistics = (input) => {
		if (parseStatsArg(input) === "web") return openView("statistics");
		return openNative(() => openView("statistics"));
	};
	const openTrajectory = (input) => {
		if (parseStatsArg(input) === "web") return openView("trajectory");
		return openNativeTrajectory(() => openView("trajectory"));
	};
	return [
		{
			id: "observability.open",
			title: "Open session observability",
			description: "Open the native Trajectory view; add --web for the local web UI",
			group: "Observability",
			palette: true,
			slash: {
				name: "observability",
				aliases: ["obs"],
				arguments: true
			},
			run: openTrajectory
		},
		{
			id: "observability.trajectory",
			title: "Open session Trajectory",
			description: "Open the native Trajectory view; add --web for the local web UI",
			group: "Observability",
			palette: true,
			slash: {
				name: "trajectory",
				arguments: true
			},
			run: openTrajectory
		},
		{
			id: "observability.statistics",
			title: "Open session Statistics",
			description: "Open the native Statistics view; add --web for the local web UI",
			group: "Observability",
			palette: true,
			slash: {
				name: "statistics",
				aliases: ["stats"],
				arguments: true
			},
			run: openStatistics
		},
		{
			id: "observability.statistics.web",
			title: "Open session Statistics in the browser",
			description: "Open the local Statistics web UI for the current session",
			group: "Observability",
			palette: true,
			slash: {
				name: "statistics:web",
				aliases: ["stats:web"]
			},
			run: () => openView("statistics")
		}
	];
}
function buildTuiUrl(base, route, view, token, theme = null, palette = null) {
	const path = route.type === "session" && route.sessionID ? `#/s/${encodeURIComponent(route.sessionID)}/${view}` : "#/";
	const params = [];
	if (token) params.push(`token=${encodeURIComponent(token)}`);
	if (theme) params.push(`theme=${encodeURIComponent(theme)}`);
	if (palette) params.push(`palette=${encodeURIComponent(JSON.stringify(palette))}`);
	const url = `${base}/${path}`;
	return params.length > 0 ? `${url}?${params.join("&")}` : url;
}
function withoutToken(url) {
	return url.replace(/([?&])token=[^&]*/g, "$1").replace(/[?&]$/, "");
}
function configuredTheme(context) {
	const configured = context.options.theme;
	if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
	if (configured && typeof configured === "object") {
		const name = configured.name;
		if (typeof name === "string" && name.trim().length > 0) return name.trim();
	}
	return null;
}
function themeColor(theme, path) {
	let cursor = theme;
	for (const key of path) {
		if (!cursor || typeof cursor !== "object") return null;
		cursor = cursor[key];
	}
	if (typeof cursor === "string" && /^#[0-9a-f]{3,8}$/i.test(cursor.trim())) return cursor.trim();
	if (cursor && typeof cursor === "object") {
		const base = cursor.base;
		if (typeof base === "string" && /^#[0-9a-f]{3,8}$/i.test(base.trim())) return base.trim();
	}
	return null;
}
/**
* Extracts the colors OpenCode already resolved for its own TUI. Sending them
* in the deep link makes the browser match the user's actual theme, including
* custom themes that this UI does not bundle.
*/
function themePalette(context) {
	const theme = context.theme;
	const page = themeColor(theme, ["background", "base"]);
	const text = themeColor(theme, ["text", "base"]);
	if (!page || !text) return null;
	const palette = {
		page,
		text,
		mode: context.themeMode === "light" ? "light" : "dark"
	};
	for (const [key, path] of [
		["surface", [
			"background",
			"raised",
			"base"
		]],
		["surface2", [
			"background",
			"raised",
			"high"
		]],
		["surface3", [
			"background",
			"action",
			"secondary",
			"base"
		]],
		["text2", ["text", "muted"]],
		["muted", ["text", "faint"]],
		["border", ["border", "base"]],
		["accent", [
			"text",
			"action",
			"primary",
			"base"
		]],
		["good", [
			"text",
			"feedback",
			"success",
			"base"
		]],
		["warning", [
			"text",
			"feedback",
			"warning",
			"base"
		]],
		["critical", [
			"text",
			"feedback",
			"error",
			"base"
		]]
	]) {
		const value = themeColor(theme, path);
		if (value) palette[key] = value;
	}
	return palette;
}
function openBrowser(url) {
	try {
		if (process.platform === "win32") spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
			detached: true,
			stdio: "ignore"
		}).unref();
		else if (process.platform === "darwin") spawn("open", [url], {
			detached: true,
			stdio: "ignore"
		}).unref();
		else spawn("xdg-open", [url], {
			detached: true,
			stdio: "ignore"
		}).unref();
		return true;
	} catch {
		return false;
	}
}
var STATISTICS_PANEL, TRAJECTORY_PANEL, PANEL_FALLBACK, WEB_FLAGS, tui_default;
var init_tui = __esmMin((() => {
	init_define();
	init_tui_net();
	init_tui_warmup();
	init_tui_native();
	init_tui_status();
	STATISTICS_PANEL = "statistics";
	TRAJECTORY_PANEL = "trajectory";
	PANEL_FALLBACK = {
		statistics: {
			message: "No session is selected, so there is no statistics to show.",
			variant: "warning"
		},
		trajectory: {
			message: "No session is selected, so there is no trajectory to show.",
			variant: "info"
		}
	};
	WEB_FLAGS = /* @__PURE__ */ new Set([
		"--web",
		"-w",
		"web"
	]);
	tui_default = defineTuiPlugin({
		id: TUI_PLUGIN_ID,
		async setup(context) {
			const base = baseUrl(context.options.url);
			const autoStart = autoStartEnabled(context.options.autoStart, process.env.OPENCODE_OBSERVABILITY_AUTO_START);
			ensureServer(base, {
				autoStart,
				timeoutMs: 1e4
			}).catch(() => "down");
			const { statisticsPanelElement } = await Promise.resolve().then(() => (init_StatisticsView(), StatisticsView_exports));
			const { trajectoryPanelElement } = await Promise.resolve().then(() => (init_TrajectoryView(), TrajectoryView_exports));
			const { statusBadgeElement } = await Promise.resolve().then(() => (init_statusBadge(), statusBadge_exports));
			/**
			* Opens the native Statistics panel for the current session. Returns false
			* when the host has no selected session to attach the panel to.
			*/
			const openStatisticsPanel = () => context.ui.panel.open(STATISTICS_PANEL, { presentation: "fullscreen" });
			/** Opens the native Trajectory panel; false without a selected session. */
			const openTrajectoryPanel = () => context.ui.panel.open(TRAJECTORY_PANEL, { presentation: "fullscreen" });
			/**
			* The mounted panels install their handlers here; the keymap layer below
			* only forwards. When a panel is closed or not mounted, every command is a
			* no-op even before the `enabled` gate is considered.
			*/
			const statisticsKeyboard = {
				handlers: null,
				focused: null
			};
			const trajectoryKeyboard = {
				handlers: null,
				focused: null
			};
			context.ui.slot({
				append: "session.panel",
				render: (input) => input.name === "statistics" ? statisticsPanelElement(context, input, statisticsKeyboard) : null
			});
			/**
			* The Trajectory panel is a second claim on the same slot (decision D2).
			* Each claim renders only for its own panel id and returns `null`
			* otherwise, so the host can pick by name without the claims colliding.
			*/
			context.ui.slot({
				append: "session.panel",
				render: (input) => input.name === "trajectory" ? trajectoryPanelElement(context, input, trajectoryKeyboard) : null
			});
			/**
			* Status badge (issue #6, decision D3). `prompt.footer.status` carries the
			* session id, the input mode and `showDetails`. The badge renders nothing
			* without a session id, and refetch frequency is bounded by the 15 s
			* per-session cache. When an older host does not publish this path, the SDK
			* appends the claim to the nearest surviving ancestor (`prompt.footer`), so
			* no second claim is needed and nothing throws or toasts.
			*/
			context.ui.slot({
				append: "prompt.footer.status",
				render: (input) => statusBadgeElement(context, input)
			});
			const openView = async (view) => {
				const configured = pluginToken(context.options.token);
				const status = await ensureServer(base, {
					autoStart,
					timeoutMs: 1e4
				}).catch(() => "down");
				const token = status === "auth" ? configured ?? await tokenFromFile(base) : null;
				if (status === "down") {
					context.ui.toast.show({
						title: "Session observability",
						message: "The local UI is not running. Start it with: npm start -- --port 4517",
						variant: "warning",
						duration: 8e3
					});
					return;
				}
				if (status === "auth" && !token) {
					context.ui.toast.show({
						title: "Session observability",
						message: "The UI requires an access token, but no token file was found. Restart it with `npm start`, or set the plugin option \"token\" or OPENCODE_OBSERVABILITY_TOKEN.",
						variant: "warning",
						duration: 1e4
					});
					return;
				}
				const explicitTheme = configuredTheme(context);
				const url = buildTuiUrl(base, context.ui.router.current(), view, token, explicitTheme, explicitTheme ? null : themePalette(context));
				if (!openBrowser(url)) {
					context.ui.toast.show({
						title: "Session observability",
						message: withoutToken(url),
						variant: "info",
						duration: 8e3
					});
					return;
				}
				context.ui.toast.show({
					message: `Opening ${view} in the browser`,
					variant: "success"
				});
			};
			const keymapBridges = {
				statistics: statisticsKeyboard,
				trajectory: trajectoryKeyboard
			};
			const activeKeyboard = () => activePanelKeyboard(context.ui.panel.current()?.name, keymapBridges);
			context.keymap.layer(() => ({
				mode: "global",
				commands: tuiCommandDefinitions(openView, (browserFallback) => {
					openPanelOrFallback("statistics", openStatisticsPanel, (options) => context.ui.toast.show(options), browserFallback);
				}, (browserFallback) => {
					openPanelOrFallback("trajectory", openTrajectoryPanel, (options) => context.ui.toast.show(options), browserFallback);
				})
			}));
			/**
			* Panel-scoped navigation shared by both native panels. The layer is
			* permanently registered but gated on `ui.panel.current()`, so it only
			* claims keys while one of this plugin's panels is open; dispatch resolves
			* the active panel's bridge, so the two panels never see each other's
			* handlers. A reported `input.focused: false` also closes the gate, so keys
			* cannot leak while the host focuses another surface; hosts that do not
			* publish the field keep the panel-name gate as the floor. `priority` makes
			* the layer win over host bindings such as `escape`.
			*/
			context.keymap.layer(() => ({
				enabled: () => activeKeyboard() !== null,
				priority: 10,
				commands: panelKeymapCommands(activeKeyboard, () => context.ui.panel.close())
			}));
		}
	});
}));
init_tui();
export { PANEL_FALLBACK, STATISTICS_PANEL, STATISTICS_ROUTE, TRAJECTORY_PANEL, TRAJECTORY_ROUTE, activePanelKeyboard, baseUrl, bridgeFocus, buildTuiUrl, currentSessionID, tui_default as default, fetchSessionStatus, formatStatusBadge, hasNativeView, openNativeStatistics, openPanelOrFallback, panelKeymapCommands, parseStatsArg, pluginToken, reachable, registerNativeView, statusBadgeText, themePalette, tokenFromFile, tuiCommandDefinitions };
