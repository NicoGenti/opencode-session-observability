import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
// src/core/util.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asRecord(value) {
	return isRecord(value) ? value : {};
}
function asArray$1(value) {
	return Array.isArray(value) ? value : [];
}
function str(value) {
	return typeof value === "string" ? value : null;
}
function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function bool$1(value) {
	return typeof value === "boolean" ? value : null;
}
/** Parses a JSON string, returning the input unchanged when it is already data. */
function parseJson(value) {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}
/** Milliseconds since epoch from a number or an ISO-8601 string. */
function toMillis(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length > 0) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	if (value instanceof Date) {
		const time = value.getTime();
		return Number.isFinite(time) ? time : null;
	}
	return null;
}
function truncate(value, max) {
	if (value.length <= max) return value;
	return value.slice(0, Math.max(0, max - 1)) + "…";
}
function preview(value, max = 240) {
	if (value === null || value === void 0) return "";
	return truncate((typeof value === "string" ? value : (() => {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	})()).replace(/\s+/g, " ").trim(), max);
}
function safeStringify(value, space = 0) {
	try {
		return JSON.stringify(value, null, space) ?? "";
	} catch {
		return String(value);
	}
}
function normalizeModel(value) {
	const record = asRecord(parseJson(value));
	const providerID = str(record.providerID) ?? str(record.provider);
	const id = str(record.id) ?? str(record.modelID);
	if (!providerID || !id) return null;
	const variant = str(record.variant) ?? void 0;
	return variant ? {
		providerID,
		id,
		variant
	} : {
		providerID,
		id
	};
}
function modelLabel$2(model) {
	if (!model) return null;
	return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}
/** Reads a token usage object defensively. Returns null when no count exists. */
function normalizeTokens(value) {
	const source = asRecord(parseJson(value));
	const cache = asRecord(source.cache);
	const partial = {
		input: num(source.input) ?? void 0,
		output: num(source.output) ?? void 0,
		reasoning: num(source.reasoning) ?? void 0,
		cacheRead: num(cache.read) ?? void 0,
		cacheWrite: num(cache.write) ?? void 0
	};
	if (!Object.values(partial).some((v) => v !== void 0)) return null;
	return {
		input: partial.input ?? 0,
		output: partial.output ?? 0,
		reasoning: partial.reasoning ?? 0,
		cacheRead: partial.cacheRead ?? 0,
		cacheWrite: partial.cacheWrite ?? 0
	};
}
function escapeHtml(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}
var SECRET_KEY_TOKENS = /* @__PURE__ */ new Set([
	"apikey",
	"xapikey",
	"authorization",
	"proxyauthorization",
	"password",
	"passwd",
	"passphrase",
	"secret",
	"secretkey",
	"clientsecret",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"authtoken",
	"sessiontoken",
	"token",
	"apitoken",
	"xauthtoken",
	"privatekey",
	"credential",
	"credentials",
	"cookie",
	"setcookie",
	"secretaccesskey",
	"awssecretaccesskey",
	"databaseurl",
	"dsn",
	"connectionstring",
	"webhook",
	"webhookurl",
	"signingkey"
]);
/** Object keys are matched by normalized name, so new key spellings are covered. */
function isSecretKey(key) {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (SECRET_KEY_TOKENS.has(normalized)) return true;
	return normalized.endsWith("apikey") || normalized.endsWith("token") || normalized.endsWith("secret") || normalized.endsWith("secretkey") || normalized.endsWith("password") || normalized.endsWith("passwd") || normalized.endsWith("credential") || normalized.endsWith("credentials");
}
var PRIVATE_KEY_HEADER = "PRIVATE KEY-----";
var PRIVATE_KEY_END = "-----END ";
/**
* Replaces complete PEM private-key blocks with a marker without a regex.
* The previous pattern used an unbounded lazy wildcard, which was quadratic
* on text containing many BEGIN markers and no END marker. Unterminated
* blocks (including previews cut mid-key) are redacted to end of string.
*/
function redactPemBlocks(value) {
	if (!value.includes("-----BEGIN ")) return value;
	let out = "";
	let index = 0;
	while (index < value.length) {
		const begin = value.indexOf("-----BEGIN ", index);
		if (begin === -1) {
			out += value.slice(index);
			break;
		}
		const headerEnd = value.indexOf(PRIVATE_KEY_HEADER, begin + 11);
		const label = headerEnd === -1 ? null : value.slice(begin + 11, headerEnd);
		if (headerEnd === -1 || label === null || !/^[A-Z ]*$/.test(label)) {
			out += value.slice(index, begin + 11);
			index = begin + 11;
			continue;
		}
		let endStart = value.indexOf(PRIVATE_KEY_END, headerEnd + 16);
		let endEnd = -1;
		while (endStart !== -1) {
			const marker = value.indexOf(PRIVATE_KEY_HEADER, endStart + 9);
			if (marker === -1) break;
			if (value.slice(endStart + 9, marker) === label) {
				endEnd = marker + 16;
				break;
			}
			endStart = value.indexOf(PRIVATE_KEY_END, marker + 16);
		}
		out += value.slice(index, begin) + "[REDACTED:private-key]";
		if (endEnd === -1) {
			index = value.length;
			break;
		}
		index = endEnd;
	}
	return out;
}
/**
* Redacts credential-shaped ends of truncated previews. Previews are cut at a
* fixed width during normalization, so patterns that need a closing delimiter
* cannot match them; this closes the partial-secret leak without affecting
* full payloads or reveal mode.
*/
function redactTruncatedTail(value) {
	let out = value;
	out = out.replace(/\b(?:sk-[A-Za-z0-9_-]*|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]*|gh[pousr]_[A-Za-z0-9]*|glpat-[A-Za-z0-9_-]*|npm_[A-Za-z0-9]*|pypi-[A-Za-z0-9_-]*|hf_[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]*|xox[baprs]-?[A-Za-z0-9-]*|AIza[0-9A-Za-z_-]*|AKIA[0-9A-Z]*)…$/, "[REDACTED]…");
	out = out.replace(/\beyJ[A-Za-z0-9_-]*…$/, "[REDACTED:jwt]…");
	out = out.replace(/((?:"(?:api[-_]?key|apikey|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|authorization|database[-_]?url|dsn)"\s*:\s*")[^"]*)…$/gi, "$1[REDACTED]…");
	out = out.replace(/((?:api[-_]?key|apikey|password|passwd|passphrase|secret|token|authorization|database[-_]?url|dsn)\s*[:=]\s*)(?:"[^"]*|'[^']*|[^\s&;,"']*)…$/gi, "$1[REDACTED]…");
	out = out.replace(/((?<![A-Za-z0-9_])(?:token|id[-_]?token|session[-_]?token)\s*[:=]\s*)(?:"[^"]*|'[^']*|[^\s&;,"']*)…$/gi, "$1[REDACTED]…");
	out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*…$/i, "$1[REDACTED]…");
	out = out.replace(/((?:Proxy-)?Authorization\s*:\s*(?:Basic|Digest)\s+)[^\s]*…$/i, "$1[REDACTED]…");
	out = out.replace(/((?:Set-)?Cookie\s*:\s*)[^\r\n]*…$/i, "$1[REDACTED]…");
	return out;
}
var SECRET_PATTERNS = [
	{
		name: "bearer",
		pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
	},
	{
		name: "openai-key",
		pattern: /\bsk-[A-Za-z0-9_-]{10,}/g
	},
	{
		name: "anthropic-key",
		pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g
	},
	{
		name: "stripe-key",
		pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g
	},
	{
		name: "github-token",
		pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g
	},
	{
		name: "github-fine-grained",
		pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g
	},
	{
		name: "gitlab-token",
		pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g
	},
	{
		name: "npm-token",
		pattern: /\bnpm_[A-Za-z0-9]{30,}/g
	},
	{
		name: "pypi-token",
		pattern: /\bpypi-[A-Za-z0-9_-]{20,}/g
	},
	{
		name: "huggingface-token",
		pattern: /\bhf_[A-Za-z0-9]{30,}/g
	},
	{
		name: "slack-token",
		pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g
	},
	{
		name: "slack-webhook",
		pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g
	},
	{
		name: "google-key",
		pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g
	},
	{
		name: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{1,}\.[A-Za-z0-9_-]{1,}/g
	},
	{
		name: "aws-key",
		pattern: /\bAKIA[0-9A-Z]{16}\b/g
	},
	{
		name: "aws-secret",
		pattern: /((?:aws[-_]?secret[-_]?access[-_]?key|secret[-_]?access[-_]?key|secretAccessKey)\s*[:=]\s*['"]?)[A-Za-z0-9/+=]{30,}/gi
	},
	{
		name: "url-credentials",
		pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi
	},
	{
		name: "query-credential",
		pattern: /([?&](?:api[-_]?key|token|access[-_]?token|key|secret|password)=)[^&\s]+/gi
	},
	{
		name: "json-credential",
		pattern: /("(?:api[-_]?key|apikey|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|authorization|database[-_]?url|dsn)"\s*:\s*")[^"]*(")/gi
	},
	{
		name: "basic-auth",
		pattern: /(\b(?:Proxy-)?Authorization\s*:\s*(?:Basic|Digest)\s+)[A-Za-z0-9+/=._~-]+/gi
	},
	{
		name: "cookie-header",
		pattern: /(\b(?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi
	},
	{
		name: "assignment-credential",
		pattern: /((?:api[-_]?key|apikey|password|passwd|passphrase|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|api[-_]?token|secret[-_]?access[-_]?key|database[-_]?url|dsn)(?:[A-Za-z0-9_-]*)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,"']+)/gi
	},
	{
		name: "token-assignment",
		pattern: /((?<![A-Za-z0-9_])(?:token|id[-_]?token|session[-_]?token)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=-]{8,})/gi
	}
];
var REDACTED = "[REDACTED]";
/**
* Redacts credential-shaped keys and strings. Token *counts* (`tokens.input`,
* `cache.read`, ...) are deliberately preserved: they are metrics, not secrets.
*/
function redactValue(value, ancestors = /* @__PURE__ */ new Set()) {
	if (typeof value === "string") return redactString(value);
	if (value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) return "[Circular]";
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => redactValue(item, ancestors));
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			if (isSecretKey(key)) {
				out[key] = REDACTED;
				continue;
			}
			out[key] = redactValue(item, ancestors);
		}
		return out;
	} finally {
		ancestors.delete(value);
	}
}
function redactString(value) {
	let out = redactPemBlocks(value);
	for (const { name, pattern } of SECRET_PATTERNS) out = out.replace(pattern, (match, prefix, suffix) => {
		if (name === "url-credentials" && prefix) return `${prefix}[REDACTED]@`;
		if (name === "query-credential" && prefix) return `${prefix}[REDACTED]`;
		if (name === "json-credential" && prefix && suffix) return `${prefix}[REDACTED]${suffix}`;
		if ((name === "assignment-credential" || name === "token-assignment" || name === "aws-secret" || name === "basic-auth" || name === "cookie-header") && prefix) return `${prefix}[REDACTED]`;
		return `[REDACTED:${name}]`;
	});
	if (out.endsWith("…")) out = redactTruncatedTail(out);
	return out;
}
// src/core/adapters/sqlite.ts
var UnsupportedSchemaError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "UnsupportedSchemaError";
	}
};
var DatabaseBusyError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "DatabaseBusyError";
	}
};
function detectSchema(db) {
	const rows = db.prepare("select name from sqlite_master where type = 'table' and name in ('session_v2','session_message','session','message','part')").all();
	const names = new Set(rows.map((row) => row.name));
	if (names.has("session_v2") && names.has("session_message")) return "v2";
	if (names.has("session") && names.has("message")) return "v1";
	return "unknown";
}
// src/core/adapters/paths.ts
var DatabaseDiscoveryError = class extends Error {
	candidates;
	constructor(message, candidates) {
		super(message);
		this.name = "DatabaseDiscoveryError";
		this.candidates = candidates;
	}
};
function candidateDatabasePaths(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const paths = [];
	const push = (value) => {
		if (!value) return;
		const normalized = resolve(value);
		if (!paths.some((item) => item.toLowerCase() === normalized.toLowerCase())) paths.push(normalized);
	};
	push(options.explicitPath);
	push(env.OPENCODE_OBSERVABILITY_DB);
	push(env.OPENCODE_DB);
	if (env.XDG_DATA_HOME) push(join(env.XDG_DATA_HOME, "opencode", "opencode.db"));
	push(join(home, ".opencode2", "data", "opencode", "opencode.db"));
	push(join(home, ".local", "share", "opencode", "opencode.db"));
	if (platform === "win32") {
		if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, "opencode", "opencode.db"));
		if (env.APPDATA) push(join(env.APPDATA, "opencode", "opencode.db"));
	}
	if (platform === "darwin") push(join(home, "Library", "Application Support", "opencode", "opencode.db"));
	if (platform === "linux") push(join(home, ".config", "opencode", "opencode.db"));
	return paths;
}
function inspectDatabase(path) {
	if (!existsSync(path)) return {
		path,
		exists: false,
		schema: "unknown"
	};
	let mtimeMs;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		mtimeMs = void 0;
	}
	let db = null;
	try {
		db = new DatabaseSync(path, {
			readOnly: true,
			enableForeignKeyConstraints: false
		});
		return {
			path,
			exists: true,
			schema: detectSchema(db),
			...mtimeMs !== void 0 ? { mtimeMs } : {}
		};
	} catch (error) {
		return {
			path,
			exists: true,
			schema: "unknown",
			...mtimeMs !== void 0 ? { mtimeMs } : {},
			error: error instanceof Error ? error.message : String(error)
		};
	} finally {
		try {
			db?.close();
		} catch {}
	}
}
/**
* Selects an OpenCode 2 database. An explicit path is authoritative. Otherwise
* the first OpenCode 2 database in priority order wins: environment overrides,
* XDG data home, the isolated ~/.opencode2 profile, then standard locations.
* An OpenCode 1 database is reported clearly instead of being opened as if it
* were compatible.
*/
function discoverDatabase(options = {}) {
	const paths = candidateDatabasePaths(options);
	const candidates = paths.map(inspectDatabase);
	if (options.explicitPath) {
		const explicit = candidates[0];
		if (!explicit.exists) throw new DatabaseDiscoveryError(`Database not found: ${explicit.path}`, candidates);
		if (explicit.schema !== "v2") throw new UnsupportedSchemaError(explicit.schema === "v1" ? `OpenCode 1 database detected at ${explicit.path}. This build reads OpenCode 2 (session_v2/session_message).` : `Unrecognized database at ${explicit.path}. Expected OpenCode 2 tables session_v2 and session_message.`);
		return explicit;
	}
	const v2 = candidates.find((candidate) => candidate.schema === "v2");
	if (v2) return v2;
	const v1 = candidates.filter((candidate) => candidate.schema === "v1");
	if (v1.length > 0) throw new DatabaseDiscoveryError(`Only OpenCode 1 databases were found (${v1.map((candidate) => candidate.path).join(", ")}). This build requires OpenCode 2. Pass --db <path> if an OpenCode 2 database exists elsewhere.`, candidates);
	throw new DatabaseDiscoveryError(`No OpenCode 2 database found. Looked in: ${paths.join(", ")}. Start OpenCode 2 once or pass --db <path>.`, candidates);
}
// src/core/adapters/sqlite-worker-source.ts
function reviveError(error) {
	if (error.name === "DatabaseBusyError") return new DatabaseBusyError(error.message);
	if (error.name === "UnsupportedSchemaError") return new UnsupportedSchemaError(error.message);
	return new Error(error.message);
}
/**
* Runs the synchronous SQLite adapter on a worker thread so a large session
* cannot block the HTTP server's event loop. The public surface matches
* ObservabilitySource; `ready()` resolves after the database is validated.
*/
var WorkerSqliteSource = class {
	kind = "sqlite";
	path;
	worker;
	pending = /* @__PURE__ */ new Map();
	readyPromise;
	nextID = 1;
	closed = false;
	failure = null;
	constructor(path) {
		this.path = path;
		this.worker = new Worker(new URL("data:text/javascript;base64,aW1wb3J0IHsgcGFyZW50UG9ydCB9IGZyb20gIm5vZGU6d29ya2VyX3RocmVhZHMiOwppbXBvcnQgeyBEYXRhYmFzZVN5bmMgfSBmcm9tICJub2RlOnNxbGl0ZSI7Ci8vIHNyYy9jb3JlL3V0aWwudHMKZnVuY3Rpb24gaXNSZWNvcmQodmFsdWUpIHsKCXJldHVybiB0eXBlb2YgdmFsdWUgPT09ICJvYmplY3QiICYmIHZhbHVlICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHZhbHVlKTsKfQpmdW5jdGlvbiBhc1JlY29yZCh2YWx1ZSkgewoJcmV0dXJuIGlzUmVjb3JkKHZhbHVlKSA/IHZhbHVlIDoge307Cn0KZnVuY3Rpb24gc3RyKHZhbHVlKSB7CglyZXR1cm4gdHlwZW9mIHZhbHVlID09PSAic3RyaW5nIiA/IHZhbHVlIDogbnVsbDsKfQpmdW5jdGlvbiBudW0odmFsdWUpIHsKCXJldHVybiB0eXBlb2YgdmFsdWUgPT09ICJudW1iZXIiICYmIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyB2YWx1ZSA6IG51bGw7Cn0KLyoqIFBhcnNlcyBhIEpTT04gc3RyaW5nLCByZXR1cm5pbmcgdGhlIGlucHV0IHVuY2hhbmdlZCB3aGVuIGl0IGlzIGFscmVhZHkgZGF0YS4gKi8KZnVuY3Rpb24gcGFyc2VKc29uKHZhbHVlKSB7CglpZiAodHlwZW9mIHZhbHVlICE9PSAic3RyaW5nIikgcmV0dXJuIHZhbHVlOwoJY29uc3QgdHJpbW1lZCA9IHZhbHVlLnRyaW0oKTsKCWlmICghdHJpbW1lZC5zdGFydHNXaXRoKCJ7IikgJiYgIXRyaW1tZWQuc3RhcnRzV2l0aCgiWyIpKSByZXR1cm4gdmFsdWU7Cgl0cnkgewoJCXJldHVybiBKU09OLnBhcnNlKHRyaW1tZWQpOwoJfSBjYXRjaCB7CgkJcmV0dXJuIHZhbHVlOwoJfQp9CmZ1bmN0aW9uIG5vcm1hbGl6ZU1vZGVsKHZhbHVlKSB7Cgljb25zdCByZWNvcmQgPSBhc1JlY29yZChwYXJzZUpzb24odmFsdWUpKTsKCWNvbnN0IHByb3ZpZGVySUQgPSBzdHIocmVjb3JkLnByb3ZpZGVySUQpID8/IHN0cihyZWNvcmQucHJvdmlkZXIpOwoJY29uc3QgaWQgPSBzdHIocmVjb3JkLmlkKSA/PyBzdHIocmVjb3JkLm1vZGVsSUQpOwoJaWYgKCFwcm92aWRlcklEIHx8ICFpZCkgcmV0dXJuIG51bGw7Cgljb25zdCB2YXJpYW50ID0gc3RyKHJlY29yZC52YXJpYW50KSA/PyB2b2lkIDA7CglyZXR1cm4gdmFyaWFudCA/IHsKCQlwcm92aWRlcklELAoJCWlkLAoJCXZhcmlhbnQKCX0gOiB7CgkJcHJvdmlkZXJJRCwKCQlpZAoJfTsKfQovLyBzcmMvY29yZS9hZGFwdGVycy9zcWxpdGUudHMKdmFyIFVuc3VwcG9ydGVkU2NoZW1hRXJyb3IgPSBjbGFzcyBleHRlbmRzIEVycm9yIHsKCWNvbnN0cnVjdG9yKG1lc3NhZ2UpIHsKCQlzdXBlcihtZXNzYWdlKTsKCQl0aGlzLm5hbWUgPSAiVW5zdXBwb3J0ZWRTY2hlbWFFcnJvciI7Cgl9Cn07CnZhciBEYXRhYmFzZUJ1c3lFcnJvciA9IGNsYXNzIGV4dGVuZHMgRXJyb3IgewoJY29uc3RydWN0b3IobWVzc2FnZSkgewoJCXN1cGVyKG1lc3NhZ2UpOwoJCXRoaXMubmFtZSA9ICJEYXRhYmFzZUJ1c3lFcnJvciI7Cgl9Cn07CmZ1bmN0aW9uIGRldGVjdFNjaGVtYShkYikgewoJY29uc3Qgcm93cyA9IGRiLnByZXBhcmUoInNlbGVjdCBuYW1lIGZyb20gc3FsaXRlX21hc3RlciB3aGVyZSB0eXBlID0gJ3RhYmxlJyBhbmQgbmFtZSBpbiAoJ3Nlc3Npb25fdjInLCdzZXNzaW9uX21lc3NhZ2UnLCdzZXNzaW9uJywnbWVzc2FnZScsJ3BhcnQnKSIpLmFsbCgpOwoJY29uc3QgbmFtZXMgPSBuZXcgU2V0KHJvd3MubWFwKChyb3cpID0+IHJvdy5uYW1lKSk7CglpZiAobmFtZXMuaGFzKCJzZXNzaW9uX3YyIikgJiYgbmFtZXMuaGFzKCJzZXNzaW9uX21lc3NhZ2UiKSkgcmV0dXJuICJ2MiI7CglpZiAobmFtZXMuaGFzKCJzZXNzaW9uIikgJiYgbmFtZXMuaGFzKCJtZXNzYWdlIikpIHJldHVybiAidjEiOwoJcmV0dXJuICJ1bmtub3duIjsKfQpmdW5jdGlvbiByb3dSZWNvcmQocm93KSB7CglyZXR1cm4gcm93ICYmIHR5cGVvZiByb3cgPT09ICJvYmplY3QiID8gcm93IDoge307Cn0KZnVuY3Rpb24gdG9rZW5zRnJvbVJvdyhyb3cpIHsKCWlmICghWwoJCXJvdy50b2tlbnNfaW5wdXQsCgkJcm93LnRva2Vuc19vdXRwdXQsCgkJcm93LnRva2Vuc19yZWFzb25pbmcsCgkJcm93LnRva2Vuc19jYWNoZV9yZWFkLAoJCXJvdy50b2tlbnNfY2FjaGVfd3JpdGUKCV0uc29tZSgodmFsdWUpID0+IHR5cGVvZiB2YWx1ZSA9PT0gIm51bWJlciIpKSByZXR1cm4gdm9pZCAwOwoJcmV0dXJuIHsKCQlpbnB1dDogbnVtKHJvdy50b2tlbnNfaW5wdXQpID8/IDAsCgkJb3V0cHV0OiBudW0ocm93LnRva2Vuc19vdXRwdXQpID8/IDAsCgkJcmVhc29uaW5nOiBudW0ocm93LnRva2Vuc19yZWFzb25pbmcpID8/IDAsCgkJY2FjaGVSZWFkOiBudW0ocm93LnRva2Vuc19jYWNoZV9yZWFkKSA/PyAwLAoJCWNhY2hlV3JpdGU6IG51bShyb3cudG9rZW5zX2NhY2hlX3dyaXRlKSA/PyAwCgl9Owp9CmZ1bmN0aW9uIG1vZGVsRnJvbVJvdyhyb3cpIHsKCXJldHVybiBub3JtYWxpemVNb2RlbChyb3cubW9kZWwpID8/IHZvaWQgMDsKfQpmdW5jdGlvbiBzZXNzaW9uTWV0YUZyb21Sb3cocm93KSB7Cgljb25zdCBmb3JrU2Vzc2lvbklEID0gc3RyKHJvdy5mb3JrX3Nlc3Npb25faWQpOwoJY29uc3QgZm9ya0JvdW5kYXJ5ID0gcm93LmZvcmtfYm91bmRhcnk7Cgljb25zdCBtZXRhID0gewoJCWlkOiBzdHIocm93LmlkKSA/PyAiIiwKCQl0aW1lOiB7CgkJCWNyZWF0ZWQ6IG51bShyb3cudGltZV9jcmVhdGVkKSA/PyAwLAoJCQkuLi5udW0ocm93LnRpbWVfdXBkYXRlZCkgIT09IG51bGwgPyB7IHVwZGF0ZWQ6IG51bShyb3cudGltZV91cGRhdGVkKSB9IDoge30sCgkJCS4uLm51bShyb3cudGltZV9idXN5KSAhPT0gbnVsbCA/IHsgYnVzeTogbnVtKHJvdy50aW1lX2J1c3kpIH0gOiB7fSwKCQkJLi4ubnVtKHJvdy50aW1lX2lkbGUpICE9PSBudWxsID8geyBpZGxlOiBudW0ocm93LnRpbWVfaWRsZSkgfSA6IHt9LAoJCQkuLi5udW0ocm93LnRpbWVfYXJjaGl2ZWQpICE9PSBudWxsID8geyBhcmNoaXZlZDogbnVtKHJvdy50aW1lX2FyY2hpdmVkKSB9IDoge30KCQl9Cgl9OwoJY29uc3QgcGFyZW50SUQgPSBzdHIocm93LnBhcmVudF9pZCk7CglpZiAocGFyZW50SUQpIG1ldGEucGFyZW50SUQgPSBwYXJlbnRJRDsKCWlmIChmb3JrU2Vzc2lvbklEKSBtZXRhLmZvcmsgPSB7CgkJc2Vzc2lvbklEOiBmb3JrU2Vzc2lvbklELAoJCS4uLmZvcmtCb3VuZGFyeSAhPT0gbnVsbCAmJiBmb3JrQm91bmRhcnkgIT09IHZvaWQgMCA/IHsgYm91bmRhcnk6IHBhcnNlSnNvbihmb3JrQm91bmRhcnkpIH0gOiB7fQoJfTsKCWNvbnN0IHByb2plY3RJRCA9IHN0cihyb3cucHJvamVjdF9pZCk7CglpZiAocHJvamVjdElEKSBtZXRhLnByb2plY3RJRCA9IHByb2plY3RJRDsKCWNvbnN0IHRpdGxlID0gc3RyKHJvdy50aXRsZSk7CglpZiAodGl0bGUpIG1ldGEudGl0bGUgPSB0aXRsZTsKCWNvbnN0IGRpcmVjdG9yeSA9IHN0cihyb3cuZGlyZWN0b3J5KTsKCWlmIChkaXJlY3RvcnkpIG1ldGEuZGlyZWN0b3J5ID0gZGlyZWN0b3J5OwoJY29uc3QgYWdlbnQgPSBzdHIocm93LmFnZW50KTsKCWlmIChhZ2VudCkgbWV0YS5hZ2VudCA9IGFnZW50OwoJY29uc3QgbW9kZWwgPSBtb2RlbEZyb21Sb3cocm93KTsKCWlmIChtb2RlbCkgbWV0YS5tb2RlbCA9IG1vZGVsOwoJY29uc3QgY29zdCA9IG51bShyb3cuY29zdCk7CglpZiAoY29zdCAhPT0gbnVsbCkgbWV0YS5jb3N0ID0gY29zdDsKCWNvbnN0IHRva2VucyA9IHRva2Vuc0Zyb21Sb3cocm93KTsKCWlmICh0b2tlbnMpIG1ldGEudG9rZW5zID0gdG9rZW5zOwoJY29uc3Qgb3V0Y29tZSA9IHN0cihyb3cuaWRsZV9vdXRjb21lKTsKCWlmIChvdXRjb21lID09PSAic3VjY2VlZGVkIiB8fCBvdXRjb21lID09PSAiZmFpbGVkIiB8fCBvdXRjb21lID09PSAiaW50ZXJydXB0ZWQiKSBtZXRhLm91dGNvbWUgPSBvdXRjb21lOwoJY29uc3QgcmV2ZXJ0ID0gcm93LnJldmVydDsKCWlmIChyZXZlcnQgIT09IG51bGwgJiYgcmV2ZXJ0ICE9PSB2b2lkIDAgJiYgcmV2ZXJ0ICE9PSAiIikgbWV0YS5yZXZlcnQgPSBwYXJzZUpzb24ocmV2ZXJ0KTsKCWNvbnN0IHJlc3VtZUF0dGVtcHRzID0gbnVtKHJvdy5yZXN1bWVfYXR0ZW1wdHMpOwoJaWYgKHJlc3VtZUF0dGVtcHRzICE9PSBudWxsKSBtZXRhLnJlc3VtZUF0dGVtcHRzID0gcmVzdW1lQXR0ZW1wdHM7Cgljb25zdCBzdXNwZW5kZWQgPSBudW0ocm93LnRpbWVfc3VzcGVuZGVkKTsKCWlmIChzdXNwZW5kZWQgIT09IG51bGwpIG1ldGEuc3VzcGVuZGVkQXQgPSBzdXNwZW5kZWQ7Cgljb25zdCB2ZXJzaW9uID0gc3RyKHJvdy52ZXJzaW9uKTsKCWlmICh2ZXJzaW9uKSBtZXRhLnZlcnNpb24gPSB2ZXJzaW9uOwoJY29uc3Qgc2x1ZyA9IHN0cihyb3cuc2x1Zyk7CglpZiAoc2x1ZykgbWV0YS5zbHVnID0gc2x1ZzsKCXJldHVybiBtZXRhOwp9CmZ1bmN0aW9uIHN1bW1hcnlGcm9tTWV0YShtZXRhKSB7CglyZXR1cm4gewoJCWlkOiBtZXRhLmlkLAoJCS4uLm1ldGEucGFyZW50SUQgPyB7IHBhcmVudElEOiBtZXRhLnBhcmVudElEIH0gOiB7fSwKCQkuLi5tZXRhLnByb2plY3RJRCA/IHsgcHJvamVjdElEOiBtZXRhLnByb2plY3RJRCB9IDoge30sCgkJLi4ubWV0YS5zbHVnID8geyBzbHVnOiBtZXRhLnNsdWcgfSA6IHt9LAoJCS4uLm1ldGEudGl0bGUgPyB7IHRpdGxlOiBtZXRhLnRpdGxlIH0gOiB7fSwKCQkuLi5tZXRhLmRpcmVjdG9yeSA/IHsgZGlyZWN0b3J5OiBtZXRhLmRpcmVjdG9yeSB9IDoge30sCgkJLi4ubWV0YS5hZ2VudCA/IHsgYWdlbnQ6IG1ldGEuYWdlbnQgfSA6IHt9LAoJCS4uLm1ldGEubW9kZWwgPyB7IG1vZGVsOiBtZXRhLm1vZGVsIH0gOiB7fSwKCQl0aW1lQ3JlYXRlZDogbWV0YS50aW1lLmNyZWF0ZWQsCgkJLi4ubWV0YS50aW1lLnVwZGF0ZWQgPyB7IHRpbWVVcGRhdGVkOiBtZXRhLnRpbWUudXBkYXRlZCB9IDoge30sCgkJLi4ubWV0YS5jb3N0ICE9PSB2b2lkIDAgPyB7IGNvc3Q6IG1ldGEuY29zdCB9IDoge30sCgkJLi4ubWV0YS50b2tlbnMgPyB7IHRva2VuczogbWV0YS50b2tlbnMgfSA6IHt9LAoJCS4uLm1ldGEub3V0Y29tZSA/IHsgb3V0Y29tZTogbWV0YS5vdXRjb21lIH0gOiB7fQoJfTsKfQp2YXIgU0VTU0lPTl9DT0xVTU5TID0gYAogIGlkLCBwcm9qZWN0X2lkLCBwYXJlbnRfaWQsIGZvcmtfc2Vzc2lvbl9pZCwgZm9ya19ib3VuZGFyeSwgc2x1ZywgZGlyZWN0b3J5LCB0aXRsZSwKICB2ZXJzaW9uLCBjb3N0LCB0b2tlbnNfaW5wdXQsIHRva2Vuc19vdXRwdXQsIHRva2Vuc19yZWFzb25pbmcsIHRva2Vuc19jYWNoZV9yZWFkLAogIHRva2Vuc19jYWNoZV93cml0ZSwgcmV2ZXJ0LCBpZGxlX291dGNvbWUsIHRpbWVfY3JlYXRlZCwgdGltZV91cGRhdGVkLCB0aW1lX2J1c3ksCiAgdGltZV9pZGxlLCB0aW1lX2FyY2hpdmVkLCByZXN1bWVfYXR0ZW1wdHMsIHRpbWVfc3VzcGVuZGVkLCBhZ2VudCwgbW9kZWwKYDsKLyoqCiogUmVhZC1vbmx5IGFkYXB0ZXIgb3ZlciB0aGUgT3BlbkNvZGUgMiBTUUxpdGUgZGF0YWJhc2UuCioKKiBUaGUgY29ubmVjdGlvbiBpcyBvcGVuZWQgd2l0aCBTUUxJVEVfT1BFTl9SRUFET05MWSBhbmQgYFBSQUdNQSBxdWVyeV9vbmx5YAoqIGlzIGVuYWJsZWQsIHNvIG5vIHN0YXRlbWVudCBjYW4gbXV0YXRlIHRoZSBzZXNzaW9uIHN0b3JlLgoqLwp2YXIgU3FsaXRlU291cmNlID0gY2xhc3MgewoJa2luZCA9ICJzcWxpdGUiOwoJcGF0aDsKCWRiOwoJY29uc3RydWN0b3IocGF0aCkgewoJCXRoaXMucGF0aCA9IHBhdGg7CgkJdHJ5IHsKCQkJdGhpcy5kYiA9IG5ldyBEYXRhYmFzZVN5bmMocGF0aCwgewoJCQkJcmVhZE9ubHk6IHRydWUsCgkJCQllbmFibGVGb3JlaWduS2V5Q29uc3RyYWludHM6IGZhbHNlCgkJCX0pOwoJCQl0aGlzLmRiLmV4ZWMoIlBSQUdNQSBxdWVyeV9vbmx5ID0gT04iKTsKCQl9IGNhdGNoIChlcnJvcikgewoJCQljb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpOwoJCQlpZiAoL2J1c3l8bG9ja2VkL2kudGVzdChtZXNzYWdlKSkgdGhyb3cgbmV3IERhdGFiYXNlQnVzeUVycm9yKGBPcGVuQ29kZSBkYXRhYmFzZSBpcyBsb2NrZWQ6ICR7cGF0aH0uIFRoZSBhbmFseXNpcyBpcyByZWFkLW9ubHk7IHJldHJ5IHdoZW4gdGhlIHNlc3Npb24gaXMgaWRsZS4gKCR7bWVzc2FnZX0pYCk7CgkJCXRocm93IGVycm9yOwoJCX0KCQljb25zdCBzY2hlbWEgPSBkZXRlY3RTY2hlbWEodGhpcy5kYik7CgkJaWYgKHNjaGVtYSAhPT0gInYyIikgewoJCQl0aGlzLmRiLmNsb3NlKCk7CgkJCXRocm93IG5ldyBVbnN1cHBvcnRlZFNjaGVtYUVycm9yKHNjaGVtYSA9PT0gInYxIiA/IGBPcGVuQ29kZSAxIGRhdGFiYXNlIGRldGVjdGVkIGF0ICR7cGF0aH0uIFRoaXMgYnVpbGQgcmVhZHMgT3BlbkNvZGUgMiAoc2Vzc2lvbl92Mi9zZXNzaW9uX21lc3NhZ2UpLmAgOiBgVW5yZWNvZ25pemVkIGRhdGFiYXNlIGF0ICR7cGF0aH0uIEV4cGVjdGVkIE9wZW5Db2RlIDIgdGFibGVzIHNlc3Npb25fdjIgYW5kIHNlc3Npb25fbWVzc2FnZS5gKTsKCQl9Cgl9Cglhc3luYyBsaXN0U2Vzc2lvbnMob3B0aW9ucyA9IHt9KSB7CgkJY29uc3QgbGltaXQgPSBNYXRoLm1heCgxLCBNYXRoLm1pbigxZTMsIG9wdGlvbnMubGltaXQgPz8gMTAwKSk7CgkJY29uc3QgcXVlcnkgPSBvcHRpb25zLnF1ZXJ5Py50cmltKCk7CgkJcmV0dXJuIChxdWVyeSA/IHRoaXMuZGIucHJlcGFyZShgc2VsZWN0ICR7U0VTU0lPTl9DT0xVTU5TfSBmcm9tIHNlc3Npb25fdjIKICAgICAgICAgICAgIHdoZXJlIHRpdGxlIGxpa2UgPyBvciBkaXJlY3RvcnkgbGlrZSA/IG9yIGlkIGxpa2UgPyBvciBzbHVnIGxpa2UgPyBvciBhZ2VudCBsaWtlID8KICAgICAgICAgICAgIG9yZGVyIGJ5IHRpbWVfdXBkYXRlZCBkZXNjIGxpbWl0ID9gKS5hbGwoYCUke3F1ZXJ5fSVgLCBgJSR7cXVlcnl9JWAsIGAlJHtxdWVyeX0lYCwgYCUke3F1ZXJ5fSVgLCBgJSR7cXVlcnl9JWAsIGxpbWl0KSA6IHRoaXMuZGIucHJlcGFyZShgc2VsZWN0ICR7U0VTU0lPTl9DT0xVTU5TfSBmcm9tIHNlc3Npb25fdjIgb3JkZXIgYnkgdGltZV91cGRhdGVkIGRlc2MgbGltaXQgP2ApLmFsbChsaW1pdCkpLm1hcCgocm93KSA9PiBzdW1tYXJ5RnJvbU1ldGEoc2Vzc2lvbk1ldGFGcm9tUm93KHJvd1JlY29yZChyb3cpKSkpOwoJfQoJYXN5bmMgZ2V0U2Vzc2lvbihzZXNzaW9uSUQpIHsKCQljb25zdCByb3cgPSB0aGlzLmRiLnByZXBhcmUoYHNlbGVjdCAke1NFU1NJT05fQ09MVU1OU30gZnJvbSBzZXNzaW9uX3YyIHdoZXJlIGlkID0gP2ApLmdldChzZXNzaW9uSUQpOwoJCXJldHVybiByb3cgPyBzZXNzaW9uTWV0YUZyb21Sb3cocm93UmVjb3JkKHJvdykpIDogbnVsbDsKCX0KCWFzeW5jIGxpc3RNZXNzYWdlcyhzZXNzaW9uSUQsIG9wdGlvbnMgPSB7fSkgewoJCWNvbnN0IGNvbmRpdGlvbnMgPSBbInNlc3Npb25faWQgPSA/Il07CgkJY29uc3QgcGFyYW1zID0gW3Nlc3Npb25JRF07CgkJaWYgKG9wdGlvbnMuZnJvbVNlcSAhPT0gdm9pZCAwKSB7CgkJCWNvbmRpdGlvbnMucHVzaCgic2VxID49ID8iKTsKCQkJcGFyYW1zLnB1c2gob3B0aW9ucy5mcm9tU2VxKTsKCQl9CgkJaWYgKG9wdGlvbnMudG9TZXEgIT09IHZvaWQgMCkgewoJCQljb25kaXRpb25zLnB1c2goInNlcSA8PSA/Iik7CgkJCXBhcmFtcy5wdXNoKG9wdGlvbnMudG9TZXEpOwoJCX0KCQlyZXR1cm4gdGhpcy5kYi5wcmVwYXJlKGBzZWxlY3QgaWQsIHNlc3Npb25faWQsIHR5cGUsIHNlcSwgdGltZV9jcmVhdGVkLCB0aW1lX3VwZGF0ZWQsIGRhdGEKICAgICAgICAgZnJvbSBzZXNzaW9uX21lc3NhZ2Ugd2hlcmUgJHtjb25kaXRpb25zLmpvaW4oIiBhbmQgIil9CiAgICAgICAgIG9yZGVyIGJ5IHNlcSBhc2MsIHRpbWVfY3JlYXRlZCBhc2MsIGlkIGFzY2ApLmFsbCguLi5wYXJhbXMpLm1hcCgocm93KSA9PiB7CgkJCWNvbnN0IHJlY29yZCA9IHJvd1JlY29yZChyb3cpOwoJCQljb25zdCByYXcgPSBzdHIocmVjb3JkLmRhdGEpID8/ICIiOwoJCQlsZXQgZGF0YTsKCQkJdHJ5IHsKCQkJCWRhdGEgPSBKU09OLnBhcnNlKHJhdyk7CgkJCX0gY2F0Y2ggewoJCQkJZGF0YSA9IHsKCQkJCQlfX3BhcnNlRXJyb3I6IHRydWUsCgkJCQkJX19yYXc6IHJhdwoJCQkJfTsKCQkJfQoJCQlyZXR1cm4gewoJCQkJaWQ6IHN0cihyZWNvcmQuaWQpID8/ICIiLAoJCQkJc2Vzc2lvbklEOiBzdHIocmVjb3JkLnNlc3Npb25faWQpID8/IHNlc3Npb25JRCwKCQkJCXR5cGU6IHN0cihyZWNvcmQudHlwZSkgPz8gInVua25vd24iLAoJCQkJc2VxOiBudW0ocmVjb3JkLnNlcSkgPz8gMCwKCQkJCXRpbWVDcmVhdGVkOiBudW0ocmVjb3JkLnRpbWVfY3JlYXRlZCkgPz8gMCwKCQkJCS4uLm51bShyZWNvcmQudGltZV91cGRhdGVkKSAhPT0gbnVsbCA/IHsgdGltZVVwZGF0ZWQ6IG51bShyZWNvcmQudGltZV91cGRhdGVkKSB9IDoge30sCgkJCQlkYXRhCgkJCX07CgkJfSk7Cgl9Cglhc3luYyBtZXNzYWdlQm91bmRzKHNlc3Npb25JRCkgewoJCWNvbnN0IHJvdyA9IHJvd1JlY29yZCh0aGlzLmRiLnByZXBhcmUoInNlbGVjdCBtaW4oc2VxKSBhcyBtaW5TZXEsIG1heChzZXEpIGFzIG1heFNlcSwgY291bnQoKikgYXMgY291bnQgZnJvbSBzZXNzaW9uX21lc3NhZ2Ugd2hlcmUgc2Vzc2lvbl9pZCA9ID8iKS5nZXQoc2Vzc2lvbklEKSk7CgkJcmV0dXJuIHsKCQkJbWluU2VxOiBudW0ocm93Lm1pblNlcSkgPz8gMCwKCQkJbWF4U2VxOiBudW0ocm93Lm1heFNlcSkgPz8gMCwKCQkJY291bnQ6IG51bShyb3cuY291bnQpID8/IDAKCQl9OwoJfQoJYXN5bmMgZ2V0RmFtaWx5KHNlc3Npb25JRCkgewoJCWNvbnN0IGNoYWluID0gW107CgkJY29uc3Qgc2VlbiA9IC8qIEBfX1BVUkVfXyAqLyBuZXcgU2V0KCk7CgkJbGV0IGN1cnNvciA9IGF3YWl0IHRoaXMuZ2V0U2Vzc2lvbihzZXNzaW9uSUQpOwoJCXdoaWxlIChjdXJzb3IgJiYgIXNlZW4uaGFzKGN1cnNvci5pZCkgJiYgY2hhaW4ubGVuZ3RoIDwgNjQpIHsKCQkJc2Vlbi5hZGQoY3Vyc29yLmlkKTsKCQkJY2hhaW4ucHVzaChjdXJzb3IpOwoJCQljdXJzb3IgPSBjdXJzb3IucGFyZW50SUQgPyBhd2FpdCB0aGlzLmdldFNlc3Npb24oY3Vyc29yLnBhcmVudElEKSA6IG51bGw7CgkJfQoJCWlmIChjaGFpbi5sZW5ndGggPT09IDApIHJldHVybiB7CgkJCXJvb3RJRDogc2Vzc2lvbklELAoJCQlwYXJlbnQ6IG51bGwsCgkJCWNoaWxkcmVuOiBbXQoJCX07CgkJY29uc3Qgcm9vdCA9IGNoYWluW2NoYWluLmxlbmd0aCAtIDFdOwoJCWNvbnN0IHBhcmVudE1ldGEgPSBjaGFpbi5sZW5ndGggPiAxID8gY2hhaW5bMV0gOiBudWxsOwoJCWNvbnN0IGNoaWxkUm93cyA9IHRoaXMuZGIucHJlcGFyZShgc2VsZWN0ICR7U0VTU0lPTl9DT0xVTU5TfSBmcm9tIHNlc3Npb25fdjIgd2hlcmUgcGFyZW50X2lkID0gPyBvcmRlciBieSB0aW1lX2NyZWF0ZWQgYXNjIGxpbWl0IDUwMGApLmFsbChzZXNzaW9uSUQpOwoJCXJldHVybiB7CgkJCXJvb3RJRDogcm9vdC5pZCwKCQkJcGFyZW50OiBwYXJlbnRNZXRhID8gc3VtbWFyeUZyb21NZXRhKHBhcmVudE1ldGEpIDogbnVsbCwKCQkJY2hpbGRyZW46IGNoaWxkUm93cy5tYXAoKHJvdykgPT4gc3VtbWFyeUZyb21NZXRhKHNlc3Npb25NZXRhRnJvbVJvdyhyb3dSZWNvcmQocm93KSkpKQoJCX07Cgl9CgljbG9zZSgpIHsKCQl0cnkgewoJCQl0aGlzLmRiLmNsb3NlKCk7CgkJfSBjYXRjaCB7fQoJfQp9OwovLyBzcmMvY29yZS9hZGFwdGVycy9zcWxpdGUtd29ya2VyLnRzCnZhciBwb3J0ID0gcGFyZW50UG9ydDsKaWYgKCFwb3J0KSB0aHJvdyBuZXcgRXJyb3IoInNxbGl0ZSB3b3JrZXIgcmVxdWlyZXMgYSBwYXJlbnQgcG9ydCIpOwp2YXIgc291cmNlID0gbnVsbDsKcG9ydC5vbigibWVzc2FnZSIsIGFzeW5jIChtZXNzYWdlKSA9PiB7Cgljb25zdCB7IGlkLCBtZXRob2QsIGFyZ3MgfSA9IG1lc3NhZ2U7Cgl0cnkgewoJCWlmIChtZXRob2QgPT09ICJpbml0IikgewoJCQlzb3VyY2UgPSBuZXcgU3FsaXRlU291cmNlKFN0cmluZyhhcmdzWzBdKSk7CgkJCXBvcnQucG9zdE1lc3NhZ2UoewoJCQkJaWQsCgkJCQlvazogdHJ1ZSwKCQkJCXZhbHVlOiB0cnVlCgkJCX0pOwoJCQlyZXR1cm47CgkJfQoJCWlmIChtZXRob2QgPT09ICJjbG9zZSIpIHsKCQkJc291cmNlPy5jbG9zZSgpOwoJCQlzb3VyY2UgPSBudWxsOwoJCQlwb3J0LnBvc3RNZXNzYWdlKHsKCQkJCWlkLAoJCQkJb2s6IHRydWUsCgkJCQl2YWx1ZTogdHJ1ZQoJCQl9KTsKCQkJcmV0dXJuOwoJCX0KCQlpZiAoIXNvdXJjZSkgdGhyb3cgbmV3IEVycm9yKCJzcWxpdGUgc291cmNlIGlzIG5vdCBpbml0aWFsaXplZCIpOwoJCWNvbnN0IHZhbHVlID0gYXdhaXQgc291cmNlW21ldGhvZF0oLi4uYXJncyk7CgkJcG9ydC5wb3N0TWVzc2FnZSh7CgkJCWlkLAoJCQlvazogdHJ1ZSwKCQkJdmFsdWUKCQl9KTsKCX0gY2F0Y2ggKGVycm9yKSB7CgkJY29uc3QgbmFtZSA9IGVycm9yIGluc3RhbmNlb2YgRGF0YWJhc2VCdXN5RXJyb3IgPyAiRGF0YWJhc2VCdXN5RXJyb3IiIDogZXJyb3IgaW5zdGFuY2VvZiBVbnN1cHBvcnRlZFNjaGVtYUVycm9yID8gIlVuc3VwcG9ydGVkU2NoZW1hRXJyb3IiIDogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm5hbWUgOiAiRXJyb3IiOwoJCXBvcnQucG9zdE1lc3NhZ2UoewoJCQlpZCwKCQkJb2s6IGZhbHNlLAoJCQllcnJvcjogewoJCQkJbmFtZSwKCQkJCW1lc3NhZ2U6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKQoJCQl9CgkJfSk7Cgl9Cn0pOwpleHBvcnQge307Cg=="));
		this.worker.on("message", (message) => {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.ok) pending.resolve(message.value);
			else pending.reject(reviveError(message.error ?? {
				name: "Error",
				message: "Worker error"
			}));
		});
		this.worker.on("error", (error) => {
			const err = error instanceof Error ? error : new Error(String(error));
			this.failure = err;
			this.failAll(err);
		});
		this.worker.on("exit", (code) => {
			if (!this.closed && code !== 0) {
				const error = /* @__PURE__ */ new Error(`SQLite worker exited with code ${code}`);
				this.failure = error;
				this.failAll(error);
			}
		});
		this.readyPromise = this.call("init", path);
		this.readyPromise.catch(() => {});
	}
	ready() {
		return this.readyPromise;
	}
	listSessions(options = {}) {
		return this.call("listSessions", options);
	}
	getSession(sessionID) {
		return this.call("getSession", sessionID);
	}
	listMessages(sessionID, options = {}) {
		return this.call("listMessages", sessionID, options);
	}
	getFamily(sessionID) {
		return this.call("getFamily", sessionID);
	}
	messageBounds(sessionID) {
		return this.call("messageBounds", sessionID);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(/* @__PURE__ */ new Error("SQLite worker closed"));
		this.pending.clear();
		this.worker.terminate();
	}
	call(method, ...args) {
		if (this.closed) return Promise.reject(/* @__PURE__ */ new Error("SQLite worker closed"));
		if (this.failure) return Promise.reject(this.failure);
		const id = this.nextID++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve,
				reject
			});
			this.worker.postMessage({
				id,
				method,
				args
			});
		});
	}
	failAll(error) {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
};
function openWorkerSqliteSource(path) {
	return new WorkerSqliteSource(path);
}
// src/server/auth.ts
var TOKEN_HEADER = "x-observability-token";
function generateToken() {
	return randomBytes(32).toString("base64url");
}
function digest(value) {
	return createHash("sha256").update(value, "utf8").digest();
}
/**
* Hashes both values first so the comparison is constant-time regardless of
* the supplied token's length. `timingSafeEqual` requires equal-length buffers;
* SHA-256 digests always are.
*/
function tokenMatches(expected, supplied) {
	if (!supplied) return false;
	return timingSafeEqual(digest(expected), digest(supplied));
}
/** Accepts `Authorization: Bearer <token>` or the dedicated header. */
function requestToken(req) {
	const authorization = req.headers.authorization;
	if (typeof authorization === "string") {
		const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
		if (match) {
			const value = match[1].trim();
			if (value.length > 0) return value;
		}
	}
	const header = req.headers[TOKEN_HEADER];
	if (typeof header === "string") {
		const value = header.trim();
		if (value.length > 0) return value;
	}
}
function isAuthorized(req, expected) {
	return tokenMatches(expected, requestToken(req));
}
// src/server/opencode-theme.ts
/**
* OpenCode 2 keeps the TUI theme in its CLI config (`cli.json`), separate from
* the project config. The observed profile layout is
* `~/.opencode2/config/opencode/cli.json`; the XDG and platform locations are
* checked as fallbacks.
*/
function candidateCliConfigPaths(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = options.home ?? homedir();
	const paths = [];
	const push = (value) => {
		if (!value) return;
		const normalized = resolve(value);
		if (!paths.some((item) => item.toLowerCase() === normalized.toLowerCase())) paths.push(normalized);
	};
	push(options.configPath);
	push(env.OPENCODE_CLI_CONFIG);
	if (env.OPENCODE_CONFIG_DIR) push(join(env.OPENCODE_CONFIG_DIR, "opencode", "cli.json"));
	push(join(home, ".opencode2", "config", "opencode", "cli.json"));
	push(join(home, ".opencode2", "config-fm", "opencode", "cli.json"));
	const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
	push(join(xdg, "opencode", "cli.json"));
	if (platform === "win32" && env.APPDATA) push(join(env.APPDATA, "opencode", "cli.json"));
	if (platform === "darwin") push(join(home, "Library", "Application Support", "opencode", "cli.json"));
	return paths;
}
function parseTheme(value) {
	if (typeof value === "string") {
		const name = value.trim();
		return name ? { name } : null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value;
	const name = typeof record.name === "string" ? record.name.trim() : "";
	if (!name) return null;
	const mode = record.mode === "system" || record.mode === "dark" || record.mode === "light" ? record.mode : void 0;
	return mode ? {
		name,
		mode
	} : { name };
}
/**
* The CLI theme is process-static configuration: OpenCode writes it once and a
* running server never needs to observe a mid-process change. The discovery
* result is therefore cached after the first lookup for a given candidate
* path list, and a failed lookup is cached exactly like a successful one (a
* malformed or absent config cannot become a per-request filesystem read).
*/
var cachedLookup = null;
var fileReads = 0;
/** Returns the theme currently selected in OpenCode 2, or null when unknown. */
function readOpenCodeTheme(options = {}) {
	const paths = options.configPath ? [resolve(options.configPath)] : candidateCliConfigPaths(options);
	const key = paths.join("\n");
	if (cachedLookup !== null && cachedLookup.key === key) return cachedLookup.theme;
	let theme = null;
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			fileReads += 1;
			theme = parseTheme(JSON.parse(readFileSync(path, "utf8")).theme);
			if (theme) break;
		} catch {}
	}
	cachedLookup = {
		key,
		theme
	};
	return theme;
}
// src/core/types.ts
var EMPTY_TOKENS = {
	input: 0,
	output: 0,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function metric(value, basis, note) {
	return value === null || !Number.isFinite(value) ? note ? {
		value: null,
		basis: "unavailable",
		note
	} : {
		value: null,
		basis: "unavailable"
	} : note ? {
		value,
		basis,
		note
	} : {
		value,
		basis
	};
}
// src/core/metrics.ts
function addTokens(total, tokens) {
	if (!tokens) return total;
	return {
		input: total.input + tokens.input,
		output: total.output + tokens.output,
		reasoning: total.reasoning + tokens.reasoning,
		cacheRead: total.cacheRead + tokens.cacheRead,
		cacheWrite: total.cacheWrite + tokens.cacheWrite
	};
}
function sumTokens(values) {
	let tokens = { ...EMPTY_TOKENS };
	let present = 0;
	for (const value of values) if (value) {
		tokens = addTokens(tokens, value);
		present++;
	}
	return {
		tokens,
		complete: present === values.length,
		count: present,
		missing: values.length - present
	};
}
/**
* Prompt size for one model call.
*
* OpenCode 2 normalizes provider usage so `input` excludes cache tokens;
* cached prompt tokens live in `cache.read` / `cache.write`. The prompt is
* therefore their sum. This is a derived metric.
*/
function promptTokensMetric(tokens) {
	if (!tokens) return metric(null, "unavailable", "token usage was not recorded");
	return metric(tokens.input + tokens.cacheRead + tokens.cacheWrite, "derived", "input + cache read + cache write");
}
/** `cache read / prompt tokens`, as a ratio in [0, 1]. */
function cacheHitRateMetric(tokens) {
	if (!tokens) return metric(null, "unavailable", "token usage was not recorded");
	const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	if (prompt <= 0) return metric(null, "unavailable", "prompt size is zero");
	return metric(tokens.cacheRead / prompt, "derived", "cache read / prompt tokens");
}
function weightedCacheHitRate(values) {
	let cacheRead = 0;
	let prompt = 0;
	let present = 0;
	for (const value of values) {
		if (!value) continue;
		present++;
		cacheRead += value.cacheRead;
		prompt += value.input + value.cacheRead + value.cacheWrite;
	}
	if (present === 0) return metric(null, "unavailable", "no token usage recorded");
	if (prompt <= 0) return metric(null, "unavailable", "prompt size is zero");
	return metric(cacheRead / prompt, "derived", "token-weighted cache read / prompt");
}
/** Difference between two recorded timestamps. */
function durationMetric(start, end, options = {}) {
	if (options.startUnknown) return metric(null, "unavailable", "start is outside the loaded window");
	if (start === null || end === null) return metric(null, "unavailable", options.note ?? "start or end timestamp missing");
	if (end < start) return metric(null, "unavailable", "end timestamp precedes start timestamp");
	return metric(end - start, "derived", options.incomplete ? "incomplete step; end is the last recorded timestamp" : void 0);
}
/**
* Provider generation window: `time.created` -> `time.streamed`.
*
* `time.streamed` is documented as "when the provider response body ended,
* before tool settlement". If it is absent, the only safe fallback (no tool
* calls) is `completed`, marked estimated.
*/
function modelTimeMetric(time, toolCount, startUnknown = false) {
	if (startUnknown) return metric(null, "unavailable", "start is outside the loaded window");
	const created = time.created ?? null;
	const streamed = time.streamed ?? null;
	if (created !== null && streamed !== null && streamed >= created) return metric(streamed - created, "derived", "created -> streamed (model generation)");
	if (created !== null && streamed === null && toolCount === 0 && time.completed != null) return metric(time.completed - created, "estimated", "streamed timestamp missing; completed - created, no tool settlement");
	return metric(null, "unavailable", streamed === null ? "OpenCode did not record time.streamed for this step" : "inconsistent timestamps");
}
function toolDurationMetric(tool) {
	const end = tool.completedAt ?? null;
	if (end === null) return metric(null, "unavailable", tool.status === "running" || tool.status === "streaming" ? "tool had not completed when the step was recorded" : "tool completion timestamp missing");
	const start = tool.ranAt ?? tool.createdAt ?? null;
	if (start === null) return metric(null, "unavailable", "tool start timestamp missing");
	return metric(Math.max(0, end - start), "derived", tool.ranAt == null ? "ran timestamp missing; created -> completed" : "ran -> completed");
}
function sumMetrics(values, note) {
	const available = values.filter((value) => value.value !== null);
	if (available.length === 0) return metric(null, "unavailable", note ?? "no component was available");
	const total = available.reduce((sum, value) => sum + (value.value ?? 0), 0);
	const estimated = available.some((value) => value.basis === "estimated");
	const merged = [note, available.length !== values.length ? `${values.length - available.length} component(s) unavailable` : null].filter(Boolean).join("; ");
	return metric(total, estimated ? "estimated" : "derived", merged.length > 0 ? merged : void 0);
}
function differenceMetric$1(total, ...parts) {
	if (total.value === null) return metric(null, "unavailable", "total duration is unavailable");
	if (parts.some((part) => part.value === null)) return metric(null, "unavailable", "a component duration is unavailable");
	const value = total.value - parts.reduce((sum, part) => sum + (part.value ?? 0), 0);
	return metric(value, total.basis === "estimated" || parts.some((part) => part.basis === "estimated") ? "estimated" : "derived", value < 0 ? "negative residual: model and tool windows overlap" : "total - model - tool");
}
function outputSpeedMetric(outputTokens, modelTime) {
	if (outputTokens === null) return metric(null, "unavailable", "output token count missing");
	if (modelTime.value === null || modelTime.value <= 0) return metric(null, "unavailable", "model generation time is unavailable or zero");
	return metric(outputTokens / (modelTime.value / 1e3), modelTime.basis === "estimated" ? "estimated" : "derived", "output tokens / model generation seconds");
}
function contextDeltaMetric(current, previous) {
	if (current.value === null) return metric(null, "unavailable", "current context size is unavailable");
	if (!previous) return metric(null, "unavailable", "no previous turn");
	if (previous.value === null) return metric(null, "unavailable", "previous context size is unavailable");
	return metric(current.value - previous.value, "derived", "final prompt size minus previous turn's final prompt size");
}
// src/core/normalize.ts
var EMPTY_FLAGS = {
	error: false,
	retry: false,
	compaction: false,
	context: false,
	subagent: false,
	approval: false,
	uncertain: false
};
function orderKey(seq, order, messageID) {
	return `${String(seq).padStart(12, "0")}:${String(order + 10).padStart(4, "0")}:${messageID}`;
}
function flag(flags, updates) {
	return {
		...flags,
		...updates,
		uncertain: false
	};
}
function withUncertainty(event) {
	const unique = [...new Set(event.uncertainty)];
	return {
		...event,
		uncertainty: unique,
		flags: {
			...event.flags,
			uncertain: unique.length > 0
		}
	};
}
function eventBase(message, values) {
	const text = values.text ?? null;
	return withUncertainty({
		id: values.id,
		messageID: message.id,
		sessionID: message.sessionID,
		seq: message.seq,
		order: values.order,
		orderKey: orderKey(message.seq, values.order, message.id),
		timestamp: values.timestamp,
		endTimestamp: values.endTimestamp ?? null,
		kind: values.kind,
		actor: values.actor,
		title: values.title,
		text,
		textPreview: text === null ? null : preview(text, 240),
		agent: values.agent ?? null,
		model: values.model ?? null,
		provider: values.provider ?? values.model?.providerID ?? null,
		status: values.status ?? null,
		tool: values.tool ?? null,
		tokens: values.tokens ?? null,
		cost: values.cost ?? null,
		stepID: values.stepID ?? null,
		turnID: null,
		flags: values.flags ?? EMPTY_FLAGS,
		uncertainty: values.uncertainty ?? [],
		payload: values.payload ?? message.data,
		meta: values.meta
	});
}
function timeRecord(data) {
	return asRecord(data.time);
}
function messageTimestamp(data, fallback) {
	return toMillis(timeRecord(data).created) ?? fallback;
}
function toolStatus(value) {
	return value === "streaming" || value === "running" || value === "completed" || value === "error" ? value : "unknown";
}
function toolError(value) {
	const record = asRecord(value);
	const type = str(record.type);
	const message = str(record.message);
	if (!type && !message) return null;
	const out = {
		type: type ?? "unknown",
		message: message ?? ""
	};
	const status = num(record.status);
	if (status !== null) out.status = status;
	const retryAfterMs = num(record.retryAfterMs);
	if (retryAfterMs !== null) out.retryAfterMs = retryAfterMs;
	return out;
}
function outputFromContent(value) {
	const parts = [];
	for (const item of asArray$1(value)) {
		const type = str(item.type);
		if (type === "text") {
			const text = str(item.text);
			if (text !== null) parts.push(text);
		} else if (type === "file") {
			const name = str(item.name) ?? str(item.uri) ?? "file";
			parts.push(`[file] ${name}`);
		}
	}
	return parts.length > 0 ? parts.join("\n") : null;
}
function childSessionIDs(toolName, output, metadata, input) {
	const found = /* @__PURE__ */ new Set();
	if (output) {
		const pattern = /<subagent\b[^>]*\bsessionID="([^"]+)"/gi;
		let match;
		while ((match = pattern.exec(output)) !== null) if (match[1]) found.add(match[1]);
	}
	if (metadata) for (const key of [
		"sessionID",
		"sessionId",
		"childSessionID",
		"childSessionId"
	]) {
		const value = str(metadata[key]);
		if (value && value.startsWith("ses_")) found.add(value);
	}
	if (toolName === "subagent" || toolName === "task") {
		const record = asRecord(input);
		for (const key of [
			"sessionID",
			"sessionId",
			"childSessionID",
			"childSessionId"
		]) {
			const value = str(record[key]);
			if (value && value.startsWith("ses_")) found.add(value);
		}
	}
	return [...found];
}
function toolDetail(block) {
	const state = asRecord(block.state);
	const status = toolStatus(state.status);
	const input = parseJson(state.input);
	const output = outputFromContent(state.content);
	const metadata = Object.keys(asRecord(state.metadata)).length > 0 ? asRecord(state.metadata) : null;
	const error = toolError(state.error);
	const time = asRecord(block.time);
	const createdAt = toMillis(time.created);
	const ranAt = toMillis(time.ran);
	const completedAt = toMillis(time.completed);
	const name = str(block.name) ?? "unknown";
	const duration = toolDurationMetric({
		createdAt,
		ranAt,
		completedAt,
		status
	});
	return {
		callID: str(block.id) ?? "",
		name,
		status,
		input,
		inputPreview: preview(input, 240),
		output,
		outputPreview: output === null ? null : preview(output, 240),
		error,
		metadata,
		createdAt,
		ranAt,
		completedAt,
		duration,
		childSessionIDs: childSessionIDs(name, output, metadata, input),
		executed: bool$1(block.executed),
		...bool$1(asRecord(metadata).truncated) === true ? { outputTruncated: true } : {}
	};
}
function assistantStatus(data, content) {
	const error = asRecord(data.error);
	const retry = asRecord(data.retry);
	const finish = str(data.finish);
	const completed = toMillis(timeRecord(data).completed);
	const uncertainty = [];
	const flags = {};
	if (Object.keys(error).length > 0 || finish === "error") {
		flags.error = true;
		const type = str(error.type) ?? "";
		const message = str(error.message) ?? "";
		if (type === "aborted" || /interrupt/i.test(type) || /interrupt/i.test(message)) return {
			status: "interrupted",
			flags,
			uncertainty
		};
		return {
			status: "error",
			flags,
			uncertainty
		};
	}
	if (retry.attempt !== void 0) {
		flags.retry = true;
		uncertainty.push("retry-derived");
	}
	if (completed === null) {
		uncertainty.push("step-incomplete");
		return {
			status: "incomplete",
			flags,
			uncertainty
		};
	}
	if (content.length === 0) uncertainty.push("empty-assistant-content");
	return {
		status: finish ?? "completed",
		flags,
		uncertainty
	};
}
function provenanceEvent(session, index) {
	const lines = [];
	const flags = {};
	if (session.parentID) lines.push(`Spawned by parent session ${session.parentID}.`);
	if (session.fork) {
		lines.push(`Forked from ${session.fork.sessionID}${session.fork.boundary ? ` (boundary: ${safeStringify(session.fork.boundary)})` : ""}.`);
		flags.uncertain = true;
	}
	if (session.revert) {
		lines.push(`Revert staged: ${safeStringify(session.revert)}.`);
		flags.uncertain = true;
	}
	if (session.resumeAttempts !== void 0 && session.resumeAttempts > 0) {
		lines.push(`Resume attempts recorded: ${session.resumeAttempts}.`);
		flags.uncertain = true;
	}
	if (session.suspendedAt !== void 0 && session.suspendedAt > 0) {
		lines.push(`Session was suspended at ${new Date(session.suspendedAt).toISOString()}.`);
		flags.uncertain = true;
	}
	if (lines.length === 0) return null;
	return {
		id: `session:${session.id}:${index}`,
		messageID: `session:${session.id}`,
		sessionID: session.id,
		seq: 0,
		order: -10 + index,
		orderKey: orderKey(0, -10 + index, `session:${session.id}`),
		timestamp: session.time.created,
		endTimestamp: null,
		kind: "session",
		actor: "session",
		title: "Session provenance",
		text: lines.join("\n"),
		textPreview: preview(lines.join(" "), 240),
		agent: session.agent ?? null,
		model: session.model ?? null,
		provider: session.model?.providerID ?? null,
		status: session.outcome ?? null,
		tool: null,
		tokens: null,
		cost: null,
		stepID: null,
		turnID: null,
		flags: {
			...EMPTY_FLAGS,
			...flags,
			uncertain: true
		},
		uncertainty: ["derived-from-session-metadata"],
		payload: {
			parentID: session.parentID,
			fork: session.fork,
			revert: session.revert,
			resumeAttempts: session.resumeAttempts,
			suspendedAt: session.suspendedAt
		},
		meta: { derived: true }
	};
}
/**
* Normalizes persisted OpenCode messages into a single ordered event stream.
* The recorded `seq` order is authoritative; timestamps that regress are
* flagged, never re-sorted.
*/
function normalizeMessages(messages, options = {}) {
	const sorted = [...messages].sort((a, b) => {
		if (a.seq !== b.seq) return a.seq - b.seq;
		if (a.timeCreated !== b.timeCreated) return a.timeCreated - b.timeCreated;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	const events = [];
	const session = options.session ?? null;
	if (session) {
		let marker = 0;
		const provenance = provenanceEvent(session, marker++);
		if (provenance) events.push(provenance);
	}
	let previousMessageTime = null;
	for (const message of sorted) {
		const data = asRecord(parseJson(message.data));
		const type = str(data.type) ?? message.type ?? "unknown";
		const time = timeRecord(data);
		const messageTime = messageTimestamp(data, message.timeCreated);
		const timestampMissing = !Number.isFinite(messageTime) || messageTime <= 0;
		const regression = previousMessageTime !== null && messageTime + 1e3 < previousMessageTime;
		previousMessageTime = messageTime;
		const baseUncertainty = [];
		if (regression) baseUncertainty.push("timestamp-regression");
		if (timestampMissing) baseUncertainty.push("timestamp-missing");
		const add = (event) => {
			const withBase = baseUncertainty.length ? withUncertainty({
				...event,
				uncertainty: [...event.uncertainty, ...baseUncertainty]
			}) : event;
			events.push(withBase);
		};
		switch (type) {
			case "user": {
				const text = str(data.text) ?? "";
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					kind: "user",
					actor: "user",
					title: session?.parentID ? "Subagent prompt" : "User message",
					text,
					agent: null,
					model: null,
					flags: EMPTY_FLAGS,
					payload: data,
					meta: {
						files: asArray$1(data.files).length,
						agents: asArray$1(data.agents).map((item) => str(asRecord(item).name)).filter(Boolean),
						skills: asArray$1(data.skills).map((item) => str(asRecord(item).name)).filter(Boolean)
					}
				}));
				break;
			}
			case "assistant": {
				const content = asArray$1(data.content);
				const agent = str(data.agent);
				const model = normalizeModel(data.model);
				const tokens = normalizeTokens(data.tokens);
				const cost = num(data.cost);
				const status = assistantStatus(data, content);
				const responseText = content.map((item) => {
					const block = asRecord(item);
					return str(block.type) === "text" ? str(block.text) : null;
				}).filter((value) => value !== null).join("\n\n");
				const reasoningText = content.map((item) => {
					const block = asRecord(item);
					return str(block.type) === "reasoning" ? str(block.text) : null;
				}).filter((value) => value !== null).join("\n\n");
				const flags = flag(EMPTY_FLAGS, status.flags);
				const end = toMillis(time.completed) ?? toMillis(time.streamed) ?? null;
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					endTimestamp: end,
					kind: "assistant",
					actor: "assistant",
					title: `Assistant step${status.flags.error ? " (error)" : ""}`,
					text: reasoningText || responseText || null,
					agent,
					model,
					status: status.status,
					tokens,
					cost,
					stepID: message.id,
					flags,
					uncertainty: status.uncertainty,
					payload: data,
					meta: {
						finish: str(data.finish),
						rawFinish: str(data.rawFinish),
						blockCount: content.length,
						responseText,
						reasoningText
					}
				}));
				content.forEach((item, index) => {
					const block = asRecord(item);
					const blockType = str(block.type);
					const blockTime = asRecord(block.time);
					const blockCreated = toMillis(blockTime.created);
					const blockCompleted = toMillis(blockTime.completed);
					if (blockType === "reasoning") {
						const text = str(block.text) ?? "";
						add(eventBase(message, {
							id: `${message.id}:${index}`,
							order: index,
							timestamp: blockCreated ?? messageTime,
							endTimestamp: blockCompleted,
							kind: "reasoning",
							actor: "assistant",
							title: "Reasoning",
							text,
							agent,
							model,
							status: null,
							stepID: message.id,
							flags: EMPTY_FLAGS,
							uncertainty: blockCreated === null ? ["timestamp-approximate"] : [],
							payload: block
						}));
					} else if (blockType === "text") {
						const text = str(block.text) ?? "";
						add(eventBase(message, {
							id: `${message.id}:${index}`,
							order: index,
							timestamp: messageTime,
							kind: "text",
							actor: "assistant",
							title: "Assistant text",
							text,
							agent,
							model,
							status: null,
							stepID: message.id,
							flags: EMPTY_FLAGS,
							payload: block,
							meta: { timestampApproximate: true }
						}));
					} else if (blockType === "tool") {
						const tool = toolDetail(block);
						const toolFlags = flag(EMPTY_FLAGS, {
							error: tool.status === "error" || tool.error !== null,
							subagent: tool.name === "subagent" || tool.name === "task" || tool.childSessionIDs.length > 0
						});
						const uncertainty = [];
						if (tool.status === "running" || tool.status === "streaming") uncertainty.push("tool-not-finished");
						if (tool.createdAt === null && tool.ranAt === null) uncertainty.push("tool-time-missing");
						add(eventBase(message, {
							id: `${message.id}:${index}`,
							order: index,
							timestamp: tool.createdAt ?? messageTime,
							endTimestamp: tool.completedAt,
							kind: "tool",
							actor: "tool",
							title: `Tool: ${tool.name}`,
							text: tool.output,
							agent,
							model,
							status: tool.status,
							tool,
							stepID: message.id,
							flags: toolFlags,
							uncertainty,
							payload: block,
							meta: {
								delegatedAgent: str(asRecord(tool.input).agent),
								description: str(asRecord(tool.input).description)
							}
						}));
					} else add(eventBase(message, {
						id: `${message.id}:${index}`,
						order: index,
						timestamp: messageTime,
						kind: "unknown",
						actor: "assistant",
						title: `Unknown content block: ${blockType ?? "?"}`,
						text: safeStringify(block).slice(0, 400),
						agent,
						model,
						stepID: message.id,
						flags: EMPTY_FLAGS,
						uncertainty: ["unknown-content-block"],
						payload: block
					}));
				});
				const retry = asRecord(data.retry);
				if (Object.keys(retry).length > 0) {
					const retryTime = toMillis(retry.at) ?? messageTime;
					const retryError = asRecord(retry.error);
					add(eventBase(message, {
						id: `${message.id}:retry`,
						order: 1e3,
						timestamp: retryTime,
						kind: "retry",
						actor: "assistant",
						title: `Retry #${num(retry.attempt) ?? "?"}`,
						text: str(retryError.message) ?? null,
						agent,
						model,
						status: "retry",
						stepID: message.id,
						flags: flag(EMPTY_FLAGS, {
							retry: true,
							error: true
						}),
						payload: retry,
						meta: {
							attempt: num(retry.attempt),
							error: retryError,
							derived: true
						}
					}));
				}
				const error = asRecord(data.error);
				if (Object.keys(error).length > 0) add(eventBase(message, {
					id: `${message.id}:error`,
					order: 1001,
					timestamp: toMillis(time.streamed) ?? toMillis(time.completed) ?? messageTime,
					kind: "error",
					actor: "assistant",
					title: status.status === "interrupted" ? `Step interruption: ${str(error.type) ?? "unknown"}` : `Step error: ${str(error.type) ?? "unknown"}`,
					text: str(error.message) ?? null,
					agent,
					model,
					status: status.status,
					stepID: message.id,
					flags: flag(EMPTY_FLAGS, { error: true }),
					payload: error,
					meta: {
						error,
						derived: true
					}
				}));
				break;
			}
			case "synthetic": {
				const text = str(data.text) ?? "";
				const metadata = asRecord(data.metadata);
				const source = str(metadata.source);
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					kind: "synthetic",
					actor: "system",
					title: `Synthetic message${source ? ` (${source})` : ""}`,
					text,
					status: str(metadata.state),
					flags: EMPTY_FLAGS,
					payload: data,
					meta: metadata
				}));
				break;
			}
			case "system": {
				const text = str(data.text) ?? "";
				const metadata = asRecord(data.metadata);
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					kind: "system",
					actor: "system",
					title: str(data.description) ?? "System update",
					text,
					flags: flag(EMPTY_FLAGS, { context: true }),
					payload: data,
					meta: metadata
				}));
				break;
			}
			case "skill": {
				const text = str(data.text) ?? "";
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					kind: "skill",
					actor: "system",
					title: `Skill: ${str(data.name) ?? str(data.skill) ?? "unknown"}`,
					text,
					flags: flag(EMPTY_FLAGS, { context: true }),
					payload: data,
					meta: { skill: str(data.skill) }
				}));
				break;
			}
			case "shell": {
				const output = asRecord(data.output);
				const text = str(output.output) ?? "";
				const status = str(data.status) ?? "unknown";
				const exit = num(data.exit);
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					endTimestamp: toMillis(time.completed),
					kind: "shell",
					actor: "tool",
					title: `Shell: ${truncate(str(data.command) ?? "unknown", 120)}`,
					text,
					status,
					flags: flag(EMPTY_FLAGS, { error: status === "timeout" || status === "killed" }),
					payload: data,
					meta: {
						shellID: str(data.shellID),
						exit,
						truncated: bool$1(output.truncated)
					}
				}));
				break;
			}
			case "compaction": {
				const summary = str(data.summary) ?? "";
				const tokens = normalizeTokens(data.tokens);
				const model = normalizeModel(data.model);
				const reason = str(data.reason);
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					kind: "compaction",
					actor: "system",
					title: `Compaction (${reason ?? "unknown"})${str(data.status) ? ` · ${str(data.status)}` : ""}`,
					text: summary,
					model,
					status: str(data.status),
					tokens,
					cost: num(data.cost),
					flags: flag(EMPTY_FLAGS, {
						compaction: true,
						context: true
					}),
					payload: data,
					meta: {
						reason,
						summaryChars: summary.length,
						recentChars: (str(data.recent) ?? "").length,
						keepID: str(asRecord(data.metadata).keepID)
					}
				}));
				break;
			}
			case "agent-switched": {
				const agent = str(data.agent);
				const previous = str(data.previous);
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					kind: "agent-switched",
					actor: "session",
					title: `Agent switched: ${previous ?? "?"} -> ${agent ?? "?"}`,
					agent,
					flags: EMPTY_FLAGS,
					payload: data,
					meta: { previous }
				}));
				break;
			}
			case "model-switched": {
				const model = normalizeModel(data.model);
				const previous = normalizeModel(data.previous);
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					kind: "model-switched",
					actor: "session",
					title: `Model switched: ${modelLabel$2(model) ?? "?"}${previous ? ` (was ${modelLabel$2(previous)})` : ""}`,
					model,
					flags: EMPTY_FLAGS,
					payload: data,
					meta: { previous }
				}));
				break;
			}
			case "location-switched": {
				const location = asRecord(data.location);
				const previous = asRecord(asRecord(data.previous).location);
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					kind: "location-switched",
					actor: "session",
					title: `Location changed: ${str(location.directory) ?? "?"}`,
					text: str(location.directory) ?? null,
					flags: EMPTY_FLAGS,
					payload: data,
					meta: {
						directory: str(location.directory),
						previous: str(previous.directory),
						projectID: str(data.projectID),
						subpath: str(data.subpath)
					}
				}));
				break;
			}
			case "idle": {
				const outcome = str(data.outcome) ?? "unknown";
				const error = asRecord(data.error);
				add(eventBase(message, {
					id: message.id,
					order: -1,
					timestamp: messageTime,
					kind: "idle",
					actor: "session",
					title: `Idle: ${outcome}`,
					text: str(error.message) ?? null,
					status: outcome,
					flags: flag(EMPTY_FLAGS, { error: outcome === "failed" || outcome === "interrupted" }),
					payload: data,
					meta: {
						outcome,
						error
					}
				}));
				break;
			}
			default: add(eventBase(message, {
				id: message.id,
				order: -1,
				timestamp: messageTime,
				kind: "unknown",
				actor: "unknown",
				title: `Unknown message type: ${type}`,
				text: preview(data, 400),
				flags: EMPTY_FLAGS,
				uncertainty: ["unknown-message-type"],
				payload: data
			}));
		}
	}
	return events;
}
function eventSearchCorpus(event) {
	const parts = [
		event.title,
		event.kind,
		event.agent ?? "",
		event.model?.id ?? "",
		event.model?.providerID ?? "",
		event.status ?? "",
		event.tool?.name ?? "",
		typeof event.meta?.delegatedAgent === "string" ? event.meta.delegatedAgent : "",
		event.text ?? ""
	];
	if (event.tool) {
		parts.push(safeStringify(event.tool.input));
		parts.push(event.tool.output ?? "");
	}
	parts.push(safeStringify(event.payload));
	return parts.join("\n").toLowerCase();
}
// src/core/project.ts
function stepStatus(event) {
	const status = event.status ?? "";
	if (status === "error") return "error";
	if (status === "interrupted" || status === "aborted") return "interrupted";
	if (status === "incomplete") return "incomplete";
	if (status === "running") return "running";
	if (status === "stop" || status === "tool-calls" || status === "length" || status === "content-filter") return "completed";
	if (status === "completed") return "completed";
	return event.endTimestamp === null ? "incomplete" : "completed";
}
function turnStatus(turn, sessionActive) {
	if (turn.idleOutcome === "succeeded") return "completed";
	if (turn.idleOutcome === "failed") return "error";
	if (turn.idleOutcome === "interrupted") return "interrupted";
	const steps = turn.steps;
	if (steps.length === 0) return "unknown";
	if (steps.some((step) => step.status === "error")) return "error";
	if (steps.some((step) => step.status === "interrupted")) return "interrupted";
	if (sessionActive) return "running";
	if (steps.every((step) => step.status === "completed")) return "completed";
	return "incomplete";
}
function isStepEvent(event) {
	return event.kind === "assistant" || event.kind === "reasoning" || event.kind === "text" || event.kind === "tool";
}
function isNonStepEvent(event) {
	return !isStepEvent(event);
}
function finalizeStep(builder, turnID, index, trigger) {
	const event = builder.event;
	const tokens = event.tokens;
	const tools = builder.tools.map((toolEvent) => toolEvent.tool).filter((tool) => tool !== null);
	const start = event.timestamp;
	const end = event.endTimestamp;
	const toolCount = tools.length;
	const startUnknown = builder.startUnknown;
	const payload = event.payload;
	const rawTime = payload && typeof payload === "object" && payload.time ? payload.time : {};
	const streamed = typeof rawTime.streamed === "number" ? rawTime.streamed : null;
	const completed = typeof rawTime.completed === "number" ? rawTime.completed : null;
	const exactModelTime = modelTimeMetric({
		created: start,
		streamed,
		completed
	}, toolCount, startUnknown);
	const toolMetrics = tools.map((tool) => tool.duration);
	const toolTime = toolMetrics.length === 0 ? metric(0, "measured", "no tool calls in this step") : sumMetrics(toolMetrics, toolMetrics.length > 1 ? "sum of tool durations; parallel tool calls can exceed wall-clock" : void 0);
	const totalTime = durationMetric(start, end, {
		startUnknown,
		incomplete: builder.status === "incomplete" || builder.status === "running" || completed !== null && end !== null && end < completed,
		note: completed === null && end !== null ? "provider stream ended; step completion was not recorded" : void 0
	});
	const residual = differenceMetric$1(totalTime, exactModelTime, toolTime);
	const prompt = promptTokensMetric(tokens);
	const cache = cacheHitRateMetric(tokens);
	const speed = outputSpeedMetric(tokens?.output ?? null, exactModelTime);
	const subagents = [...new Set(tools.flatMap((tool) => tool.childSessionIDs))];
	const uncertainty = /* @__PURE__ */ new Set();
	for (const item of builder.events) for (const note of item.uncertainty) uncertainty.add(note);
	if (startUnknown) uncertainty.add("start-unknown");
	if (!tokens) uncertainty.add("tokens-missing");
	if (tokens && toolMetrics.some((value) => value.value === null)) uncertainty.add("tool-duration-partial");
	if (builder.status === "incomplete") uncertainty.add("step-incomplete");
	const responseText = event.meta && typeof event.meta === "object" ? String(event.meta.responseText ?? "") : "";
	const reasoningText = event.meta && typeof event.meta === "object" ? String(event.meta.reasoningText ?? "") : "";
	return {
		id: event.messageID,
		turnID,
		index,
		trigger,
		startTime: start,
		endTime: end,
		startUnknown,
		agent: event.agent,
		model: event.model,
		provider: event.provider,
		finish: event.meta && typeof event.meta === "object" ? event.meta.finish ?? null : null,
		toolNames: [...new Set(tools.map((tool) => tool.name))],
		toolCalls: tools,
		tokens,
		cost: event.cost,
		promptTokens: prompt,
		cacheHitRate: cache,
		ttft: metric(null, "unavailable", "OpenCode 2 does not persist a first-token timestamp"),
		modelTime: exactModelTime,
		toolTime,
		totalTime,
		residualTime: residual,
		outputSpeed: speed,
		status: builder.status,
		subagentSessionIDs: subagents,
		eventIDs: builder.events.map((item) => item.id),
		responseText,
		reasoningText,
		uncertainty: [...uncertainty]
	};
}
function sumCosts(values) {
	if (values.length === 0) return metric(null, "unavailable", "no model calls");
	const present = values.filter((value) => value !== null);
	if (present.length === 0) return metric(null, "unavailable", "cost was not recorded");
	return metric(present.reduce((sum, value) => sum + value, 0), "derived", present.length === values.length ? "sum of recorded costs" : `${values.length - present.length} cost value(s) missing`);
}
function turnMetrics(builder, steps) {
	const tokenTotals = sumTokens(steps.map((step) => step.tokens));
	const promptValues = steps.map((step) => step.promptTokens);
	const latest = [...steps].reverse().find((step) => step.promptTokens.value !== null);
	const cumulative = sumMetrics(promptValues, "sum of step prompt sizes");
	const cache = weightedCacheHitRate(steps.map((step) => step.tokens));
	const modelTime = sumMetrics(steps.map((step) => step.modelTime));
	const toolTime = sumMetrics(steps.map((step) => step.toolTime));
	const firstStart = steps[0]?.startTime ?? builder.startTime;
	const lastStepEnd = steps.length > 0 ? steps[steps.length - 1]?.endTime ?? null : builder.endTime;
	const lastCompleted = [...steps].reverse().find((step) => step.status === "completed");
	const lastCompletedEnd = lastCompleted?.endTime ?? null;
	const lastEventTime = builder.events[builder.events.length - 1]?.timestamp ?? builder.endTime;
	const totalTime = steps.length > 0 ? durationMetric(firstStart, lastCompletedEnd, {
		startUnknown: steps.some((step) => step.startUnknown),
		note: lastCompleted ? void 0 : "no completed step in this turn"
	}) : durationMetric(builder.startTime, lastEventTime, { note: "turn has no assistant step" });
	const residual = differenceMetric$1(totalTime, modelTime, toolTime);
	const speed = outputSpeedMetric(steps.reduce((sum, step) => sum + (step.tokens?.output ?? 0), 0), modelTime);
	return {
		firstStepStart: steps[0]?.startTime ?? null,
		lastStepEnd,
		tokens: tokenTotals.tokens,
		tokensComplete: steps.length > 0 && tokenTotals.complete,
		promptTokensLatest: latest?.promptTokens ?? metric(null, "unavailable", "no step tokens"),
		promptTokensCumulative: cumulative,
		cacheHitRate: cache,
		contextDelta: metric(null, "unavailable", "computed after all turns"),
		cost: sumCosts(steps.map((step) => step.cost)),
		modelTime,
		toolTime,
		totalTime,
		residualTime: residual,
		outputSpeed: speed
	};
}
function buildCompactions(events, steps) {
	const transactions = [];
	for (const event of events) {
		if (event.kind !== "compaction") continue;
		const stepIndex = steps.findIndex((step) => step.startTime > event.timestamp);
		const previous = stepIndex === -1 ? steps[steps.length - 1] : stepIndex === 0 ? void 0 : steps[stepIndex - 1];
		const next = stepIndex === -1 ? void 0 : steps[stepIndex];
		const beforeFromRequest = event.tokens ? promptTokensMetric(event.tokens) : metric(null, "unavailable", "compaction request tokens missing");
		const before = beforeFromRequest.value !== null ? beforeFromRequest : previous?.promptTokens ?? metric(null, "unavailable", "previous step tokens missing");
		const after = next?.promptTokens ?? metric(null, "unavailable", "next step tokens missing");
		const delta = before.value !== null && after.value !== null ? metric(after.value - before.value, "derived", "after - before") : metric(null, "unavailable", "context before or after is unavailable");
		const removed = before.value !== null && after.value !== null ? metric(before.value - after.value, "derived", before.value - after.value >= 0 ? "before - after; positive means context shrank" : "before - after; negative means context grew") : metric(null, "unavailable", "context before or after is unavailable");
		const summary = event.text ?? "";
		const uncertainty = new Set(event.uncertainty);
		uncertainty.add("summary-tokens-are-compaction-request-usage");
		if (before.value === null) uncertainty.add("context-before-unavailable");
		if (after.value === null) uncertainty.add("context-after-unavailable");
		transactions.push({
			eventID: event.id,
			turnID: event.turnID,
			timestamp: event.timestamp,
			status: event.status ?? "unknown",
			reason: event.meta && typeof event.meta === "object" ? event.meta.reason ?? null : null,
			model: event.model,
			provider: event.provider,
			tokens: event.tokens,
			cost: event.cost,
			summaryChars: summary.length,
			summaryPreview: preview(summary, 240),
			contextBefore: before,
			contextAfter: after,
			contextDelta: delta,
			removedTokens: removed,
			duration: metric(null, "unavailable", "only the compaction completion timestamp is persisted"),
			uncertainty: [...uncertainty]
		});
	}
	return transactions;
}
function computedCapabilities(events, session, sourceKind) {
	const tokens = events.map((event) => event.tokens).filter(Boolean);
	const costs = events.map((event) => event.cost).filter((value) => value !== null);
	return {
		source: sourceKind,
		ttft: false,
		approvals: false,
		requestHeaders: false,
		toolSetChanges: false,
		tokenUsage: tokens.length > 0,
		reasoning: events.some((event) => event.kind === "reasoning"),
		cacheUsage: tokens.some((value) => value.cacheRead > 0 || value.cacheWrite > 0),
		cost: costs.length > 0,
		retries: events.some((event) => event.kind === "retry"),
		compactions: events.some((event) => event.kind === "compaction"),
		subagents: events.some((event) => event.flags.subagent) || session.parentID !== void 0 || events.some((event) => event.kind === "tool" && event.tool?.childSessionIDs.length),
		contextNotices: events.some((event) => event.kind === "system"),
		modelSwitches: events.some((event) => event.kind === "model-switched"),
		routeChanges: events.some((event) => event.kind === "location-switched"),
		forkResumeMarkers: session.fork !== void 0 || session.revert !== void 0 || (session.resumeAttempts ?? 0) > 0 || session.suspendedAt !== void 0,
		toolDurations: events.some((event) => event.kind === "tool" && event.tool?.duration.value !== null),
		promptTokenBreakdown: "prompt = input + cache.read + cache.write",
		notes: [
			"TTFT, permission decisions, request headers and tool-set changes are not persisted in OpenCode 2.2.x session data.",
			"Tool timing is the sum of recorded tool durations; parallel calls may exceed wall-clock.",
			"OpenCode reports session-level totals that can include auxiliary model calls (title, generation, compaction).",
			...sourceKind === "api" ? ["Sequence numbers are synthesized from the API message order; the order itself is authoritative."] : []
		]
	};
}
function computedTotals(turns, steps, events, compactions, session, coverage) {
	const stepTotals = sumTokens(steps.map((step) => step.tokens));
	const compactionTotals = sumTokens(compactions.map((item) => item.tokens));
	const allUsages = [...steps.map((step) => step.tokens), ...compactions.map((item) => item.tokens)];
	const allTokens = sumTokens(allUsages);
	const modelTime = sumMetrics(steps.map((step) => step.modelTime));
	const toolTime = sumMetrics(steps.map((step) => step.toolTime));
	const activeTurnTime = sumMetrics(turns.map((turn) => turn.totalTime));
	const wallClock = events.length === 0 ? metric(null, "unavailable", "no events") : durationMetric(events[0].timestamp, events[events.length - 1].timestamp, { note: coverage.complete ? "first to last recorded event" : "first to last event in the loaded window" });
	const speed = outputSpeedMetric(steps.reduce((sum, step) => sum + (step.tokens?.output ?? 0), 0), modelTime);
	const tools = events.filter((event) => event.kind === "tool");
	const toolErrors = tools.filter((event) => event.tool?.status === "error" || event.tool?.error !== null).length;
	const stepErrors = steps.filter((step) => step.status === "error").length;
	const sessionErrors = events.filter((event) => event.kind === "idle" && (event.status === "failed" || event.status === "interrupted")).length;
	const errors = {
		total: toolErrors + stepErrors + sessionErrors,
		tool: toolErrors,
		step: stepErrors,
		session: sessionErrors
	};
	const costs = [...turns.map((turn) => turn.cost.value), ...compactions.map((item) => item.cost)];
	const presentCosts = costs.filter((value) => value !== null);
	const cost = costs.length === 0 ? metric(null, "unavailable", "no model calls") : presentCosts.length === 0 ? metric(null, "unavailable", "cost was not recorded") : metric(presentCosts.reduce((sum, value) => sum + value, 0), "derived", presentCosts.length === costs.length ? "steps + compactions" : `${costs.length - presentCosts.length} cost value(s) missing`);
	const finalContext = [...steps].reverse().find((step) => step.promptTokens.value !== null)?.promptTokens ?? metric(null, "unavailable", "no step token usage");
	const cumulativePrompt = sumMetrics(steps.map((step) => step.promptTokens), "sum of step prompt sizes");
	const recordedTokens = session.tokens;
	const recorded = recordedTokens || session.cost !== void 0 ? {
		...recordedTokens ? { tokens: recordedTokens } : {},
		...session.cost !== void 0 ? { cost: session.cost } : {},
		note: "Reported by the OpenCode session row; can include auxiliary model calls."
	} : void 0;
	return {
		scope: coverage.complete ? "session" : "window",
		turns: turns.length,
		steps: steps.length,
		toolCalls: tools.length,
		subagentCalls: tools.filter((event) => event.flags.subagent).length,
		errors,
		retries: events.filter((event) => event.kind === "retry").length,
		compactions: compactions.length,
		tokens: allTokens.tokens,
		tokensComplete: allUsages.length > 0 && allTokens.complete,
		stepTokens: stepTotals.tokens,
		compactionTokens: compactionTotals.tokens,
		cacheHitRate: weightedCacheHitRate(allUsages),
		cost,
		modelTime,
		toolTime,
		activeTurnTime,
		wallClockTime: wallClock,
		outputSpeed: speed,
		finalContext,
		cumulativePrompt,
		recorded
	};
}
function toEventIndex(event) {
	return {
		id: event.id,
		messageID: event.messageID,
		sessionID: event.sessionID,
		seq: event.seq,
		orderKey: event.orderKey,
		timestamp: event.timestamp,
		kind: event.kind,
		actor: event.actor,
		title: event.title,
		preview: event.textPreview ?? "",
		agent: event.agent,
		model: event.model,
		provider: event.provider,
		status: event.status,
		toolName: event.tool?.name ?? null,
		toolStatus: event.tool?.status ?? null,
		tokens: event.tokens,
		cost: event.cost,
		stepID: event.stepID,
		turnID: event.turnID,
		flags: event.flags,
		uncertainty: event.uncertainty
	};
}
/**
* Folds the normalized event stream into turns, steps, compaction
* transactions, totals and capabilities.
*
* Grouping is deliberately conservative:
* - recorded `seq` order is never changed;
* - a user message opens a turn;
* - an assistant message is one step;
* - an idle message closes the open turn;
* - system/switch/compaction events attach to the open turn, otherwise they
*   stay unattached and are listed separately.
*/
function projectSession(events, options) {
	const { session, family, coverage, sourceKind } = options;
	const sessionActive = session.time.busy !== void 0 && (session.time.idle === void 0 || session.time.busy > session.time.idle);
	const turns = [];
	const unattached = [];
	const eventsWithTurn = [];
	let current = null;
	const attach = (event, turn) => {
		const assigned = {
			...event,
			turnID: turn.id
		};
		turn.events.push(assigned);
		return assigned;
	};
	const startTurn = (event, trigger) => {
		const builder = {
			index: turns.length,
			id: `${session.id}:t${turns.length + 1}`,
			trigger,
			startTime: event.timestamp,
			endTime: null,
			idleTimestamp: null,
			idleOutcome: null,
			events: [],
			steps: [],
			currentStep: null
		};
		turns.push(builder);
		return builder;
	};
	for (const rawEvent of events) {
		let event = rawEvent;
		if (event.kind === "session") {
			unattached.push(event);
			eventsWithTurn.push(event);
			continue;
		}
		if (event.kind === "user") {
			if (current) {
				const previous = current;
				previous.endTime = previous.endTime ?? previous.events[previous.events.length - 1]?.timestamp ?? null;
				current = null;
			}
			const trigger = {
				kind: session.parentID ? "delegation" : "user",
				eventID: event.id,
				label: session.parentID ? "Delegated prompt" : "User message"
			};
			const turn = startTurn(event, trigger);
			current = turn;
			event = attach(event, turn);
			eventsWithTurn.push(event);
			continue;
		}
		if (event.kind === "synthetic") {
			if (!current) {
				const turn = startTurn(event, {
					kind: "synthetic",
					eventID: event.id,
					label: "Synthetic/automatic message"
				});
				current = turn;
				event = attach(event, turn);
			} else event = attach(event, current);
			eventsWithTurn.push(event);
			continue;
		}
		if (event.kind === "assistant") {
			if (!current) {
				const trigger = event.flags.retry ? {
					kind: "retry",
					eventID: event.id,
					label: "Retry"
				} : sessionActive && (session.resumeAttempts ?? 0) > 0 ? {
					kind: "resume",
					eventID: event.id,
					label: "Resumed execution"
				} : {
					kind: "orphan",
					eventID: event.id,
					label: "Assistant without user message"
				};
				const turn = startTurn(event, trigger);
				current = turn;
				turn.events.push({
					...event,
					turnID: turn.id
				});
				turn.currentStep = {
					event: {
						...event,
						turnID: turn.id
					},
					events: [{
						...event,
						turnID: turn.id
					}],
					tools: [],
					status: stepStatus(event),
					startUnknown: event.timestamp <= 0
				};
				turn.steps.push(turn.currentStep);
				event = {
					...event,
					turnID: turn.id
				};
			} else {
				event = attach(event, current);
				current.currentStep = {
					event,
					events: [event],
					tools: [],
					status: stepStatus(event),
					startUnknown: event.timestamp <= 0
				};
				current.steps.push(current.currentStep);
			}
			eventsWithTurn.push(event);
			continue;
		}
		if (event.kind === "reasoning" || event.kind === "text" || event.kind === "tool") {
			if (!current) {
				unattached.push(event);
				eventsWithTurn.push(event);
				continue;
			}
			const step = current.currentStep;
			if (!step || event.stepID !== step.event.messageID) event = {
				...event,
				uncertainty: [...event.uncertainty, "orphan-step-block"]
			};
			event = attach(event, current);
			if (step && event.stepID === step.event.messageID) {
				step.events.push(event);
				if (event.kind === "tool") step.tools.push(event);
			}
			eventsWithTurn.push(event);
			continue;
		}
		if (event.kind === "idle") {
			if (!current) {
				unattached.push(event);
				eventsWithTurn.push(event);
				continue;
			}
			event = attach(event, current);
			current.idleTimestamp = event.timestamp;
			current.idleOutcome = event.status;
			current.endTime = event.timestamp;
			eventsWithTurn.push(event);
			current = null;
			continue;
		}
		if (event.kind === "retry" || event.kind === "error") {
			if (!current) {
				unattached.push(event);
				eventsWithTurn.push(event);
				continue;
			}
			event = attach(event, current);
			const step = current.currentStep;
			if (step && event.stepID === step.event.messageID) step.events.push(event);
			eventsWithTurn.push(event);
			continue;
		}
		if (current) event = attach(event, current);
		else unattached.push(event);
		eventsWithTurn.push(event);
	}
	const finalizedTurns = [];
	const allSteps = [];
	for (const builder of turns) {
		const steps = builder.steps.map((step, index) => {
			const previous = index > 0 ? builder.steps[index - 1] : null;
			const trigger = index === 0 ? builder.trigger.label : previous && previous.tools.length > 0 ? "After tool results" : "Assistant continuation";
			return finalizeStep(step, builder.id, index + 1, trigger);
		});
		allSteps.push(...steps);
		const base = turnMetrics(builder, steps);
		const eventIDs = builder.events.map((event) => event.id);
		const nonStepEventIDs = builder.events.filter((event) => isNonStepEvent(event)).map((event) => event.id);
		const uncertainty = /* @__PURE__ */ new Set();
		if (builder.trigger.kind === "orphan") uncertainty.add("assistant-without-user");
		for (const step of steps) for (const note of step.uncertainty) uncertainty.add(note);
		if (builder.idleOutcome === null && steps.length > 0) uncertainty.add("no-idle-recorded");
		finalizedTurns.push({
			id: builder.id,
			index: builder.index + 1,
			trigger: builder.trigger,
			startTime: builder.startTime,
			endTime: builder.idleTimestamp ?? base.lastStepEnd ?? builder.events[builder.events.length - 1]?.timestamp ?? null,
			status: turnStatus(builder, sessionActive),
			steps,
			eventIDs,
			nonStepEventIDs,
			...base,
			uncertainty: [...uncertainty]
		});
	}
	for (let index = 1; index < finalizedTurns.length; index++) {
		const turn = finalizedTurns[index];
		const previous = finalizedTurns[index - 1];
		turn.contextDelta = contextDeltaMetric(turn.promptTokensLatest, previous.promptTokensLatest);
	}
	const compactions = buildCompactions(eventsWithTurn, allSteps);
	const totals = computedTotals(finalizedTurns, allSteps, eventsWithTurn, compactions, session, coverage);
	return {
		version: 1,
		session,
		family,
		capabilities: computedCapabilities(eventsWithTurn, session, sourceKind),
		coverage,
		events: eventsWithTurn.map(toEventIndex),
		turns: finalizedTurns,
		compactions,
		totals,
		unattachedEventIDs: unattached.map((event) => event.id),
		generatedAt: options.generatedAt ?? Date.now(),
		redacted: false
	};
}
// src/core/diagnostics.ts
var SIMILARITY_THRESHOLD = .5;
var REDACTION_SENTINEL = /\[REDACTED(?::[^\]]*)?\]/;
var TRUNCATION_MARKER = /(?:…|\[truncated\b[^\]]*\]|<truncated\s*\/?>|\[snip\])\s*$/i;
function isFailure(event) {
	const tool = event.tool;
	return event.kind === "tool" && tool !== null && (tool.status === "error" || tool.error !== null);
}
function isSuccess(event) {
	const tool = event.tool;
	return event.kind === "tool" && tool !== null && tool.error === null && tool.status === "completed";
}
function walkStrings(value, visit, seen = /* @__PURE__ */ new Set()) {
	if (typeof value === "string") {
		visit(value);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	if (seen.has(value)) return;
	seen.add(value);
	try {
		if (Array.isArray(value)) for (const item of value) walkStrings(item, visit, seen);
		else for (const item of Object.values(value)) walkStrings(item, visit, seen);
	} finally {
		seen.delete(value);
	}
}
/**
* Classifies whether a recorded input can participate in a comparison.
* Absence, truncation and redaction are terminal: the engine never guesses.
*/
function classifyInput(input) {
	if (input === void 0 || input === null || input === "") return "absent";
	let redacted = false;
	let truncated = false;
	walkStrings(input, (text) => {
		if (redacted) return;
		if (REDACTION_SENTINEL.test(text)) {
			redacted = true;
			return;
		}
		if (TRUNCATION_MARKER.test(text)) truncated = true;
	});
	if (redacted) return "redacted";
	if (truncated) return "truncated";
	return "comparable";
}
function isObjectLike(value) {
	return typeof value === "object" && value !== null;
}
function sortDeep(value, seen = /* @__PURE__ */ new Set()) {
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new TypeError("cyclic input");
		seen.add(value);
		try {
			return value.map((item) => sortDeep(item, seen));
		} finally {
			seen.delete(value);
		}
	}
	if (typeof value === "object" && value !== null) {
		if (seen.has(value)) throw new TypeError("cyclic input");
		seen.add(value);
		try {
			const source = value;
			const out = {};
			for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key], seen);
			return out;
		} finally {
			seen.delete(value);
		}
	}
	return value;
}
function canonicalJson(value) {
	try {
		const normalized = sortDeep(value);
		const text = JSON.stringify(normalized);
		return text === void 0 ? `undefined:${String(normalized)}` : text;
	} catch {
		return `unserializable:${String(value)}`;
	}
}
function collectKeyPaths(value, prefix, out, seen) {
	if (typeof value !== "object" || value === null) return;
	if (seen.has(value)) return;
	seen.add(value);
	try {
		if (Array.isArray(value)) for (const item of value) collectKeyPaths(item, prefix, out, seen);
		else for (const [key, item] of Object.entries(value)) {
			const path = prefix.length > 0 ? `${prefix}.${key}` : key;
			out.add(path);
			collectKeyPaths(item, path, out, seen);
		}
	} finally {
		seen.delete(value);
	}
}
/** Sorted key paths, names only — never values. */
function keyShape(value) {
	const keys = /* @__PURE__ */ new Set();
	collectKeyPaths(value, "", keys, /* @__PURE__ */ new Set());
	return [...keys].sort();
}
function compareInputs(left, right) {
	if (canonicalJson(left) === canonicalJson(right)) return {
		verdict: "identical",
		overlap: 1
	};
	const leftKeys = new Set(keyShape(left));
	const rightKeys = new Set(keyShape(right));
	const union = /* @__PURE__ */ new Set([...leftKeys, ...rightKeys]);
	if (union.size === 0) return {
		verdict: "different",
		overlap: 0
	};
	let intersection = 0;
	for (const key of leftKeys) if (rightKeys.has(key)) intersection += 1;
	const overlap = intersection / union.size;
	return {
		verdict: overlap >= SIMILARITY_THRESHOLD ? "related" : "different",
		overlap
	};
}
function formatRatio$1(value) {
	return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}
function comparabilityReason(state, source) {
	const subject = source === "failure" ? "failure input" : "the matching success input";
	switch (state) {
		case "absent": return `${subject} is absent`;
		case "truncated": return `${subject} contains a truncation marker`;
		case "redacted": return `${subject} contains a redaction sentinel`;
		default: return `${subject} is comparable`;
	}
}
/**
* Looks for post-run signals inside the same turn only.
* Stops at the first event that belongs to a different turn.
*/
function scanAfter(startIndex, turnID, events, turnByEventId) {
	const result = {
		success: false,
		successTool: null,
		assistantStep: false
	};
	for (let index = startIndex + 1; index < events.length; index += 1) {
		const event = events[index];
		const turn = turnByEventId.get(event.id);
		if (!turn || turn.id !== turnID) break;
		if (event.kind === "assistant") result.assistantStep = true;
		if (event.kind === "tool" && event.tool && isSuccess(event)) {
			result.success = true;
			if (result.successTool === null) result.successTool = event.tool.name;
		}
	}
	return result;
}
/** Sum of recorded step costs; unavailable when no step recorded one. */
function sumStepCosts(steps) {
	if (steps.length === 0) return metric(null, "unavailable", "no model calls");
	const present = steps.map((step) => step.cost).filter((value) => value !== null);
	if (present.length === 0) return metric(null, "unavailable", "cost was not recorded");
	return metric(present.reduce((sum, value) => sum + value, 0), "derived", present.length === steps.length ? "sum of recorded costs" : `${steps.length - present.length} cost value(s) missing`);
}
function buildIncident(run, success, events, turnByEventId) {
	const failureTools = [];
	for (const event of run.failures) if (event.tool) failureTools.push(event.tool);
	const failureStates = failureTools.map((tool) => classifyInput(tool.input));
	const successTool = success ? success.tool : null;
	const successState = successTool ? classifyInput(successTool.input) : null;
	let badFailure = null;
	for (const state of failureStates) if (state !== "comparable") {
		badFailure = state;
		break;
	}
	const badState = badFailure ?? (successState !== null && successState !== "comparable" ? successState : null);
	const inputsComparable = badState === null;
	let similarity = "unknown";
	let overlap = null;
	let inputsCompared = false;
	if (inputsComparable && successTool) {
		const comparisons = failureTools.map((tool) => compareInputs(tool.input, successTool.input));
		inputsCompared = true;
		const allIdentical = comparisons.every((item) => item.verdict === "identical");
		const anyDifferent = comparisons.some((item) => item.verdict === "different");
		similarity = allIdentical ? "identical" : anyDifferent ? "different" : "related";
		overlap = Math.min(...comparisons.map((item) => item.overlap));
	}
	const after = scanAfter(run.lastIndex, run.turn.id, events, turnByEventId);
	const prefix = `${run.failures.length} failure(s) on ${run.tool} in turn ${run.turn.index}`;
	let recovery;
	let why;
	if (badState !== null) {
		recovery = "insufficient-data";
		why = `${prefix}; ${comparabilityReason(badState, badFailure !== null ? "failure" : "success")}; input comparison is undetermined`;
	} else if (successTool && (similarity === "identical" || similarity === "related")) {
		recovery = "recovered";
		why = similarity === "identical" ? `${prefix}; a later ${run.tool} call succeeded with identical input (canonical JSON equality)` : `${prefix}; a later ${run.tool} call succeeded with related input (key-shape overlap ${formatRatio$1(overlap ?? 0)} >= 0.50)`;
	} else if (after.success || after.assistantStep) {
		recovery = "possible-recovery";
		why = successTool !== null && similarity === "different" ? `${prefix}; a later ${run.tool} call succeeded but with a different input shape (key-shape overlap ${formatRatio$1(overlap ?? 0)} < 0.50)` : after.success ? `${prefix}; no matching ${run.tool} success, but a later successful tool call${after.successTool ? ` (${after.successTool})` : ""} followed` : `${prefix}; no matching ${run.tool} success, but the turn continued with a subsequent assistant step`;
	} else {
		recovery = "no-recovery-evidence";
		why = `${prefix}; no same-tool success and no later successful call or subsequent step before the turn ended`;
	}
	const firstFailureInput = failureTools[0]?.input;
	const inputKeyShape = inputsComparable && isObjectLike(firstFailureInput) ? keyShape(firstFailureInput) : null;
	return {
		incident: {
			tool: run.tool,
			turn: run.turn.index,
			turnID: run.turn.id,
			attempts: run.failures.length,
			recoveryEventID: recovery === "recovered" && success ? success.id : null,
			recovery,
			basis: recovery === "insufficient-data" ? "measured" : "derived",
			failureBasis: "measured",
			why,
			inputsCompared,
			inputsComparable,
			similarity,
			inputKeyShape,
			firstFailureEventID: run.failures[0].id,
			lastFailureEventID: run.failures[run.failures.length - 1].id,
			failureEventIDs: run.failures.map((event) => event.id),
			successEventID: success ? success.id : null,
			trigger: {
				kind: run.turn.trigger.kind,
				eventID: run.turn.trigger.eventID,
				label: run.turn.trigger.label
			},
			elapsed: { ...run.turn.totalTime },
			stepCostSum: sumStepCosts(run.turn.steps)
		},
		turnIndex: run.turn.index,
		firstIndex: run.firstIndex
	};
}
function collectIncidents(events, analysis) {
	const turnByEventId = /* @__PURE__ */ new Map();
	for (const turn of analysis.turns) for (const id of turn.eventIDs) turnByEventId.set(id, turn);
	const open = /* @__PURE__ */ new Map();
	const ordered = [];
	let currentTurnId = null;
	let excludedTurnlessToolEvents = 0;
	const finalizeTurn = (turnID) => {
		for (const [key, run] of [...open.entries()]) {
			if (run.turn.id !== turnID) continue;
			open.delete(key);
			ordered.push(buildIncident(run, null, events, turnByEventId));
		}
	};
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		const turn = turnByEventId.get(event.id) ?? null;
		const turnId = turn ? turn.id : null;
		if (turnId !== currentTurnId) {
			if (currentTurnId !== null) finalizeTurn(currentTurnId);
			currentTurnId = turnId;
		}
		if (!turn) {
			if (event.kind === "tool" && event.tool !== null) excludedTurnlessToolEvents += 1;
			continue;
		}
		if (event.kind !== "tool") continue;
		const tool = event.tool;
		if (!tool) continue;
		const key = `${turn.id}\u0000${tool.name}`;
		if (isFailure(event)) {
			const run = open.get(key);
			if (run) {
				run.failures.push(event);
				run.lastIndex = index;
			} else open.set(key, {
				tool: tool.name,
				turn,
				failures: [event],
				firstIndex: index,
				lastIndex: index
			});
		} else if (isSuccess(event)) {
			const run = open.get(key);
			if (run) {
				open.delete(key);
				ordered.push(buildIncident(run, event, events, turnByEventId));
			}
		}
	}
	if (currentTurnId !== null) finalizeTurn(currentTurnId);
	for (const [key, run] of [...open.entries()]) {
		open.delete(key);
		ordered.push(buildIncident(run, null, events, turnByEventId));
	}
	ordered.sort((left, right) => left.turnIndex - right.turnIndex || left.firstIndex - right.firstIndex);
	return {
		ordered,
		excludedTurnlessToolEvents
	};
}
function summarize(incidents, excludedTurnlessToolEvents) {
	let recovered = 0;
	let possibleRecovery = 0;
	let noRecoveryEvidence = 0;
	let insufficientData = 0;
	const turns = /* @__PURE__ */ new Set();
	for (const incident of incidents) {
		turns.add(incident.turn);
		switch (incident.recovery) {
			case "recovered":
				recovered += 1;
				break;
			case "possible-recovery":
				possibleRecovery += 1;
				break;
			case "no-recovery-evidence":
				noRecoveryEvidence += 1;
				break;
			case "insufficient-data": insufficientData += 1;
		}
	}
	return {
		incidents: incidents.length,
		recovered,
		possibleRecovery,
		noRecoveryEvidence,
		insufficientData,
		turnsWithIncidents: turns.size,
		excludedTurnlessToolEvents
	};
}
/**
* The repeated-tool-failure rule.
*
* "Consecutive" means consecutive events of that tool within the turn:
* intervening calls on other tools do not break the run, and each tool's run
* is tracked independently. One incident is produced per maximal run; a run
* terminates on that tool's success or at the turn boundary.
*/
function RepeatedToolFailureRule(events, analysis) {
	const collected = collectIncidents(events, analysis);
	return {
		incidents: collected.ordered.map((item) => item.incident),
		excludedTurnlessToolEvents: collected.excludedTurnlessToolEvents
	};
}
/**
* Primary entry point. Pure, deterministic and local.
* Returns an empty incident list (never null/undefined) when nothing failed.
* Events must be the full recorded-order event list of `analysis.session`;
* windowed or page-subset calls yield a non-zero `excludedTurnlessToolEvents`
* rather than silently miscounting.
*/
function evaluateDiagnostics(events, analysis) {
	const { incidents, excludedTurnlessToolEvents } = RepeatedToolFailureRule(events, analysis);
	return {
		incidents,
		summary: summarize(incidents, excludedTurnlessToolEvents)
	};
}
/**
* The user-approved thresholds of 2026-11-17. Frozen so tests, the UI and the
* documentation all assert against the same source.
*/
var HEALTH_RULES = Object.freeze({
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
function formatRatio(value) {
	return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}
function levelFor(watch, strong) {
	if (strong) return "strong";
	if (watch) return "watch";
	return null;
}
function rule(thresholds, id, label, level, evaluable, note, eventIDs = [], turnIDs = []) {
	return {
		id,
		label,
		triggered: level !== null,
		level,
		evaluable,
		note,
		eventIDs: capIDs$3(eventIDs, thresholds.maxEventLinks),
		turnIDs: capIDs$3(turnIDs, thresholds.maxTurnLinks)
	};
}
/** Deduplicates, drops empty ids and caps the list in recorded order. */
function capIDs$3(ids, limit) {
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
/** `totals.errors.total / totals.steps`; steps are the work denominator. */
function errorRateRule(analysis, thresholds) {
	const { errors, steps } = analysis.totals;
	const threshold = thresholds.errorRate;
	if (steps === 0) return rule(thresholds, "error-rate", "Error rate", null, false, "no steps were recorded");
	const rate = errors.total / steps;
	const level = levelFor(rate >= threshold.watchRate && errors.total >= threshold.watchErrors, rate >= threshold.strongRate && errors.total >= threshold.strongErrors);
	const eventIDs = analysis.events.filter((event) => event.flags.error).map((event) => event.id);
	return rule(thresholds, "error-rate", "Error rate", level, true, `${errors.total} error(s) across ${steps} step(s); rate ${formatRatio(rate)}`, eventIDs);
}
function retryCountRule(analysis, thresholds) {
	const threshold = thresholds.retryCount;
	const retries = analysis.totals.retries;
	const level = levelFor(retries >= threshold.watch, retries >= threshold.strong);
	const eventIDs = analysis.events.filter((event) => event.kind === "retry").map((event) => event.id);
	return rule(thresholds, "retry-count", "Retry count", level, true, `${retries} retry event(s) recorded`, eventIDs);
}
/** Reads the diagnostics attached to the same analysis. */
function toolFailureRecurrenceRule(analysis, thresholds) {
	const threshold = thresholds.toolFailureRecurrence;
	const incidents = analysis.diagnostics?.incidents ?? [];
	let maxAttempts = 0;
	for (const incident of incidents) if (incident.attempts > maxAttempts) maxAttempts = incident.attempts;
	const level = levelFor(incidents.length >= threshold.watchIncidents || maxAttempts >= threshold.watchMaxAttempts, incidents.length >= threshold.strongIncidents || maxAttempts >= threshold.strongMaxAttempts);
	const eventIDs = incidents.map((incident) => incident.firstFailureEventID);
	return rule(thresholds, "tool-failure-recurrence", "Tool-failure recurrence", level, true, `${incidents.length} incident(s) recorded; max ${maxAttempts} attempt(s) in one run`, eventIDs);
}
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
function contextGrowthRule(analysis, thresholds) {
	const threshold = thresholds.contextGrowth;
	const available = analysis.turns.filter((turn) => turn.contextDelta.value !== null).length;
	if (available < 2) return rule(thresholds, "context-growth", "Context growth", null, false, `${available} turn(s) recorded a context delta; at least 2 are required`);
	const finalContext = analysis.totals.finalContext.value;
	if (finalContext === null) return rule(thresholds, "context-growth", "Context growth", null, false, "final context size was not recorded");
	const run = longestGrowthRun(analysis);
	const length = run?.length ?? 0;
	const level = levelFor(length >= threshold.watchRun && finalContext >= threshold.watchFinalContext, length >= threshold.strongRun && finalContext >= threshold.strongFinalContext);
	const turnIDs = run ? [run.first.id, run.last.id] : [];
	return rule(thresholds, "context-growth", "Context growth", level, true, `longest growth run ${length} turn(s); final context ${finalContext}`, [], turnIDs);
}
/** Highest-cost turns, descending, ties resolved by recorded order. */
function costliestTurns$1(turns, limit) {
	return [...turns].filter((turn) => turn.cost.value !== null).sort((left, right) => (right.cost.value ?? 0) - (left.cost.value ?? 0) || left.index - right.index).slice(0, limit).map((turn) => turn.id);
}
function costPerTurnRule(analysis, thresholds) {
	const threshold = thresholds.costPerTurn;
	const cost = analysis.totals.cost;
	const turns = analysis.totals.turns;
	if (cost.value === null) return rule(thresholds, "cost-per-turn", "Cost per turn", null, false, "cost was not recorded");
	if (turns < 2) return rule(thresholds, "cost-per-turn", "Cost per turn", null, false, `${turns} turn(s) recorded; at least 2 are required`);
	const perTurn = cost.value / turns;
	return rule(thresholds, "cost-per-turn", "Cost per turn", levelFor(perTurn >= threshold.watch, perTurn >= threshold.strong), true, `$${perTurn.toFixed(2)} per turn across ${turns} turn(s)`, [], costliestTurns$1(analysis.turns, 3));
}
function lowCacheHitRule(analysis, thresholds) {
	const threshold = thresholds.lowCacheHit;
	const available = analysis.turns.filter((turn) => turn.cacheHitRate.value !== null);
	if (available.length === 0) return rule(thresholds, "low-cache-hit", "Low cache hit rate", null, false, "no turn recorded a cache hit rate");
	const low = available.filter((turn) => (turn.cacheHitRate.value ?? 0) < threshold.lowBelow);
	const share = low.length / available.length;
	return rule(thresholds, "low-cache-hit", "Low cache hit rate", levelFor(low.length >= threshold.watchLowTurns && share >= threshold.watchShare, low.length >= threshold.strongLowTurns && share >= threshold.strongShare), true, `${low.length} of ${available.length} turn(s) below a ${threshold.lowBelow.toFixed(2)} cache hit rate`, [], low.map((turn) => turn.id));
}
/**
* `running` is explicitly not a trigger: an in-flight session is not
* unhealthy. Only a recorded interrupt, failure or incomplete tail counts.
*/
function unfinishedOutcomeRule(analysis, thresholds) {
	const last = analysis.turns[analysis.turns.length - 1] ?? null;
	const outcome = analysis.session.outcome ?? null;
	const lastStatus = last?.status ?? null;
	const level = levelFor(outcome === "interrupted" || lastStatus === "interrupted" || lastStatus === "incomplete", outcome === "failed" || lastStatus === "error");
	const anchor = last ? last.trigger.eventID ?? last.eventIDs[0] ?? null : null;
	const idleFailures = analysis.events.filter((event) => event.kind === "idle" && (event.status === "failed" || event.status === "interrupted")).map((event) => event.id);
	const eventIDs = anchor === null ? idleFailures : [anchor, ...idleFailures];
	return rule(thresholds, "unfinished-outcome", "Unfinished outcome", level, true, `session outcome: ${outcome ?? "not recorded"}; last turn status: ${lastStatus ?? "no turns"}`, eventIDs);
}
/** The sufficiency gate: none of these may claim a healthy session. */
function insufficiencyReasons(analysis) {
	const reasons = [];
	if (analysis.totals.turns === 0) reasons.push("no turns were recorded");
	if (!analysis.coverage.complete) reasons.push("the analysis covers a window, not the full session");
	if (!analysis.capabilities.tokenUsage && !analysis.capabilities.cost) reasons.push("neither token usage nor cost was recorded");
	return reasons;
}
/**
* Primary entry point. Pure, deterministic and local.
*
* State mapping (one documented rule): insufficiency forces `watch` (never
* `healthy`); otherwise any strong trigger or at least two watch triggers is
* `degraded`; exactly one watch trigger is `watch`; nothing is `healthy`.
* Recorded evidence may escalate an insufficient session to `degraded` — only
* the `healthy` claim is blocked.
*/
function evaluateSessionHealth(analysis, thresholds = HEALTH_RULES) {
	const rules = [
		errorRateRule(analysis, thresholds),
		retryCountRule(analysis, thresholds),
		toolFailureRecurrenceRule(analysis, thresholds),
		contextGrowthRule(analysis, thresholds),
		costPerTurnRule(analysis, thresholds),
		lowCacheHitRule(analysis, thresholds),
		unfinishedOutcomeRule(analysis, thresholds)
	];
	let watch = 0;
	let strong = 0;
	for (const item of rules) if (item.level === "strong") strong += 1;
	else if (item.level === "watch") watch += 1;
	const insufficientReasons = insufficiencyReasons(analysis);
	const insufficient = insufficientReasons.length > 0;
	return {
		state: strong > 0 || watch >= 2 ? "degraded" : insufficient || watch === 1 ? "watch" : "healthy",
		insufficient,
		insufficientReasons,
		rules,
		triggeredCount: watch + strong
	};
}
var PATTERN_KINDS = [
	"no-child-failure",
	"child-failed-no-parent-reaction",
	"parent-retried-same-agent",
	"parent-retried-identical-delegation-input",
	"parent-retried-with-changed-delegation-input",
	"parent-fallback-to-other-agent",
	"parent-reaction-unclear",
	"insufficient-data"
];
/**
* True when the event is a recorded delegation call. The three signals are
* ORed on purpose: the tool name, the normalized subagent flag, or a recorded
* child session id is each sufficient on its own.
*/
function isDelegationToolEvent(event) {
	if (!event || event.kind !== "tool") return false;
	const tool = event.tool;
	if (!tool) return false;
	const childIDs = Array.isArray(tool.childSessionIDs) ? tool.childSessionIDs : [];
	return tool.name === "subagent" || event.flags?.subagent === true || childIDs.length > 0;
}
function delegatedAgentOf(event) {
	const meta = event.meta;
	if (!meta || typeof meta !== "object") return null;
	const value = meta["delegatedAgent"];
	return typeof value === "string" && value.length > 0 ? value : null;
}
function childSessionIDsOf(event) {
	const tool = event.tool;
	if (!tool || !Array.isArray(tool.childSessionIDs)) return [];
	return tool.childSessionIDs.filter((id) => typeof id === "string");
}
function turnOfEvent(turns, eventID) {
	for (const turn of turns) if (Array.isArray(turn.eventIDs) && turn.eventIDs.includes(eventID)) return turn;
	return null;
}
function emptyPatternCounts() {
	const counts = {};
	for (const kind of PATTERN_KINDS) counts[kind] = 0;
	return counts;
}
function parentTurnsOf(analysis) {
	if (!analysis) return [];
	return Array.isArray(analysis.turns) ? analysis.turns : [];
}
function parentComplete(analysis) {
	return analysis?.coverage?.complete === true;
}
function childTurnsOf(child) {
	return Array.isArray(child.analysis?.turns) ? child.analysis.turns : [];
}
function childEventsOf(child) {
	return Array.isArray(child.analysis?.events) ? child.analysis.events : [];
}
function childTimeCreated(child) {
	const created = child.analysis?.session?.time?.created;
	if (typeof created === "number" && Number.isFinite(created)) return created;
	return earliestChildTimestamp(child);
}
function earliestChildTimestamp(child) {
	let earliest = Number.POSITIVE_INFINITY;
	const events = Array.isArray(child.events) ? child.events : [];
	for (const event of events) if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp) && event.timestamp < earliest) earliest = event.timestamp;
	const created = child.analysis?.session?.time?.created;
	if (typeof created === "number" && Number.isFinite(created) && created < earliest) earliest = created;
	return Number.isFinite(earliest) ? earliest : 0;
}
function deriveAnchor(child, parentEvents, parentTurns) {
	let anchorIndex = -1;
	for (let index = 0; index < parentEvents.length; index += 1) {
		const event = parentEvents[index];
		if (!isDelegationToolEvent(event)) continue;
		if (!childSessionIDsOf(event).includes(child.sessionID)) continue;
		anchorIndex = index;
		break;
	}
	if (anchorIndex >= 0) {
		const event = parentEvents[anchorIndex];
		const tool = event.tool;
		const turn = turnOfEvent(parentTurns, event.id);
		return {
			anchorIndex,
			anchorEvent: event,
			uncertainty: [],
			link: {
				childSessionID: child.sessionID,
				parentEventID: event.id,
				parentTurnID: turn ? turn.id : null,
				parentTurnIndex: turn ? turn.index : null,
				delegatedAgent: delegatedAgentOf(event),
				anchorTimestamp: event.timestamp,
				inputComparability: classifyInput(tool ? tool.input : null)
			}
		};
	}
	return {
		anchorIndex: -1,
		anchorEvent: null,
		uncertainty: [`no recorded delegation event links child ${child.sessionID}; its earliest timestamp was used as the anchor`],
		link: {
			childSessionID: child.sessionID,
			parentEventID: null,
			parentTurnID: null,
			parentTurnIndex: null,
			delegatedAgent: null,
			anchorTimestamp: earliestChildTimestamp(child),
			inputComparability: "absent"
		}
	};
}
function providedAnchor(link, parentEvents) {
	let anchorIndex = -1;
	if (typeof link.parentEventID === "string") anchorIndex = parentEvents.findIndex((event) => event.id === link.parentEventID);
	const anchorEvent = anchorIndex >= 0 ? parentEvents[anchorIndex] : null;
	const uncertainty = [];
	if (typeof link.parentEventID === "string" && anchorEvent === null) uncertainty.push(`recorded delegation event ${link.parentEventID} is absent from the parent stream`);
	return {
		anchorIndex,
		anchorEvent,
		uncertainty,
		link: {
			childSessionID: link.childSessionID,
			parentEventID: link.parentEventID,
			parentTurnID: link.parentTurnID,
			parentTurnIndex: link.parentTurnIndex,
			delegatedAgent: link.delegatedAgent,
			anchorTimestamp: Number.isFinite(link.anchorTimestamp) ? link.anchorTimestamp : 0,
			inputComparability: link.inputComparability
		}
	};
}
function buildReaction(anchor, parentEvents, complete, child) {
	const later = (anchor.anchorIndex >= 0 ? parentEvents.slice(anchor.anchorIndex + 1) : parentEvents.filter((event) => event.timestamp > anchor.link.anchorTimestamp)).filter((event) => isDelegationToolEvent(event));
	const eventIDs = later.map((event) => event.id);
	const agents = [];
	for (const event of later) {
		const agent = delegatedAgentOf(event);
		if (agent !== null) agents.push(agent);
	}
	const uncertainty = [...anchor.uncertainty];
	if (later.length > 1) uncertainty.push(`${later.length} later delegation events recorded; reaction reflects the first`);
	const originalAgent = anchor.link.delegatedAgent;
	const originalTool = anchor.anchorEvent?.tool ?? null;
	let chosenLater = null;
	for (const event of later) if (delegatedAgentOf(event) !== null) {
		chosenLater = event;
		break;
	}
	let kind;
	if (later.length === 0) kind = "none";
	else if (originalAgent === null) {
		kind = "unclear";
		uncertainty.push("the recorded original delegation carries no delegated agent");
	} else if (chosenLater === null) {
		kind = "unclear";
		uncertainty.push("later delegation events carry no recorded delegated agent");
	} else if (delegatedAgentOf(chosenLater) === originalAgent) kind = "retry-same-agent";
	else kind = "fallback-to-other-agent";
	let inputChanged = false;
	let inputChangeBasis = "unavailable";
	const laterTool = chosenLater === null ? null : chosenLater.tool;
	if (chosenLater !== null && originalTool !== null && laterTool !== null) {
		const originalState = classifyInput(originalTool.input);
		const laterState = classifyInput(laterTool.input);
		if (originalState === "comparable" && laterState === "comparable") {
			inputChanged = compareInputs(originalTool.input, laterTool.input).verdict !== "identical";
			inputChangeBasis = "derived";
		} else uncertainty.push(`delegation inputs are not comparable (original ${originalState}, later ${laterState})`);
	}
	const basis = anchor.anchorEvent === null || !complete ? "unavailable" : "derived";
	if (anchor.anchorEvent !== null && !complete) uncertainty.push("the parent stream is incomplete; the reaction is not classified from a full record");
	if (anchor.anchorEvent === null) uncertainty.push(`child ${child.sessionID} has no recorded delegation anchor`);
	return {
		kind,
		basis,
		eventIDs,
		agents,
		inputChanged,
		inputChangeBasis,
		uncertainty
	};
}
function childFailureEvidence(child) {
	const incidents = child.diagnostics && Array.isArray(child.diagnostics.incidents) ? child.diagnostics.incidents.length : 0;
	const sessionOutcome = child.analysis?.session?.outcome;
	const failedOrInterruptedTurns = childTurnsOf(child).filter((turn) => turn.status === "error" || turn.status === "interrupted").length;
	const failedOrInterruptedIdles = childEventsOf(child).filter((event) => event.kind === "idle" && (event.status === "failed" || event.status === "interrupted")).length;
	return {
		repeatedToolFailureIncidents: incidents,
		sessionOutcome,
		failedOrInterruptedTurns,
		failedOrInterruptedIdles,
		hasFailureEvidence: incidents > 0 || sessionOutcome === "failed" || sessionOutcome === "interrupted" || failedOrInterruptedTurns > 0 || failedOrInterruptedIdles > 0,
		basis: child.analysis?.coverage?.complete === true ? "measured" : "unavailable"
	};
}
function classifyPattern(childFailed, anchor, reaction, complete) {
	if (childFailed.basis !== "measured") return {
		kind: "insufficient-data",
		inputChangeProxy: false
	};
	if (anchor.anchorEvent === null) return {
		kind: "insufficient-data",
		inputChangeProxy: false
	};
	if (!complete) return {
		kind: "insufficient-data",
		inputChangeProxy: false
	};
	if (!childFailed.hasFailureEvidence) return {
		kind: "no-child-failure",
		inputChangeProxy: false
	};
	switch (reaction.kind) {
		case "none": return {
			kind: "child-failed-no-parent-reaction",
			inputChangeProxy: false
		};
		case "unclear": return {
			kind: "parent-reaction-unclear",
			inputChangeProxy: false
		};
		case "fallback-to-other-agent": return {
			kind: "parent-fallback-to-other-agent",
			inputChangeProxy: false
		};
		case "retry-same-agent":
			if (reaction.inputChangeBasis !== "derived") return {
				kind: "parent-retried-same-agent",
				inputChangeProxy: false
			};
			return reaction.inputChanged ? {
				kind: "parent-retried-with-changed-delegation-input",
				inputChangeProxy: true
			} : {
				kind: "parent-retried-identical-delegation-input",
				inputChangeProxy: false
			};
	}
}
function assessChild(child, parentEvents, parentTurns, complete, provided) {
	const anchor = provided === void 0 ? deriveAnchor(child, parentEvents, parentTurns) : providedAnchor(provided, parentEvents);
	const childFailed = childFailureEvidence(child);
	const parentReaction = buildReaction(anchor, parentEvents, complete, child);
	const classification = classifyPattern(childFailed, anchor, parentReaction, complete);
	const pattern = {
		kind: classification.kind,
		basis: classification.kind === "insufficient-data" ? "unavailable" : "derived",
		inputChangeProxy: classification.inputChangeProxy
	};
	const summary = child.diagnostics && child.diagnostics.summary ? { ...child.diagnostics.summary } : null;
	return {
		assessment: {
			link: anchor.link,
			childFailed,
			parentReaction,
			pattern,
			childDiagnosticsSummary: summary
		},
		uncertainty: parentReaction.uncertainty
	};
}
/**
* Evaluates delegation recovery for the direct children of one parent session.
*
* Pure and deterministic: no input is mutated and the returned DTO is fresh.
* It never throws on a malformed input shape; missing pieces degrade to
* `insufficient-data` plus deterministic `notes`/`uncertainty` entries.
*/
function evaluateDelegationRecovery(input) {
	const rootSessionID = typeof input.rootSessionID === "string" ? input.rootSessionID : "";
	const parentEvents = Array.isArray(input.parentEvents) ? input.parentEvents : [];
	const parentTurns = parentTurnsOf(input.parentAnalysis);
	const complete = parentComplete(input.parentAnalysis);
	const children = Array.isArray(input.children) ? input.children : [];
	const precomputedLinks = Array.isArray(input.delegationLinks) ? input.delegationLinks : [];
	const seen = input.seen instanceof Set ? input.seen : /* @__PURE__ */ new Set([rootSessionID]);
	const notes = [];
	const uncertainty = [];
	const sorted = [...children].sort((left, right) => {
		const delta = childTimeCreated(left) - childTimeCreated(right);
		if (delta !== 0) return delta;
		return left.sessionID < right.sessionID ? -1 : left.sessionID > right.sessionID ? 1 : 0;
	});
	const candidates = [];
	for (const child of sorted) {
		if (child.sessionID === rootSessionID || seen.has(child.sessionID)) {
			notes.push(`cycle detected: ${child.sessionID}`);
			continue;
		}
		candidates.push(child);
	}
	const assessed = candidates.slice(0, 8);
	if (assessed.length < candidates.length) notes.push(`${candidates.length - assessed.length} children not assessed (cap 8)`);
	const patternCounts = emptyPatternCounts();
	const assessments = [];
	for (const child of assessed) {
		const result = assessChild(child, parentEvents, parentTurns, complete, precomputedLinks.find((link) => link.childSessionID === child.sessionID));
		assessments.push(result.assessment);
		patternCounts[result.assessment.pattern.kind] += 1;
		for (const note of result.uncertainty) uncertainty.push(`child ${child.sessionID}: ${note}`);
	}
	const classified = assessments.some((assessment) => assessment.pattern.kind !== "insufficient-data");
	return {
		schemaVersion: 1,
		rootSessionID,
		depth: 1,
		redacted: input.reveal !== true,
		totalChildren: children.length,
		childrenCapped: candidates.length > 8,
		assessments,
		patternCounts,
		basis: classified ? "derived" : "unavailable",
		notes,
		uncertainty
	};
}
/**
* The standing basis notes. Deterministic phrases only: they restate where each
* value comes from and which linkage the recorder cannot supply.
*/
var BASIS_NOTES$1 = Object.freeze([
	"File paths are measured: they come from recorded tool inputs and write-tool file lists.",
	"Per-file cost shares are derived: each step's recorded cost is divided evenly across its tool calls, then across the files a call touched; calls that touch no file are not allocated.",
	"Command names are derived: the first recorded shell token only; full command text is never included.",
	"Commit linkage is unavailable: the session database records no git data (see docs/DATA-SOURCES.md)."
]);
/** Tool names whose `input` path fields name a read target. */
var READ_TOOL_NAMES = /* @__PURE__ */ new Set([
	"read",
	"grep",
	"glob",
	"list",
	"ls",
	"view",
	"search"
]);
/** Tool names whose `input` path fields name a write target. */
var WRITE_TOOL_NAMES = /* @__PURE__ */ new Set([
	"write",
	"edit",
	"patch",
	"multiedit",
	"apply_patch",
	"create"
]);
/** Tools whose input carries the shell command line. */
var SHELL_TOOL_NAMES = /* @__PURE__ */ new Set(["shell", "bash"]);
/** Input keys that carry a path verbatim. */
var PATH_KEYS = [
	"path",
	"filePath",
	"file",
	"dir",
	"directory"
];
/** Input keys that carry prose; only accepted when the value is path-shaped. */
var DESCRIPTION_KEYS = ["description"];
/**
* A first token we are willing to publish: no whitespace, no `=`, no quotes —
* so an inline credential assignment or a `--flag=secret` pair can never become
* a command name.
*/
var COMMAND_TOKEN = /^[A-Za-z0-9_./:\\-]+$/;
/** Bare punctuation is never an executable name. */
var BARE_PUNCTUATION = /* @__PURE__ */ new Set([
	"--",
	".",
	"/"
]);
/** A leading `NAME=value` environment assignment is not the executable. */
var ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Path identity follows the recorded filesystem's case semantics. */
var CASE_INSENSITIVE_PATHS = process.platform === "win32";
function recordOf(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
/** Deduplicates, drops empty ids and caps the list in recorded order. */
function capEvidenceIDs(ids, limit) {
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
function cleanPath(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 400) return null;
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
	return trimmed;
}
/**
* A prose `description` is only treated as a path when it cannot be prose: one
* token, and shaped like a path. This keeps free text out of the DTO while
* still accepting the description-shaped path some tools record.
*/
function pathShaped(value) {
	if (value.length === 0 || value.length > 400) return false;
	if (/\s/.test(value)) return false;
	if (value.endsWith(".")) return false;
	if (/[\\/]/.test(value)) return true;
	const dot = value.indexOf(".");
	return dot > 0 && dot < value.length - 1;
}
/**
* Accumulator identity for a path: separators unified to `/`, leading `./`
* dropped, and case-folded where the recorded filesystem is case-insensitive.
* The first spelling seen is what the DTO displays.
*
* Exported so downstream aggregates (recommendations) key on the same identity
* instead of the raw display spelling; this is the single path-identity rule.
*/
function pathIdentity(path) {
	let key = path.replace(/\\/g, "/");
	while (key.startsWith("./")) key = key.slice(2);
	return CASE_INSENSITIVE_PATHS ? key.toLowerCase() : key;
}
/**
* Paths a single tool call touched. Every path key is shape-gated, not just
* `description`: an MCP or plugin tool may emit any string there, and prose or
* a credential-shaped token must not become a file row. A write tool's
* `metadata.files[].file` list is a write; `metadata.files[].patch` is
* deliberately never read.
*/
function toolPaths(tool) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const input = recordOf(tool.input);
	const writes = WRITE_TOOL_NAMES.has(tool.name);
	const reads = READ_TOOL_NAMES.has(tool.name);
	const op = writes ? "write" : "read";
	const push = (value, kind) => {
		if (typeof value !== "string" || !pathShaped(value)) return;
		const path = cleanPath(value);
		if (path === null) return;
		const key = pathIdentity(path);
		if (seen.has(key)) return;
		seen.add(key);
		out.push({
			path,
			op: kind
		});
	};
	for (const key of PATH_KEYS) push(input[key], op);
	if (reads || writes) for (const key of DESCRIPTION_KEYS) push(input[key], op);
	const metadata = recordOf(tool.metadata);
	if (writes) {
		const files = Array.isArray(metadata.files) ? metadata.files : [];
		for (const entry of files) {
			const record = recordOf(entry);
			push(record.file ?? record.path ?? record.filePath, "write");
		}
	}
	return out;
}
/**
* Splits a recorded command line into tokens without breaking quoted segments.
* A quoted value stays one token (its surrounding quotes removed), so
* `PASSWORD="correct horse" npm test` tokenizes as the assignment, `npm`,
* `test` — never as `horse` followed by `npm`.
*/
function commandTokens(command) {
	const tokens = [];
	let current = "";
	let started = false;
	let quote = null;
	for (const char of command) {
		if (quote !== null) {
			if (char === quote) quote = null;
			else current += char;
			started = true;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (char === " " || char === "	" || char === "\n" || char === "\r") {
			if (started) {
				tokens.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += char;
		started = true;
	}
	if (started) tokens.push(current);
	return tokens;
}
/**
* First executable token of a recorded shell command. Only LEADING `KEY=value`
* assignments are skipped so a credential assignment cannot become the name; a
* first token that is not shell-token shaped yields no row at all.
*/
function firstCommandToken(input) {
	const record = recordOf(input);
	const command = record.command ?? record.script ?? record.cmd;
	if (typeof command !== "string") return null;
	const tokens = commandTokens(command);
	let index = 0;
	while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index] ?? "")) index += 1;
	const token = tokens[index];
	if (token === void 0 || token.length === 0) return null;
	if (token.length > 64) return null;
	if (BARE_PUNCTUATION.has(token)) return null;
	return COMMAND_TOKEN.test(token) ? token : null;
}
/**
* Tool-call event ids of a step, in recorded order. `Step.toolCalls` and the
* step's `tool` events are both built from the same recorded content-block
* order, so index `i` of each list names the same call.
*/
function toolEventIDs(step, eventByID) {
	const out = [];
	const ids = Array.isArray(step.eventIDs) ? step.eventIDs : [];
	for (const eventID of ids) if (eventByID.get(eventID)?.kind === "tool") out.push(eventID);
	return out;
}
function shareOf(cost, toolCalls, filesInCall) {
	if (cost === null || toolCalls <= 0 || filesInCall <= 0) return null;
	return cost / toolCalls / filesInCall;
}
/** Rounds a share to a 1e-12 grid so binary float noise never reaches the DTO. */
function roundShare(value) {
	return Math.round(value * 0xe8d4a51000) / 0xe8d4a51000;
}
function fileRows(files) {
	const rows = [];
	for (const item of files.values()) rows.push({
		path: item.path,
		ops: {
			read: item.read,
			write: item.write
		},
		costShare: item.cost === null ? metric(null, "unavailable", "no step that touched this path recorded a cost") : metric(roundShare(item.cost), "derived", "step cost divided evenly across the step's tool calls and the files each call touched"),
		basis: "measured",
		eventIDs: capEvidenceIDs(item.eventIDs, 6)
	});
	rows.sort((left, right) => (right.costShare.value ?? 0) - (left.costShare.value ?? 0) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const kept = rows.slice(0, 12);
	return {
		rows: kept,
		truncated: rows.length - kept.length
	};
}
function commandRows(commands) {
	const rows = [...commands.values()].map((item) => ({
		name: item.name,
		count: item.count,
		basis: "derived",
		eventIDs: capEvidenceIDs(item.eventIDs, 6)
	}));
	rows.sort((left, right) => right.count - left.count || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	const kept = rows.slice(0, 8);
	return {
		rows: kept,
		truncated: rows.length - kept.length
	};
}
function attributeTurn(turn, eventByID) {
	const files = /* @__PURE__ */ new Map();
	const commands = /* @__PURE__ */ new Map();
	const subtasks = [];
	const seenSubtasks = /* @__PURE__ */ new Set();
	const steps = Array.isArray(turn.steps) ? turn.steps : [];
	for (const step of steps) {
		if (!step) continue;
		const cost = typeof step.cost === "number" && Number.isFinite(step.cost) ? step.cost : null;
		const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
		const callCount = toolCalls.length;
		const callEvents = toolEventIDs(step, eventByID);
		for (let index = 0; index < callCount; index += 1) {
			const tool = toolCalls[index];
			if (!tool) continue;
			const eventID = callEvents[index] ?? null;
			const paths = toolPaths(tool);
			const share = shareOf(cost, callCount, paths.length);
			for (const item of paths) {
				const key = pathIdentity(item.path);
				let accumulator = files.get(key);
				if (!accumulator) {
					accumulator = {
						path: item.path,
						read: 0,
						write: 0,
						cost: null,
						eventIDs: []
					};
					files.set(key, accumulator);
				}
				if (item.op === "write") accumulator.write += 1;
				else accumulator.read += 1;
				if (share !== null) accumulator.cost = roundShare((accumulator.cost ?? 0) + share);
				if (eventID !== null) accumulator.eventIDs.push(eventID);
			}
			if (SHELL_TOOL_NAMES.has(tool.name)) {
				const name = firstCommandToken(tool.input);
				if (name !== null) {
					let accumulator = commands.get(name);
					if (!accumulator) {
						accumulator = {
							name,
							count: 0,
							eventIDs: []
						};
						commands.set(name, accumulator);
					}
					accumulator.count += 1;
					if (eventID !== null) accumulator.eventIDs.push(eventID);
				}
			}
			const childIDs = Array.isArray(tool.childSessionIDs) ? tool.childSessionIDs : [];
			for (const sessionID of childIDs) {
				if (typeof sessionID !== "string" || sessionID.length === 0) continue;
				if (seenSubtasks.has(sessionID)) continue;
				seenSubtasks.add(sessionID);
				if (subtasks.length >= 8) continue;
				const agent = recordOf(tool.input).agent;
				subtasks.push({
					sessionID,
					agent: typeof agent === "string" && agent.length > 0 ? agent : null,
					basis: "measured"
				});
			}
		}
	}
	const attributedFiles = fileRows(files);
	const attributedCommands = commandRows(commands);
	if (attributedFiles.rows.length === 0 && attributedCommands.rows.length === 0 && subtasks.length === 0) return null;
	return {
		turnID: turn.id,
		turnIndex: turn.index,
		taskID: turn.id,
		trigger: {
			kind: turn.trigger.kind,
			eventID: turn.trigger.eventID,
			label: turn.trigger.label
		},
		files: attributedFiles.rows,
		commands: attributedCommands.rows,
		subtasks,
		eventIDs: capEvidenceIDs(Array.isArray(turn.eventIDs) ? turn.eventIDs : [], 10),
		filesTruncated: attributedFiles.truncated,
		commandsTruncated: attributedCommands.truncated
	};
}
/**
* Primary entry point. Pure, deterministic and local.
*
* Returns `null` when no turn recorded a file, a shell command or a delegated
* child: the rider then stays absent instead of asserting an empty
* attribution, mirroring the diagnostics precedent. A malformed analysis also
* yields the absent rider instead of throwing, matching `delegation.ts`.
*/
function evaluateAttribution(analysis) {
	if (!analysis || !Array.isArray(analysis.events) || !Array.isArray(analysis.turns)) return null;
	const eventByID = new Map(analysis.events.map((event) => [event.id, event]));
	const turns = [];
	for (const turn of analysis.turns) {
		if (!turn) continue;
		const attributed = attributeTurn(turn, eventByID);
		if (attributed !== null) turns.push(attributed);
	}
	if (turns.length === 0) return null;
	return {
		turns,
		basisNotes: [...BASIS_NOTES$1]
	};
}
// src/core/format.ts
var numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
function formatNumber(value) {
	if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
	return numberFormat.format(value);
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
function formatDateTime(ms) {
	if (ms === null || ms === void 0 || !Number.isFinite(ms)) return "—";
	return new Date(ms).toISOString();
}
function formatTime(ms) {
	if (ms === null || ms === void 0 || !Number.isFinite(ms)) return "—";
	return `${new Date(ms).toISOString().slice(11, 23)}Z`;
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
function timestampForFilename(ms) {
	return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}
/**
* Escapes text interpolated into a Markdown line so it cannot open raw HTML
* or a Markdown link/code span. Emphasis markers are left alone to keep
* identifiers readable.
*/
function escapeMarkdownInline(value) {
	return value.replaceAll("\\", "\\\\").replace(/[`[\]<>&]/g, "\\$&").replace(/\r?\n/g, " ").trim();
}
function escapeMarkdownCell(value) {
	return escapeMarkdownInline(value).replaceAll("|", "\\|");
}
/** A compaction below this prompt-token context size invites the "was it needed?" question. */
var COMPACTION_CONTEXT_CEILING = 2e4;
/**
* The standing basis notes. Deterministic phrases only: they restate where the
* rows come from and what the layer refuses to do.
*/
var BASIS_NOTES = Object.freeze([
	"Recommendations are derived from this analysis: diagnostics incidents, session health rules, turns, compactions and attribution rows.",
	"Every hypothesis ships with a fact row naming the finding it rests on; a hypothesis is a suggestion, not a diagnosis.",
	"Notes are deterministic phrases plus counts: no prompt, tool output, file content, patch text or shell command line is included.",
	"Rows follow the fixed rule order, fact before its hypothesis; no numeric ordering artifact is computed.",
	"Recommendations are local and deterministic: no model and no network call is involved, and nothing here can act on a session."
]);
/** Recovery states that prove the failure run continued without a resolution. */
var UNRECOVERED = /* @__PURE__ */ new Set(["no-recovery-evidence"]);
/** Deduplicates, drops empty ids and caps the list in recorded order. */
function capIDs$2(ids, limit) {
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
function asArray(value) {
	return Array.isArray(value) ? value : [];
}
function minutes(ms) {
	return (ms / 6e4).toFixed(1);
}
/**
* A windowed analysis computes every aggregate over its window, so an
* aggregate rule appends this qualifier instead of stating the number as a
* session fact. Health words the same caveat in its insufficiency reasons
* ("the analysis covers a window, not the full session").
*/
function scopeNote(analysis) {
	return analysis.coverage?.complete === false ? " (in the analysed window)" : "";
}
/**
* Resolves turn ids to the event that best anchors them in the trajectory:
* the turn's trigger event, falling back to the turn's first recorded event.
* This is the single place that turns a turn-only finding into a drill link,
* so a health rule that yields turn ids but no event ids still links somewhere.
*/
function turnAnchors(analysis, turnIDs) {
	const byID = new Map(asArray(analysis.turns).map((turn) => [turn.id, turn]));
	const out = [];
	for (const turnID of turnIDs) {
		const turn = byID.get(turnID);
		if (!turn) continue;
		const anchor = turn.trigger?.eventID ?? asArray(turn.eventIDs)[0] ?? null;
		if (typeof anchor === "string" && anchor.length > 0) out.push(anchor);
	}
	return out;
}
function row(ruleID, kind, label, note, eventIDs = [], turnIDs = []) {
	return {
		id: `${ruleID}:${kind}`,
		kind,
		severity: kind === "fact" ? "info" : "advisory",
		ruleID,
		label,
		note,
		eventIDs: capIDs$2(eventIDs, 10),
		turnIDs: capIDs$2(turnIDs, 6)
	};
}
/** A fact row plus the hypothesis it supports, in that order. */
function pair(ruleID, factLabel, factNote, hypothesisLabel, hypothesisNote, eventIDs, turnIDs) {
	return [row(ruleID, "fact", factLabel, factNote, eventIDs, turnIDs), row(ruleID, "hypothesis", hypothesisLabel, hypothesisNote, eventIDs, turnIDs)];
}
/**
* Rule 1 — reads the already-computed `context-growth` health rule. The rule is
* the trigger and its deterministic note is restated verbatim; this rule never
* recounts turns. The health rule records turn ids but no event ids, so the
* turn anchors supply the drill link.
*/
function reduceContextRows(analysis) {
	const rule = asArray(analysis.health?.rules).find((item) => item.id === "context-growth");
	if (!rule?.triggered) return [];
	const level = rule.level ?? "watch";
	const anchors = turnAnchors(analysis, rule.turnIDs);
	return pair("reduce-context", rule.label, `Health rule "${rule.id}" is triggered (${level}): ${rule.note}.`, "Trim or summarize in-turn context", "Hypothesis: trimming or summarizing in-turn context before the next prompt may keep the growth run shorter.", anchors, rule.turnIDs);
}
/**
* Rule 2 — unrecovered diagnostic incidents. `possible-recovery` and
* `insufficient-data` are deliberately excluded: neither proves that the run
* continued unresolved.
*/
function retryFailedToolRows(analysis) {
	const unrecovered = asArray(analysis.diagnostics?.incidents).filter((incident) => UNRECOVERED.has(incident.recovery));
	if (unrecovered.length === 0) return [];
	let top = unrecovered[0];
	for (const incident of unrecovered) if (incident.attempts > top.attempts) top = incident;
	const tools = new Set(unrecovered.map((incident) => incident.tool));
	return pair("retry-failed-tool", "Unrecovered tool failures", `${unrecovered.length} incident(s) across ${tools.size} tool(s) have no recovery evidence; ${top.tool} failed ${top.attempts} time(s) in one run.`, "Verify the tool precondition before retrying", `Hypothesis: retrying ${top.tool} immediately may repeat the same failure; checking its precondition or configuration first may end the run sooner.`, unrecovered.map((incident) => incident.firstFailureEventID), unrecovered.map((incident) => incident.turnID));
}
/** First turn, in recorded order, that exceeds either split-task bound. */
function oversizedTurn(turns) {
	for (const turn of turns) {
		if (!turn) continue;
		if (asArray(turn.steps).length >= 12) return turn;
		if ((turn.totalTime?.value ?? 0) >= 9e5) return turn;
	}
	return null;
}
/** Rule 3 — one oversized turn, by step count or recorded turn time. */
function splitTaskRows(analysis) {
	const turn = oversizedTurn(asArray(analysis.turns));
	if (turn === null) return [];
	const steps = asArray(turn.steps).length;
	const elapsed = turn.totalTime?.value ?? 0;
	const suffix = scopeNote(analysis);
	const anchors = asArray(turn.eventIDs);
	return pair("split-task", "Large turn", `Turn ${turn.index} recorded ${steps} step(s) and ${minutes(elapsed)} min of recorded turn time${suffix}.`, "Split the task", `Hypothesis: splitting this turn into smaller prompts may keep each turn's context, step count and cost per turn lower${suffix}.`, anchors.length > 0 ? anchors : turnAnchors(analysis, [turn.id]), [turn.id]);
}
/** Rule 4 — repeated subagent calls, evidenced by the attributed subtasks. */
function reuseSubagentRows(analysis) {
	const calls = analysis.totals?.subagentCalls ?? 0;
	if (calls < 3) return [];
	const turnIDs = [];
	for (const turn of asArray(analysis.attribution?.turns)) if (asArray(turn.subtasks).length > 0) turnIDs.push(turn.turnID);
	if (turnIDs.length === 0) return [];
	const suffix = scopeNote(analysis);
	return pair("reuse-subagent", "Repeated subagent calls", `${calls} subagent call(s) were recorded in this analysis${suffix}.`, "Reuse a subagent for the repeated workload", `Hypothesis: ${calls} delegated calls may be served by one reusable subagent instead of starting a fresh delegate each time${suffix}.`, turnAnchors(analysis, turnIDs), turnIDs);
}
/** Rule 5 — compactions recorded while the context was still small. */
function avoidCompactionRows(analysis) {
	const compactions = asArray(analysis.compactions);
	const small = compactions.filter((item) => {
		const before = item.contextBefore?.value ?? null;
		return before !== null && before < 2e4;
	});
	if (small.length === 0) return [];
	const suffix = scopeNote(analysis);
	return pair("avoid-unnecessary-compaction", "Small-context compactions", `${small.length} of ${compactions.length} compaction(s) were recorded with less than ${COMPACTION_CONTEXT_CEILING} prompt tokens of context before them${suffix}.`, "Check whether the compaction was needed", `Hypothesis: a compaction recorded below ${COMPACTION_CONTEXT_CEILING} prompt tokens of context may not have been necessary; checking its trigger may avoid the summary cost next time${suffix}.`, small.map((item) => item.eventID), small.map((item) => item.turnID ?? ""));
}
/**
* Rule 6 — the attribution layer's own aggregates. A single path carrying at
* least half of the attributed file cost is a fact worth naming; concentration
* needs two attributed files to be meaningful.
*
* Entries are keyed on attribution's `pathIdentity`, so two spellings of the
* same file across turns (`src\hot.ts`, `src/hot.ts`) aggregate into one entry.
* The first-seen spelling is what the note displays.
*/
function concentratedFileRows(analysis) {
	const byPath = /* @__PURE__ */ new Map();
	for (const turn of asArray(analysis.attribution?.turns)) for (const file of asArray(turn.files)) {
		const value = file.costShare?.value ?? null;
		if (value === null || !(value > 0)) continue;
		const key = pathIdentity(file.path);
		let entry = byPath.get(key);
		if (!entry) {
			entry = {
				path: file.path,
				cost: 0,
				turnIDs: [],
				eventIDs: []
			};
			byPath.set(key, entry);
		}
		entry.cost += value;
		entry.turnIDs.push(turn.turnID);
		for (const eventID of asArray(file.eventIDs)) entry.eventIDs.push(eventID);
	}
	const files = [...byPath.values()].sort((left, right) => right.cost - left.cost || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	if (files.length < 2) return [];
	const total = files.reduce((sum, file) => sum + file.cost, 0);
	if (!(total > 0)) return [];
	const top = files[0];
	const share = top.cost / total;
	if (share < .5) return [];
	const percent = Math.round(share * 100);
	const suffix = scopeNote(analysis);
	const anchors = top.eventIDs.length > 0 ? top.eventIDs : turnAnchors(analysis, top.turnIDs);
	return [row("concentrated-file-cost", "fact", "Concentrated file cost", `${top.path} carries ${percent}% of the attributed file cost (${formatCost(top.cost)} across ${new Set(top.turnIDs).size} turn(s))${suffix}.`, anchors, top.turnIDs)];
}
/**
* Primary entry point. Pure, deterministic and local.
*
* Returns `null` when no rule triggers: the rider then stays absent instead of
* asserting an empty recommendation list, mirroring the diagnostics and
* attribution precedent. A malformed analysis also yields `null` rather than
* throwing, matching `delegation.ts` and `attribution.ts`.
*/
function evaluateRecommendations(analysis) {
	if (!analysis || !Array.isArray(analysis.turns) || !Array.isArray(analysis.events) || !Array.isArray(analysis.compactions)) return null;
	const rows = [
		...reduceContextRows(analysis),
		...retryFailedToolRows(analysis),
		...splitTaskRows(analysis),
		...reuseSubagentRows(analysis),
		...avoidCompactionRows(analysis),
		...concentratedFileRows(analysis)
	];
	if (rows.length === 0) return null;
	const basisNotes = analysis.coverage?.complete === false ? [...BASIS_NOTES, "The analysis covers a window, not the full session: every aggregate describes that window only."] : [...BASIS_NOTES];
	return {
		rows: rows.slice(0, 11),
		basisNotes
	};
}
/**
* The five operational rules a live poll reports. `error-rate` is a
* retrospective aggregate and `unfinished-outcome` would fire on every
* recorded failure or interrupt, so both stay out of the live vocabulary.
*/
var LIVE_WARNING_RULE_IDS = Object.freeze([
	"retry-count",
	"tool-failure-recurrence",
	"context-growth",
	"low-cache-hit",
	"cost-per-turn"
]);
/** Mirrors `projectSession`'s `sessionActive` without re-deriving it. */
function sessionActive(session) {
	const { busy, idle } = session.time;
	return busy !== void 0 && (idle === void 0 || busy > idle);
}
function isTerminalOutcome(status) {
	return status === "succeeded" || status === "failed" || status === "interrupted";
}
/**
* `ended` needs a recorded terminal outcome: the session outcome, or an idle
* message attached to the last turn. A session that merely has no open steps
* is not claimed as ended.
*/
function deriveState(analysis) {
	if (analysis.session.outcome) return "ended";
	const last = analysis.turns[analysis.turns.length - 1] ?? null;
	if (last !== null && hasTerminalIdle(analysis, last)) return "ended";
	if (sessionActive(analysis.session)) return "running";
	const { busy, idle } = analysis.session.time;
	if (busy !== void 0 && idle !== void 0) return "idle";
	return "unknown";
}
function hasTerminalIdle(analysis, turn) {
	const attached = new Set(turn.nonStepEventIDs);
	return analysis.events.some((event) => attached.has(event.id) && event.kind === "idle" && isTerminalOutcome(event.status));
}
/**
* Turn statuses that mean the turn has settled. No open turn can follow them:
* a later step-less turn does not re-open a finished one.
*/
var TERMINAL_TURN_STATUS = /* @__PURE__ */ new Set([
	"completed",
	"error",
	"interrupted"
]);
/**
* The last turn of the inspected list is the only candidate for the open turn.
* Selecting it (never searching backwards) fixes two leaks: a just-opened turn
* that has only its user message reads `unknown` with zero steps and is still
* open, while a session whose last turn already settled reports no open turn
* even when an earlier turn is still `running`. A session with a recorded
* terminal outcome never has an open turn.
*/
function openTurnOf(turns, state) {
	if (state === "ended") return null;
	const turn = turns[turns.length - 1];
	if (turn === void 0 || TERMINAL_TURN_STATUS.has(turn.status)) return null;
	return {
		index: turn.index,
		id: turn.id,
		startedAt: turn.startTime,
		steps: turn.steps.length,
		tokens: { ...turn.tokens },
		cost: turn.cost,
		uncertainty: ["session-in-progress"]
	};
}
/** Deduplicates, drops empty ids and caps the list in recorded order. */
function capIDs$1(ids, limit) {
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
/**
* Event id → turn id, built once per snapshot from the turns that are actually
* in scope. `Turn.eventIDs` already carries every event the turn owns, so a
* windowed poll never walks the whole event stream again.
*/
function eventTurnsByID(turns) {
	const map = /* @__PURE__ */ new Map();
	for (const turn of turns) for (const eventID of turn.eventIDs) map.set(eventID, turn.id);
	return map;
}
/**
* Triggered operational rules in the health order. When a turn window is
* supplied, evidence outside it is dropped and a rule with no in-window
* evidence is not reported: the snapshot describes the window, not the whole
* session. The note keeps its session-wide wording but is annotated, because
* the counts stay session-wide while only the evidence is windowed.
*/
function warningsOf(analysis, windowTurns) {
	const rules = analysis.health?.rules ?? [];
	const window = windowTurns === null ? null : new Set(windowTurns.map((turn) => turn.id));
	const turnByEvent = windowTurns === null ? null : eventTurnsByID(windowTurns);
	const windowSize = windowTurns?.length ?? 0;
	const out = [];
	for (const rule of rules) {
		if (!rule.triggered) continue;
		if (!LIVE_WARNING_RULE_IDS.includes(rule.id)) continue;
		const eventIDs = capIDs$1(rule.eventIDs, 10);
		const turnIDs = capIDs$1(rule.turnIDs, 6);
		const inWindowEvents = window === null || turnByEvent === null ? eventIDs : eventIDs.filter((id) => {
			const turnID = turnByEvent.get(id) ?? null;
			return turnID !== null && window.has(turnID);
		});
		const inWindowTurns = window === null ? turnIDs : turnIDs.filter((id) => window.has(id));
		if (window !== null && inWindowEvents.length === 0 && inWindowTurns.length === 0) continue;
		out.push({
			...rule,
			triggered: true,
			eventIDs: inWindowEvents,
			turnIDs: inWindowTurns,
			note: window === null ? rule.note : `${rule.note} (session-wide counts; evidence limited to the last ${windowSize} turn${windowSize === 1 ? "" : "s"})`,
			basis: "derived",
			uncertainty: ["session-in-progress"]
		});
	}
	return out;
}
function newEventsOf(analysis, since) {
	if (typeof since !== "string" || since.length === 0) return null;
	const out = [];
	for (const event of analysis.events) {
		if (event.orderKey <= since) continue;
		out.push(event);
		if (out.length >= 50) break;
	}
	return out;
}
function asOf(analysis) {
	const updated = analysis.session.time.updated;
	if (typeof updated === "number") return updated;
	const last = analysis.events[analysis.events.length - 1];
	if (last) return last.timestamp;
	return analysis.session.time.created;
}
function normalizeLastTurns(value) {
	if (value === void 0 || !Number.isFinite(value)) return null;
	const turns = Math.trunc(value);
	return turns > 0 ? turns : null;
}
/**
* Primary entry point. Pure, deterministic and local.
*
* `lastTurns > 0` bounds `openTurn` and the warning evidence to the turn
* suffix and emits a `turnWindow` label; `since` turns the event tail into an
* incremental page capped at `MAX_NEW_EVENTS`.
*/
function deriveLiveSnapshot(analysis, options = {}) {
	const lastTurns = normalizeLastTurns(options.lastTurns);
	const windowTurns = lastTurns === null ? null : analysis.turns.slice(-lastTurns);
	const turns = windowTurns ?? analysis.turns;
	const state = deriveState(analysis);
	const snapshot = {
		state,
		basis: "derived",
		asOf: asOf(analysis),
		openTurn: openTurnOf(turns, state),
		warnings: warningsOf(analysis, windowTurns),
		coverage: analysis.coverage,
		totalInSession: analysis.events.length,
		newEvents: newEventsOf(analysis, options.since)
	};
	if (lastTurns !== null) snapshot.turnWindow = {
		last: turns.length,
		of: analysis.turns.length
	};
	return snapshot;
}
// src/core/benchmark.ts
/**
* Cross-session benchmark: deterministic rollups over a bounded, recency-sorted
* candidate set.
*
* The layer is pure and server-agnostic: it never reads events, storage, HTTP
* or the DOM, never reads the clock and never re-reads the source. Callers hand
* it one already-projected row per session (`benchmarkInputFrom`) and it only
* aggregates.
*
* This module deliberately does **not** extend `episodeCompare`. That module's
* neutrality contract governs an ordinal, one-to-one alignment of two
* diagnostic episodes; a benchmark instead folds many independent sessions into
* descriptive group rollups. The shared discipline is that nothing is ranked:
* groups are ordered by their recorded key, patterns by kind and key, no field
* names a winner or an optimum, and every judgement-free average carries the
* `derived` basis of its inputs.
*
* Aggregation rules, all basis-propagated:
*
* - Sums (tokens, cost, turns, steps, retries, errors, tool-failure incidents,
*   compactions) cover every compared session.
* - Averages (cost per session, duration per session, cache hit rate) are
*   `derived` and skip a session whose value was not recorded.
* - Windowed sessions (`coverage.complete === false`) are counted in
*   `windowedCount` and in every sum, but excluded from every average: a
*   partial window cannot claim a comparable per-session rate.
*
* Notes are deterministic phrases plus counts, mirroring `HealthRuleResult.note`
* and `Diagnostics.why`: no prompt, file path, patch text or shell command line
* enters this DTO. The DTO carries session ids, model/provider/agent/outcome/
* task-type group keys, health-rule ids and tool names only — no directory is
* carried.
*/
/**
* How many of the newest sessions the service lists as candidates. Older
* sessions are never listed, so they can never enter a comparison.
*/
var CANDIDATE_LISTING_LIMIT = 1e3;
/** The dimension a comparison is grouped by. `none` yields only `overall`. */
var BENCHMARK_GROUP_BYS = Object.freeze([
	"none",
	"model",
	"provider",
	"agent",
	"outcome",
	"taskType"
]);
/** The closed set of recorded session outcomes a filter accepts. */
var BENCHMARK_OUTCOMES = Object.freeze([
	"succeeded",
	"failed",
	"interrupted"
]);
/**
* The task dimension is the turn trigger kind. Only a recorded user prompt and a
* recorded delegated prompt name a task; `synthetic`, `retry`, `resume` and
* `orphan` triggers do not.
*/
var BENCHMARK_TASK_TYPES = Object.freeze(["user", "delegation"]);
/** Group key for a session that did not record the dimension's value. */
var NOT_RECORDED = "not recorded";
function isBenchmarkGroupBy(value) {
	return typeof value === "string" && BENCHMARK_GROUP_BYS.includes(value);
}
function isBenchmarkTaskType(value) {
	return typeof value === "string" && BENCHMARK_TASK_TYPES.includes(value);
}
function isBenchmarkOutcome(value) {
	return typeof value === "string" && BENCHMARK_OUTCOMES.includes(value);
}
function text(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function equalsIgnoringCase(value, needle) {
	return typeof value === "string" && value.toLowerCase() === needle.toLowerCase();
}
function includesIgnoringCase(value, needle) {
	return typeof value === "string" && value.toLowerCase().includes(needle.toLowerCase());
}
/**
* Summary-level filters: date range, model, provider, agent, directory and
* outcome. The task-type filter is applied after projection, because turn
* triggers are not part of a session summary.
*
* `from`/`to` bound the recency anchor (`timeUpdated`, falling back to
* `timeCreated`) — the same field the comparison is sorted by.
*/
function matchesBenchmarkFilters(session, filters) {
	const anchor = session.timeUpdated ?? session.timeCreated;
	if (filters.from !== void 0 && anchor < filters.from) return false;
	if (filters.to !== void 0 && anchor > filters.to) return false;
	const model = text(filters.model);
	if (model !== void 0 && !equalsIgnoringCase(session.model?.id, model)) return false;
	const provider = text(filters.provider);
	if (provider !== void 0 && !equalsIgnoringCase(session.model?.providerID, provider)) return false;
	const agent = text(filters.agent);
	if (agent !== void 0 && !equalsIgnoringCase(session.agent, agent)) return false;
	const directory = text(filters.directory);
	if (directory !== void 0 && !includesIgnoringCase(session.directory, directory)) return false;
	const outcome = text(filters.outcome);
	if (outcome !== void 0 && !equalsIgnoringCase(session.outcome, outcome)) return false;
	return true;
}
/**
* True when a projected session recorded at least one turn of `taskType`.
* An unknown value matches nothing (the route rejects it before this runs).
*/
function matchesBenchmarkTaskType(input, taskType) {
	const wanted = text(taskType);
	if (wanted === void 0) return true;
	return input.taskTypes.includes(wanted);
}
/** True when at least one criterion is set (`groupBy` is not a criterion). */
function hasBenchmarkCriteria(filters) {
	return filters.from !== void 0 || filters.to !== void 0 || text(filters.model) !== void 0 || text(filters.provider) !== void 0 || text(filters.agent) !== void 0 || text(filters.directory) !== void 0 || text(filters.outcome) !== void 0 || text(filters.taskType) !== void 0;
}
function countOf(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
/**
* Failing tool names by incident count, descending, ties by name. A tool call
* counts once per recorded `error` status; the DTO carries names only.
*/
function failingToolsOf(analysis) {
	const counts = /* @__PURE__ */ new Map();
	for (const turn of analysis.turns) for (const step of turn.steps) for (const call of step.toolCalls) {
		if (call.status !== "error") continue;
		if (typeof call.name !== "string" || call.name.length === 0) continue;
		counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
	}
	return [...counts.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)).slice(0, 5).map(([name]) => name);
}
/** Recorded task trigger kinds, in `BENCHMARK_TASK_TYPES` order. */
function taskTypesOf(analysis) {
	const present = /* @__PURE__ */ new Set();
	for (const turn of analysis.turns) {
		const kind = turn.trigger.kind;
		if (kind === "user" || kind === "delegation") present.add(kind);
	}
	return BENCHMARK_TASK_TYPES.filter((kind) => present.has(kind));
}
/** One benchmark row from the session summary plus its projection. */
function benchmarkInputFrom(summary, analysis) {
	const totals = analysis.totals;
	return {
		sessionID: summary.id,
		directory: summary.directory ?? null,
		model: summary.model?.id ?? null,
		provider: summary.model?.providerID ?? null,
		agent: summary.agent ?? null,
		outcome: summary.outcome ?? null,
		timeCreated: summary.timeCreated,
		timeUpdated: summary.timeUpdated ?? null,
		totals: {
			turns: countOf(totals.turns),
			steps: countOf(totals.steps),
			tokens: totals.tokens,
			cost: totals.cost.value,
			duration: totals.wallClockTime.value,
			cacheHitRate: totals.cacheHitRate.value,
			retries: countOf(totals.retries),
			errors: countOf(totals.errors.total),
			toolFailures: analysis.diagnostics?.incidents.length ?? 0,
			compactions: countOf(totals.compactions)
		},
		triggeredRuleIDs: (analysis.health?.rules ?? []).filter((rule) => rule.triggered).map((rule) => rule.id),
		failingTools: failingToolsOf(analysis),
		windowed: analysis.coverage.complete === false,
		taskTypes: taskTypesOf(analysis)
	};
}
function presentNumbers(values) {
	return values.filter((value) => typeof value === "number" && Number.isFinite(value));
}
/** Sum of the recorded values, `derived`, with the missing count in the note. */
function sumMetric(values, what) {
	if (values.length === 0) return metric(null, "unavailable", "no sessions were compared");
	const present = presentNumbers(values);
	if (present.length === 0) return metric(null, "unavailable", `no session recorded ${what}`);
	const missing = values.length - present.length;
	return metric(present.reduce((sum, value) => sum + value, 0), "derived", missing === 0 ? `sum across ${values.length} session(s)` : `${missing} of ${values.length} session(s) did not record ${what}`);
}
/**
* Arithmetic mean of the recorded values, `derived`. Callers pass only the
* comparable (non-windowed) sessions; `comparable` is the denominator the note
* reports so an excluded session stays visible.
*/
function averageMetric(values, comparable, what) {
	const present = presentNumbers(values);
	if (present.length === 0) return comparable === 0 ? metric(null, "unavailable", "no session was comparable") : metric(null, "unavailable", `no comparable session recorded ${what}`);
	return metric(present.reduce((sum, value) => sum + value, 0) / present.length, "derived", `${present.length} of ${comparable} comparable session(s) recorded ${what}`);
}
function emptyTokens() {
	return {
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0
	};
}
function tokenTotal(tokens) {
	return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite;
}
function completionsFor(inputs) {
	const counts = {
		succeeded: 0,
		failed: 0,
		interrupted: 0,
		unrecorded: 0
	};
	for (const input of inputs) if (input.outcome === "succeeded") counts.succeeded += 1;
	else if (input.outcome === "failed") counts.failed += 1;
	else if (input.outcome === "interrupted") counts.interrupted += 1;
	else counts.unrecorded += 1;
	return counts;
}
function rollupsFor(inputs) {
	const comparable = inputs.filter((input) => !input.windowed);
	const windowedCount = inputs.length - comparable.length;
	const tokens = inputs.length === 0 ? emptyTokens() : sumTokens(inputs.map((input) => input.totals.tokens)).tokens;
	return {
		sessions: inputs.length,
		turns: inputs.reduce((sum, input) => sum + input.totals.turns, 0),
		steps: inputs.reduce((sum, input) => sum + input.totals.steps, 0),
		tokens,
		tokensTotal: tokenTotal(tokens),
		costSum: sumMetric(inputs.map((input) => input.totals.cost), "a cost value"),
		costPerSession: averageMetric(comparable.map((input) => input.totals.cost), comparable.length, "a cost value"),
		durationPerSession: averageMetric(comparable.map((input) => input.totals.duration), comparable.length, "a duration"),
		cacheHitRate: averageMetric(comparable.map((input) => input.totals.cacheHitRate), comparable.length, "a cache hit rate"),
		retries: inputs.reduce((sum, input) => sum + input.totals.retries, 0),
		errors: inputs.reduce((sum, input) => sum + input.totals.errors, 0),
		toolFailures: inputs.reduce((sum, input) => sum + input.totals.toolFailures, 0),
		compactions: inputs.reduce((sum, input) => sum + input.totals.compactions, 0),
		completions: completionsFor(inputs),
		windowedCount,
		averagedSessions: comparable.length
	};
}
/** The recorded value a group is built on; missing values share one group. */
function benchmarkGroupKey(groupBy, input) {
	if (groupBy === "model") {
		if (input.model === null) return NOT_RECORDED;
		return input.provider === null ? input.model : `${input.provider}/${input.model}`;
	}
	if (groupBy === "provider") return input.provider ?? "not recorded";
	if (groupBy === "agent") return input.agent ?? "not recorded";
	if (groupBy === "outcome") return input.outcome ?? "not recorded";
	if (groupBy === "taskType") return input.taskTypes.length === 0 ? NOT_RECORDED : input.taskTypes.join("+");
	return NOT_RECORDED;
}
function compareKeys(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
/** Groups ordered by recorded key: declaration order is never importance. */
function groupsFor(inputs, groupBy) {
	const buckets = /* @__PURE__ */ new Map();
	for (const input of inputs) {
		const key = benchmarkGroupKey(groupBy, input);
		const bucket = buckets.get(key);
		if (bucket) bucket.push(input);
		else buckets.set(key, [input]);
	}
	return [...buckets.entries()].sort((left, right) => compareKeys(left[0], right[0])).map(([key, members]) => ({
		key,
		label: key,
		count: members.length,
		rollups: rollupsFor(members)
	}));
}
/**
* Recurring patterns: the same triggered health rule id, or the same top failing
* tool, recorded in at least `PATTERN_MIN_SESSIONS` sessions. Deterministic
* group-bys only — no correlation, no similarity, no co-occurrence scoring.
*/
function patternsFor(inputs) {
	const rules = /* @__PURE__ */ new Map();
	const tools = /* @__PURE__ */ new Map();
	const push = (bucket, key, sessionID) => {
		const ids = bucket.get(key);
		if (ids) ids.push(sessionID);
		else bucket.set(key, [sessionID]);
	};
	for (const input of inputs) {
		for (const ruleID of input.triggeredRuleIDs) if (typeof ruleID === "string" && ruleID.length > 0) push(rules, ruleID, input.sessionID);
		const top = input.failingTools[0];
		if (typeof top === "string" && top.length > 0) push(tools, top, input.sessionID);
	}
	const out = [];
	for (const [key, sessionIDs] of [...rules.entries()].sort((left, right) => compareKeys(left[0], right[0]))) {
		if (sessionIDs.length < 3) continue;
		out.push({
			kind: "health-rule",
			key,
			sessionCount: sessionIDs.length,
			sessionIDs
		});
	}
	for (const [key, sessionIDs] of [...tools.entries()].sort((left, right) => compareKeys(left[0], right[0]))) {
		if (sessionIDs.length < 3) continue;
		out.push({
			kind: "failing-tool",
			key,
			sessionCount: sessionIDs.length,
			sessionIDs
		});
	}
	return out;
}
/** "1 session" / "2 sessions" — a count with the grammar of its noun. */
function counted(count, singular) {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
/**
* Provenance notes. Note 1 names three different counts, because they are three
* different sets: what was compared, what was loaded, and what matched the
* summary filters. Loading stops at the cap, so the matched set can be larger
* than the loaded one; the task-type filter runs after loading, so the compared
* set can be smaller than the loaded one.
*/
function basisNotesFor(inputs, options) {
	const compared = inputs.length;
	const matched = options.candidatesConsidered ?? compared;
	const loaded = options.candidatesLoaded ?? compared;
	const skipped = options.skippedSessions ?? 0;
	const capped = options.sessionsCapped === true || matched > loaded;
	const windowedCount = inputs.filter((input) => input.windowed).length;
	const notes = [];
	notes.push(`Compared ${compared} of ${counted(loaded, "loaded candidate")} (${counted(matched, "session")} matched the summary filters${capped ? "; older candidates were not loaded" : ""}).`);
	const droppedByTaskType = Math.max(0, loaded - compared - skipped);
	if (droppedByTaskType > 0) notes.push(`${counted(droppedByTaskType, "loaded candidate")} recorded none of the requested task types and ${droppedByTaskType === 1 ? "was" : "were"} not compared.`);
	notes.push(`Windowed sessions (coverage.complete = false) are counted in sums and completion counts and excluded from averages; ${windowedCount} of ${inputs.length} compared session(s) are windowed.`);
	notes.push("Averages are derived: cost per session, duration per session and cache hit rate skip a session whose value was not recorded.");
	notes.push(`Recurring patterns are deterministic group-bys: a health rule or a top failing tool recorded in at least 3 sessions. Nothing is ranked.`);
	if (skipped > 0) notes.push(`${skipped} candidate session(s) could not be loaded between listing and comparison and were skipped.`);
	notes.push(`Candidates are the ${CANDIDATE_LISTING_LIMIT} most recently updated sessions; older sessions were never listed.`);
	return notes;
}
/**
* Primary entry point. Pure, deterministic and local; an empty input set yields
* a valid empty-shaped benchmark instead of throwing.
*
* The three candidate counts are normalised so their notes stay coherent:
* `compared` ≤ `loaded` ≤ `matched`. An omitted count falls back to the next
* inner one, so a caller that only knows the compared set needs no options.
*/
function computeBenchmark(inputs, options = {}) {
	const groupBy = isBenchmarkGroupBy(options.groupBy) ? options.groupBy : "none";
	const compared = inputs.length;
	const matched = Math.max(compared, options.candidatesConsidered ?? compared);
	const loaded = Math.min(matched, Math.max(compared, options.candidatesLoaded ?? compared));
	const sessionsCapped = options.sessionsCapped === true || matched > loaded;
	return {
		groupBy,
		groups: groupBy === "none" ? [] : groupsFor(inputs, groupBy),
		overall: {
			count: compared,
			rollups: rollupsFor(inputs)
		},
		recurringPatterns: patternsFor(inputs),
		sessionsCapped,
		candidatesConsidered: matched,
		basisNotes: basisNotesFor(inputs, {
			...options,
			candidatesConsidered: matched,
			candidatesLoaded: loaded,
			sessionsCapped
		})
	};
}
// src/core/digest.ts
/**
* Deterministic, size-capped Markdown digest of a normalized session analysis.
*
* The digest is a pure function of the caller-redacted projection: it never
* reads `analysis.generatedAt`, never consults the current time and never
* performs I/O, so the same input always renders byte-identical output. It is
* intended as review material for an LLM of the user's choice; the application
* itself performs no network calls.
*/
/** Hard upper bound on the rendered digest length, in characters. */
var DIGEST_MAX_CHARS = 16e3;
var DIGEST_MAX_ERRORS = 20;
var DIGEST_MAX_RETRY_TURNS = 20;
var DIGEST_MAX_COMPACTIONS = 10;
var DIGEST_MAX_TOOL_ROWS = 15;
var DIGEST_MAX_EXPENSIVE_STEPS = 10;
var DIGEST_MAX_ERROR_MESSAGE = 300;
var DIGEST_MAX_TOOL_NAMES = 60;
var FOOTER = "Generated by opencode-session-observability — deterministic digest.";
var REDACTED_BANNER = "> Redacted: credential-shaped values were replaced with [REDACTED].";
var UNREDACTED_BANNER = "> UNREDACTED: generated with reveal active — contains unredacted secrets. Share only with tools you trust.";
/**
* Review instructions prepended to a digest. One canonical source for the
* endpoint and the plugin RPC, so no client duplicates the template. The list
* is joined with `\n` to keep the verbatim line structure exact.
*/
var REVIEW_PROMPT_INSTRUCTIONS = [
	"You are reviewing an OpenCode coding-agent session from its observability data.",
	"Assess whether the session was effective, efficient, and safe. Do not invent facts",
	"that are not supported by the supplied data.",
	"Analyze:",
	"1. Outcome: Did the agent appear to complete the requested work? Identify unfinished",
	"   or uncertain work.",
	"2. Efficiency: Identify wasted turns, repeated tool calls, unnecessary exploration,",
	"   retry loops, and expensive steps.",
	"3. Context management: Identify context growth, compaction events, cache reuse, and",
	"   possible loss of relevant context.",
	"4. Tool usage: Identify failed tools, repeated failures, slow tools, and suspicious",
	"   parameter choices.",
	"5. Errors: Identify root causes, recurrence patterns, and the earliest point where",
	"   intervention would have helped.",
	"6. Recommendations: Provide at most five concrete, actionable improvements for the",
	"   next session. Separate facts from hypotheses.",
	"Return this structure:",
	"- Verdict: effective / partially effective / ineffective",
	"- Key findings",
	"- Inefficiencies",
	"- Failure analysis",
	"- Context and cost observations",
	"- Recommended next-session changes",
	"- Open questions",
	"Be concise and evidence-based. Refer to turn numbers and tool names where possible.",
	"SESSION DIGEST:"
].join("\n");
/**
* Assembles the full review prompt: optional unredacted warning, the verbatim
* instructions and the digest, whose title immediately follows the template's
* closing `SESSION DIGEST:` line.
*/
function buildReviewPrompt(digest, options) {
	return `${options.unredacted ? `${UNREDACTED_BANNER}\n\n` : ""}${REVIEW_PROMPT_INSTRUCTIONS}\n${digest}`;
}
/**
* Renders the digest for one session. See the module comment for the purity
* guarantees; every ordering, limit and marker below is fixed so that two
* calls with equal input produce equal output.
*/
function buildSessionDigest(input) {
	const { session, analysis, unredacted } = input;
	const totals = analysis.totals;
	const lines = [];
	const title = session.title ?? session.slug ?? session.id;
	lines.push(`# Session digest — ${escapeMarkdownInline(title)}`, "");
	lines.push(`- Session: \`${escapeMarkdownInline(session.id)}\``, `- Agent: \`${escapeMarkdownInline(session.agent ?? "—")}\``, `- Model: \`${escapeMarkdownInline(modelLabel$1(session.model))}\``, `- Created: ${formatDateTime(session.time.created)}`, `- Updated: ${formatDateTime(session.time.updated ?? null)}`, `- Outcome: ${session.outcome ?? "—"}`, `- Source: ${analysis.capabilities.source} (${analysis.coverage.complete ? "full session" : "window"})`, "");
	lines.push(unredacted ? UNREDACTED_BANNER : REDACTED_BANNER, "");
	lines.push("## Totals", "");
	lines.push(...totalsLines(totals));
	lines.push("");
	lines.push("## Errors", "");
	pushCapped(lines, collectErrors(analysis.turns, analysis.events), DIGEST_MAX_ERRORS, "errors");
	lines.push("");
	lines.push("## Retries", "");
	lines.push(`Retries recorded in totals: ${formatNumber(totals.retries)}.`);
	const retryTurns = analysis.turns.filter((turn) => turn.trigger.kind === "retry");
	if (retryTurns.length === 0) {
		if (totals.retries === 0) lines.push("None recorded.");
	} else pushCapped(lines, retryTurns.map((turn) => `- Turn ${turn.index} — ${escapeMarkdownInline(turn.trigger.label)}`), DIGEST_MAX_RETRY_TURNS, "retry turns");
	lines.push("");
	lines.push("## Compactions", "");
	pushCapped(lines, compactionLines(analysis.compactions), DIGEST_MAX_COMPACTIONS, "compactions", { keepLast: true });
	lines.push("");
	lines.push("## Notable tool activity", "");
	const toolRows = toolAggregates(analysis.turns);
	const stepRows = rankExpensiveSteps(analysis.turns);
	if (toolRows.length === 0 && stepRows.length === 0) lines.push("None recorded.");
	else {
		const blocks = [];
		if (toolRows.length > 0) {
			const shown = toolRows.slice(0, DIGEST_MAX_TOOL_ROWS);
			const block = [
				"### Tools",
				"",
				...table([
					"Tool",
					"Calls",
					"Errors",
					"Duration"
				], shown)
			];
			if (toolRows.length > shown.length) block.push(`[truncated: ${toolRows.length - shown.length} of ${toolRows.length} tools omitted]`);
			blocks.push(block);
		}
		if (stepRows.length > 0) {
			const shown = stepRows.slice(0, DIGEST_MAX_EXPENSIVE_STEPS);
			const block = [
				"### Expensive steps",
				"",
				...table([
					"Step",
					"Tools",
					"Cost",
					"Time"
				], shown)
			];
			if (stepRows.length > shown.length) block.push(`[truncated: ${stepRows.length - shown.length} of ${stepRows.length} expensive steps omitted]`);
			blocks.push(block);
		}
		blocks.forEach((block, index) => {
			if (index > 0) lines.push("");
			lines.push(...block);
		});
	}
	lines.push("");
	lines.push("## Turn summary", "");
	const selected = selectTurns(analysis.turns);
	if (selected.length === 0) lines.push("None recorded.");
	else {
		lines.push(...table([
			"#",
			"Trigger",
			"Steps",
			"Tools",
			"In",
			"Out",
			"Cost",
			"Duration",
			"Status"
		], selected.map(turnRow)));
		const dropped = analysis.turns.length - selected.length;
		if (dropped > 0) lines.push(`[truncated: ${dropped} of ${analysis.turns.length} turns omitted]`);
	}
	lines.push("");
	lines.push(FOOTER);
	return applyHardLimit(lines.join("\n"));
}
function totalsLines(totals) {
	const lines = [
		`- Turns: ${formatNumber(totals.turns)}`,
		`- Steps: ${formatNumber(totals.steps)}`,
		`- Tool calls: ${formatNumber(totals.toolCalls)}`,
		`- Subagent calls: ${formatNumber(totals.subagentCalls)}`,
		`- Errors: ${formatNumber(totals.errors.total)} (tool ${formatNumber(totals.errors.tool)}, step ${formatNumber(totals.errors.step)}, session ${formatNumber(totals.errors.session)})`,
		`- Retries: ${formatNumber(totals.retries)}`,
		`- Compactions: ${formatNumber(totals.compactions)}`,
		`- Input tokens: ${formatNumber(totals.tokens.input)}`,
		`- Output tokens: ${formatNumber(totals.tokens.output)}`,
		`- Reasoning tokens: ${formatNumber(totals.tokens.reasoning)}`,
		`- Cache read: ${formatNumber(totals.tokens.cacheRead)}`,
		`- Cache write: ${formatNumber(totals.tokens.cacheWrite)}`,
		`- Cache hit rate: ${formatPercent(totals.cacheHitRate.value)}`,
		`- Cost: ${formatCost(totals.cost.value)}`,
		`- Model time: ${formatDuration(totals.modelTime.value)}`,
		`- Tool time: ${formatDuration(totals.toolTime.value)}`,
		`- Active turn time: ${formatDuration(totals.activeTurnTime.value)}`,
		`- Wall clock: ${formatDuration(totals.wallClockTime.value)}`,
		`- Output speed: ${speedText(totals.outputSpeed)}`,
		`- Final context: ${formatNumber(totals.finalContext.value)}`,
		`- Cumulative prompt: ${formatNumber(totals.cumulativePrompt.value)}`
	];
	if (totals.recorded) {
		const recorded = totals.recorded;
		const parts = [];
		if (recorded.tokens) parts.push(`tokens input ${formatNumber(recorded.tokens.input)}, output ${formatNumber(recorded.tokens.output)}, reasoning ${formatNumber(recorded.tokens.reasoning)}, cache read ${formatNumber(recorded.tokens.cacheRead)}, cache write ${formatNumber(recorded.tokens.cacheWrite)}`);
		if (recorded.cost !== void 0) parts.push(`cost ${formatCost(recorded.cost)}`);
		parts.push(recorded.note);
		lines.push(`- Recorded by OpenCode: ${parts.join(" · ")}`);
	}
	return lines;
}
function toolAggregates(turns) {
	const aggregates = /* @__PURE__ */ new Map();
	for (const turn of orderedTurns(turns)) for (const step of orderedSteps(turn.steps)) for (const tool of step.toolCalls) {
		const entry = aggregates.get(tool.name) ?? {
			calls: 0,
			errors: 0,
			duration: 0,
			durationKnown: false
		};
		entry.calls += 1;
		if (tool.error || tool.status === "error") entry.errors += 1;
		if (tool.duration.value !== null) {
			entry.duration += tool.duration.value;
			entry.durationKnown = true;
		}
		aggregates.set(tool.name, entry);
	}
	return [...aggregates.entries()].sort((a, b) => {
		if (a[1].calls !== b[1].calls) return b[1].calls - a[1].calls;
		return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
	}).map(([name, entry]) => [
		name,
		String(entry.calls),
		String(entry.errors),
		entry.durationKnown ? formatDuration(entry.duration) : "—"
	]);
}
function rankExpensiveSteps(turns) {
	const candidates = [];
	for (const turn of orderedTurns(turns)) for (const step of orderedSteps(turn.steps)) {
		const cost = step.cost;
		const time = step.totalTime.value;
		if ((cost ?? 0) <= 0 && (time ?? 0) <= 0) continue;
		candidates.push({
			turn: turn.index,
			step,
			cost: cost ?? -1,
			time: time ?? -1
		});
	}
	candidates.sort((a, b) => {
		if (a.cost !== b.cost) return b.cost - a.cost;
		if (a.time !== b.time) return b.time - a.time;
		if (a.turn !== b.turn) return a.turn - b.turn;
		return a.step.index - b.step.index;
	});
	return candidates.map(({ turn, step }) => [
		`${turn}.${step.index}`,
		toolNamesOf(step).join(", ") || "—",
		formatCost(step.cost),
		formatDuration(step.totalTime.value)
	]);
}
function compactionLines(compactions) {
	return orderedCompactions(compactions).map((item) => `- ${formatDateTime(item.timestamp)} — context ${formatNumber(item.contextBefore.value)} → ${formatNumber(item.contextAfter.value)}, removed ${formatNumber(item.removedTokens.value)} tokens, summary ${formatNumber(item.summaryChars)} chars, cost ${formatCost(item.cost)}`);
}
function collectErrors(turns, events) {
	const entries = [];
	for (const turn of orderedTurns(turns)) for (const step of orderedSteps(turn.steps)) {
		if (step.status === "error") {
			const detail = step.finish ? `: ${clip(escapeMarkdownInline(step.finish), DIGEST_MAX_ERROR_MESSAGE)}` : "";
			entries.push(`- Turn ${turn.index}.${step.index} — step error${detail}`);
		}
		for (const tool of step.toolCalls) if (tool.error) entries.push(`- Turn ${turn.index}.${step.index} tool ${escapeMarkdownInline(tool.name)} — ${escapeMarkdownInline(tool.error.type)}: ${clip(escapeMarkdownInline(tool.error.message), DIGEST_MAX_ERROR_MESSAGE)}`);
		else if (tool.status === "error") entries.push(`- Turn ${turn.index}.${step.index} tool ${escapeMarkdownInline(tool.name)} — tool error (no detail recorded)`);
	}
	for (const event of events) {
		if (event.kind !== "idle") continue;
		if (event.status !== "failed" && event.status !== "interrupted") continue;
		entries.push(`- Session — ${event.status} at ${formatDateTime(event.timestamp)}`);
	}
	return entries;
}
function turnRow(turn) {
	const tools = turnToolNames(turn);
	return [
		String(turn.index),
		turn.trigger.label,
		String(turn.steps.length),
		tools.length > 0 ? clip(tools.join(", "), DIGEST_MAX_TOOL_NAMES) : "—",
		formatNumber(turn.tokens.input),
		formatNumber(turn.tokens.output),
		formatCost(turn.cost.value),
		formatDuration(turn.totalTime.value),
		turn.status
	];
}
/**
* Keeps the most recent turns plus every errored or interrupted turn, unioned
* and sorted ascending. Error turns are never dropped by recency.
*/
function selectTurns(turns) {
	const ordered = orderedTurns(turns);
	const picked = [...ordered.slice(-25), ...ordered.filter((turn) => turn.status === "error" || turn.status === "interrupted")];
	const seen = /* @__PURE__ */ new Set();
	const selected = [];
	for (const turn of picked) {
		if (seen.has(turn.id)) continue;
		seen.add(turn.id);
		selected.push(turn);
	}
	return selected.sort((a, b) => a.index - b.index);
}
function pushCapped(lines, entries, limit, label, options = {}) {
	if (entries.length === 0) {
		lines.push("None recorded.");
		return;
	}
	const shown = options.keepLast ? entries.slice(Math.max(0, entries.length - limit)) : entries.slice(0, limit);
	lines.push(...shown);
	if (entries.length > shown.length) lines.push(`[truncated: ${entries.length - shown.length} of ${entries.length} ${label} omitted]`);
}
/** Final deterministic cut on a line boundary, keeping the footer intact. */
function applyHardLimit(value) {
	if (value.length <= 16e3) return value;
	const footer = `\n${FOOTER}`;
	const body = value.endsWith(footer) ? value.slice(0, value.length - footer.length) : value;
	const lines = body.split("\n");
	const build = (count) => {
		const kept = lines.slice(0, count).join("\n");
		return `${kept}\n[digest truncated: ${body.length - kept.length} chars omitted]${footer}`;
	};
	let low = 0;
	let high = lines.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (build(mid).length <= 16e3) low = mid;
		else high = mid - 1;
	}
	const result = build(low);
	return result.length <= 16e3 ? result : result.slice(0, DIGEST_MAX_CHARS);
}
function modelLabel$1(model) {
	if (!model) return "—";
	return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}
function speedText(metric) {
	return metric.value === null ? "—" : `${metric.value.toFixed(1)} tok/s`;
}
function toolNamesOf(step) {
	const names = [];
	const source = step.toolCalls.length > 0 ? step.toolCalls.map((tool) => tool.name) : step.toolNames;
	for (const name of source) if (!names.includes(name)) names.push(name);
	return names;
}
function turnToolNames(turn) {
	const names = [];
	for (const step of orderedSteps(turn.steps)) for (const name of toolNamesOf(step)) if (!names.includes(name)) names.push(name);
	return names;
}
function clip(value, max) {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}
function orderedTurns(turns) {
	return [...turns].sort((a, b) => a.index - b.index);
}
function orderedSteps(steps) {
	return [...steps].sort((a, b) => a.index - b.index);
}
function orderedCompactions(compactions) {
	return [...compactions].sort((a, b) => a.timestamp - b.timestamp);
}
function table(headers, rows) {
	return [
		`| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`)
	];
}
// src/core/export.ts
var GENERATOR = "opencode-session-observability/0.1.0";
function exportSession(input) {
	const stamp = timestampForFilename(input.analysis.generatedAt);
	const base = `${slugify(input.session.title ?? input.session.slug ?? input.session.id)}-${stamp}`;
	if (input.format === "json") return {
		filename: `${base}.json`,
		mime: "application/json; charset=utf-8",
		content: exportJson(input),
		redacted: input.redacted
	};
	if (input.format === "markdown") return {
		filename: `${base}.md`,
		mime: "text/markdown; charset=utf-8",
		content: exportMarkdown(input),
		redacted: input.redacted
	};
	if (input.format === "digest") {
		const unredacted = !input.redacted;
		const digest = buildSessionDigest({
			session: input.session,
			analysis: input.analysis,
			unredacted
		});
		const prompt = input.prompt === true;
		return {
			filename: `${base}-${prompt ? "review-prompt" : "digest"}.md`,
			mime: "text/markdown; charset=utf-8",
			content: prompt ? buildReviewPrompt(digest, { unredacted }) : digest,
			redacted: input.redacted
		};
	}
	return {
		filename: `${base}.html`,
		mime: "text/html; charset=utf-8",
		content: exportHtml(input),
		redacted: input.redacted
	};
}
function exportJson(input) {
	return JSON.stringify({
		generator: GENERATOR,
		version: 1,
		exportedAt: new Date(input.analysis.generatedAt).toISOString(),
		redacted: input.redacted,
		session: input.session,
		analysis: input.analysis,
		...input.includeEvents ? { events: input.events } : {},
		limitations: input.analysis.capabilities.notes
	}, null, 2);
}
function metricMd(metric, formatter) {
	if (metric.value === null) return "—";
	const mark = metric.basis === "measured" ? "" : ` ${basisMark(metric.basis)}`;
	return `${formatter(metric.value)}${mark}`;
}
function modelLabel(model) {
	if (!model) return "—";
	return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}
function turnModel(turn) {
	return modelLabel([...turn.steps].reverse().find((item) => item.model)?.model ?? null);
}
function triggerLabel(turn) {
	return turn.trigger.label;
}
function eventBadgeText(event) {
	const badges = [];
	if (event.flags.error) badges.push("error");
	if (event.flags.retry) badges.push("retry");
	if (event.flags.compaction) badges.push("compaction");
	if (event.flags.context) badges.push("context");
	if (event.flags.subagent) badges.push("subagent");
	if (event.uncertainty.length > 0) badges.push("uncertain");
	return badges.join(", ");
}
function mdTable(headers, rows) {
	return [
		`| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.map((cell) => escapeMarkdownCell(String(cell))).join(" | ")} |`)
	].join("\n");
}
function exportMarkdown(input) {
	const { session, analysis, redacted } = input;
	const lines = [];
	const title = session.title ?? session.slug ?? session.id;
	lines.push(`# ${escapeMarkdownInline(title)}`);
	lines.push("");
	if (redacted) {
		lines.push("> **Redacted export.** Credential-shaped values were replaced with `[REDACTED]`. Re-export with `reveal` to include raw values.");
		lines.push("");
	}
	lines.push(`- **Session**: \`${session.id}\``, `- **Directory**: \`${escapeMarkdownInline(session.directory ?? "—")}\``, `- **Agent**: \`${escapeMarkdownInline(session.agent ?? "—")}\``, `- **Model**: \`${modelLabel(session.model)}\``, `- **Created**: ${formatDateTime(session.time.created)}`, `- **Updated**: ${formatDateTime(session.time.updated ?? null)}`, `- **Outcome**: ${session.outcome ?? "—"}`, `- **Source**: ${analysis.capabilities.source} (${analysis.coverage.complete ? "full session" : "window"})`, `- **Generated**: ${formatDateTime(analysis.generatedAt)}`, "");
	lines.push(`## Summary (${analysis.totals.scope === "session" ? "Session total" : "Window total"})`);
	lines.push("");
	lines.push(mdTable([
		"Metric",
		"Value",
		"Basis"
	], [
		[
			"Turns",
			formatNumber(analysis.totals.turns),
			"measured"
		],
		[
			"Steps",
			formatNumber(analysis.totals.steps),
			"measured"
		],
		[
			"Tool calls",
			formatNumber(analysis.totals.toolCalls),
			"measured"
		],
		[
			"Subagent calls",
			formatNumber(analysis.totals.subagentCalls),
			"derived"
		],
		[
			"Input tokens",
			formatNumber(analysis.totals.tokens.input),
			"derived sum"
		],
		[
			"Output tokens",
			formatNumber(analysis.totals.tokens.output),
			"derived sum"
		],
		[
			"Reasoning tokens",
			formatNumber(analysis.totals.tokens.reasoning),
			"derived sum"
		],
		[
			"Cache read",
			formatNumber(analysis.totals.tokens.cacheRead),
			"derived sum"
		],
		[
			"Cache write",
			formatNumber(analysis.totals.tokens.cacheWrite),
			"derived sum"
		],
		[
			"Cache hit rate",
			metricMd(analysis.totals.cacheHitRate, formatPercent),
			"derived"
		],
		[
			"Cost",
			metricMd(analysis.totals.cost, formatCost),
			"derived"
		],
		[
			"Model time",
			metricMd(analysis.totals.modelTime, formatDuration),
			"derived"
		],
		[
			"Tool time",
			metricMd(analysis.totals.toolTime, formatDuration),
			"derived"
		],
		[
			"Active turn time",
			metricMd(analysis.totals.activeTurnTime, formatDuration),
			"derived"
		],
		[
			"Wall clock",
			metricMd(analysis.totals.wallClockTime, formatDuration),
			"derived"
		],
		[
			"Output speed",
			`${metricMd(analysis.totals.outputSpeed, (v) => `${v?.toFixed(1) ?? "—"} tok/s`)}`,
			"derived"
		],
		[
			"Errors",
			formatNumber(analysis.totals.errors.total),
			"measured counts"
		],
		[
			"Retries",
			formatNumber(analysis.totals.retries),
			"measured"
		],
		[
			"Compactions",
			formatNumber(analysis.totals.compactions),
			"measured"
		],
		[
			"Final context",
			metricMd(analysis.totals.finalContext, formatNumber),
			"derived"
		],
		[
			"Cumulative prompt",
			metricMd(analysis.totals.cumulativePrompt, formatNumber),
			"derived"
		]
	]));
	lines.push("");
	if (analysis.totals.recorded) {
		lines.push("### Totals recorded by OpenCode");
		lines.push("");
		if (analysis.totals.recorded.tokens) {
			const t = analysis.totals.recorded.tokens;
			lines.push(`- Tokens: input ${formatNumber(t.input)}, output ${formatNumber(t.output)}, reasoning ${formatNumber(t.reasoning)}, cache read ${formatNumber(t.cacheRead)}, cache write ${formatNumber(t.cacheWrite)}`);
		}
		if (analysis.totals.recorded.cost !== void 0) lines.push(`- Cost: ${formatCost(analysis.totals.recorded.cost)}`);
		lines.push(`- ${analysis.totals.recorded.note}`);
		lines.push("");
	}
	lines.push("## Turns");
	lines.push("");
	lines.push(mdTable([
		"#",
		"Trigger",
		"Start",
		"Duration",
		"Model",
		"Steps",
		"In",
		"Out",
		"Reason",
		"Cache R/W",
		"Hit",
		"Context (latest)",
		"Context (cum.)",
		"Δ context",
		"Model time",
		"Tool time",
		"Residual",
		"Out/s",
		"Cost",
		"Status"
	], analysis.turns.map((turn) => [
		String(turn.index),
		triggerLabel(turn),
		formatTime(turn.startTime),
		metricMd(turn.totalTime, formatDuration),
		turnModel(turn),
		String(turn.steps.length),
		formatNumber(turn.tokens.input),
		formatNumber(turn.tokens.output),
		formatNumber(turn.tokens.reasoning),
		`${formatNumber(turn.tokens.cacheRead)} / ${formatNumber(turn.tokens.cacheWrite)}`,
		metricMd(turn.cacheHitRate, formatPercent),
		metricMd(turn.promptTokensLatest, formatNumber),
		metricMd(turn.promptTokensCumulative, formatNumber),
		metricMd(turn.contextDelta, (v) => v === null ? "—" : `${v >= 0 ? "+" : ""}${formatNumber(v)}`),
		metricMd(turn.modelTime, formatDuration),
		metricMd(turn.toolTime, formatDuration),
		metricMd(turn.residualTime, formatDuration),
		metricMd(turn.outputSpeed, (v) => `${v?.toFixed(1) ?? "—"} tok/s`),
		metricMd(turn.cost, formatCost),
		`${turn.status}${turn.uncertainty.length > 0 ? " !" : ""}`
	])));
	lines.push("");
	lines.push("## Steps");
	lines.push("");
	const stepRows = [];
	for (const turn of analysis.turns) for (const step of turn.steps) stepRows.push([
		`${turn.index}.${step.index}`,
		formatTime(step.startTime),
		step.agent ?? "—",
		modelLabel(step.model),
		step.finish ?? "—",
		metricMd(step.promptTokens, formatNumber),
		formatNumber(step.tokens?.input ?? 0),
		formatNumber(step.tokens?.output ?? 0),
		formatNumber(step.tokens?.reasoning ?? 0),
		`${formatNumber(step.tokens?.cacheRead ?? 0)} / ${formatNumber(step.tokens?.cacheWrite ?? 0)}`,
		metricMd(step.cacheHitRate, formatPercent),
		"—",
		metricMd(step.modelTime, formatDuration),
		metricMd(step.toolTime, formatDuration),
		metricMd(step.totalTime, formatDuration),
		metricMd(step.residualTime, formatDuration),
		metricMd(step.outputSpeed, (v) => `${v?.toFixed(1) ?? "—"} tok/s`),
		step.toolNames.join(", ") || "—",
		step.subagentSessionIDs.join(", ") || "—",
		`${step.status}${step.uncertainty.length > 0 ? " !" : ""}`
	]);
	lines.push(mdTable([
		"Turn.Step",
		"Start",
		"Agent",
		"Model",
		"Finish",
		"Prompt",
		"In",
		"Out",
		"Reason",
		"Cache R/W",
		"Hit",
		"TTFT",
		"Model time",
		"Tool time",
		"Total",
		"Residual",
		"Out/s",
		"Tools",
		"Subagents",
		"Status"
	], stepRows));
	lines.push("");
	lines.push("TTFT is shown as `—` because OpenCode 2 does not persist a first-token timestamp.");
	lines.push("");
	if (analysis.compactions.length > 0) {
		lines.push("## Compactions");
		lines.push("");
		lines.push(mdTable([
			"Time",
			"Status",
			"Reason",
			"Model",
			"Before",
			"After",
			"Δ",
			"Removed",
			"Summary chars",
			"Output tokens",
			"Cost",
			"Duration"
		], analysis.compactions.map((item) => [
			formatDateTime(item.timestamp),
			item.status,
			item.reason ?? "—",
			modelLabel(item.model),
			metricMd(item.contextBefore, formatNumber),
			metricMd(item.contextAfter, formatNumber),
			metricMd(item.contextDelta, (v) => v === null ? "—" : `${v >= 0 ? "+" : ""}${formatNumber(v)}`),
			metricMd(item.removedTokens, formatNumber),
			formatNumber(item.summaryChars),
			formatNumber(item.tokens?.output ?? null),
			formatCost(item.cost),
			"— (only completion time persisted)"
		])));
		lines.push("");
	}
	lines.push("## Trajectory");
	lines.push("");
	const byTurn = /* @__PURE__ */ new Map();
	for (const event of analysis.events) {
		const list = byTurn.get(event.turnID) ?? [];
		list.push(event);
		byTurn.set(event.turnID, list);
	}
	const turnIndex = new Map(analysis.turns.map((turn) => [turn.id, turn.index]));
	const groups = [...byTurn.entries()].sort((a, b) => {
		if (a[0] === null) return 1;
		if (b[0] === null) return -1;
		return (turnIndex.get(a[0]) ?? 0) - (turnIndex.get(b[0]) ?? 0);
	});
	for (const [turnID, events] of groups) {
		const label = turnID === null ? "Unattached events" : `Turn ${turnIndex.get(turnID) ?? "?"} — ${analysis.turns.find((turn) => turn.id === turnID)?.trigger.label ?? ""}`;
		lines.push(`### ${escapeMarkdownInline(label)}`);
		lines.push("");
		for (const event of events) {
			const badges = eventBadgeText(event);
			const model = event.model ? modelLabel(event.model) : "";
			const tool = event.toolName ? ` tool=${escapeMarkdownInline(event.toolName)}(${escapeMarkdownInline(event.toolStatus ?? "?")})` : "";
			const previewText = event.preview.length > 0 ? ` — ${escapeMarkdownInline(event.preview.slice(0, 200))}` : "";
			lines.push(`- \`${formatTime(event.timestamp)}\` **${event.kind}** ${escapeMarkdownInline(event.title)}${tool}${model ? `; ${escapeMarkdownInline(model)}` : ""}${event.status ? `; ${escapeMarkdownInline(event.status)}` : ""}${badges ? `; [${badges}]` : ""}${previewText}`);
		}
		lines.push("");
	}
	lines.push("## Limitations and metric basis");
	lines.push("");
	lines.push("- **M** = measured (recorded by OpenCode), **D** = derived (computed from recorded values), **E** = estimated (fallback with an explicit assumption), **—** = unavailable.");
	lines.push(`- Prompt tokens = input + cache read + cache write. ${analysis.capabilities.promptTokenBreakdown}`);
	lines.push("- Model time is `time.created → time.streamed` (provider generation, before tool settlement). Step total is `created → completed`. Tool time is the sum of recorded tool durations; parallel calls can exceed wall-clock.");
	lines.push("- TTFT, permission/approval decisions, request headers, and tool-set changes are not persisted in OpenCode 2.2.x session data.");
	for (const note of analysis.capabilities.notes) lines.push(`- ${note}`);
	lines.push("");
	lines.push(`Generated by ${GENERATOR}.`);
	return lines.join("\n");
}
function htmlBadge(label, kind = "neutral") {
	return `<span class="badge badge-${kind}">${escapeHtml(label)}</span>`;
}
function htmlMetric(metric, formatter) {
	if (metric.value === null) return `<span class="metric unavailable" title="${escapeHtml(metric.note ?? "unavailable")}">—</span>`;
	const value = escapeHtml(formatter(metric.value));
	if (metric.basis === "measured") return `<span class="metric">${value}</span>`;
	return `<span class="metric metric-${metric.basis}" title="${escapeHtml(`${metric.basis}${metric.note ? `: ${metric.note}` : ""}`)}">${value}<sup>${basisMark(metric.basis)}</sup></span>`;
}
function htmlEventBadges(event) {
	const badges = [];
	if (event.flags.error) badges.push(htmlBadge("error", "error"));
	if (event.flags.retry) badges.push(htmlBadge("retry", "retry"));
	if (event.flags.compaction) badges.push(htmlBadge("compaction", "compaction"));
	if (event.flags.context) badges.push(htmlBadge("context", "context"));
	if (event.flags.subagent) badges.push(htmlBadge("subagent", "subagent"));
	if (event.uncertainty.length > 0) badges.push(`<span class="badge badge-uncertain" title="${escapeHtml(event.uncertainty.join(", "))}">uncertain</span>`);
	return badges.join(" ");
}
function stepRowsHtml(turn) {
	return turn.steps.map((step) => `<tr>
        <td class="mono">${turn.index}.${step.index}</td>
        <td class="mono">${escapeHtml(formatTime(step.startTime))}</td>
        <td>${escapeHtml(step.agent ?? "—")}</td>
        <td class="mono">${escapeHtml(modelLabel(step.model))}</td>
        <td>${htmlMetric(step.promptTokens, formatNumber)}</td>
        <td class="mono">${formatNumber(step.tokens?.input ?? null)}</td>
        <td class="mono">${formatNumber(step.tokens?.output ?? null)}</td>
        <td class="mono">${formatNumber(step.tokens?.reasoning ?? null)}</td>
        <td class="mono">${formatNumber(step.tokens?.cacheRead ?? null)} / ${formatNumber(step.tokens?.cacheWrite ?? null)}</td>
        <td>${htmlMetric(step.cacheHitRate, formatPercent)}</td>
        <td>${htmlMetric(step.modelTime, formatDuration)}</td>
        <td>${htmlMetric(step.toolTime, formatDuration)}</td>
        <td>${htmlMetric(step.totalTime, formatDuration)}</td>
        <td>${htmlMetric(step.outputSpeed, (value) => `${value?.toFixed(1) ?? "—"} tok/s`)}</td>
        <td>${escapeHtml(step.toolNames.join(", ") || "—")}</td>
        <td>${escapeHtml(step.status)}</td>
      </tr>`).join("");
}
function eventPayloadHtml(event) {
	if (!event || event.payload === null || event.payload === void 0) return "";
	const json = safeStringify(event.payload, 2);
	return `<details class="payload"><summary>Payload</summary><div class="payload-actions"><button type="button" data-copy>Copy JSON</button></div><pre>${escapeHtml(json.length > 6e4 ? `${json.slice(0, 6e4)}\n… (truncated in HTML export)` : json)}</pre></details>`;
}
function exportHtml(input) {
	const { session, analysis, redacted } = input;
	const title = session.title ?? session.slug ?? session.id;
	const eventById = input.includeEvents ? new Map(input.events.map((event) => [event.id, event])) : /* @__PURE__ */ new Map();
	const totals = analysis.totals;
	const stat = (label, value, sub = "") => `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ""}</div>`;
	const turnRows = analysis.turns.map((turn) => `<tr>
        <td class="mono">${turn.index}</td>
        <td>${escapeHtml(turn.trigger.label)}</td>
        <td class="mono">${escapeHtml(formatTime(turn.startTime))}</td>
        <td>${htmlMetric(turn.totalTime, formatDuration)}</td>
        <td class="mono">${escapeHtml(turnModel(turn))}</td>
        <td class="mono">${turn.steps.length}</td>
        <td class="mono">${formatNumber(turn.tokens.input)}</td>
        <td class="mono">${formatNumber(turn.tokens.output)}</td>
        <td class="mono">${formatNumber(turn.tokens.cacheRead)} / ${formatNumber(turn.tokens.cacheWrite)}</td>
        <td>${htmlMetric(turn.cacheHitRate, formatPercent)}</td>
        <td>${htmlMetric(turn.promptTokensLatest, formatNumber)}</td>
        <td>${htmlMetric(turn.promptTokensCumulative, formatNumber)}</td>
        <td>${htmlMetric(turn.contextDelta, (value) => value === null ? "—" : `${value >= 0 ? "+" : ""}${formatNumber(value)}`)}</td>
        <td>${htmlMetric(turn.modelTime, formatDuration)}</td>
        <td>${htmlMetric(turn.toolTime, formatDuration)}</td>
        <td>${htmlMetric(turn.residualTime, formatDuration)}</td>
        <td>${htmlMetric(turn.outputSpeed, (value) => `${value?.toFixed(1) ?? "—"} tok/s`)}</td>
        <td>${htmlMetric(turn.cost, formatCost)}</td>
        <td><span class="status status-${escapeHtml(turn.status)}">${escapeHtml(turn.status)}</span>${turn.uncertainty.length ? ` ${htmlBadge("uncertain", "uncertain")}` : ""}</td>
      </tr>`).join("");
	const turnSections = analysis.turns.map((turn) => `<details class="turn">
        <summary><span class="mono">Turn ${turn.index}</span> · ${escapeHtml(turn.trigger.label)} · ${turn.steps.length} step(s) · ${htmlMetric(turn.totalTime, formatDuration)} · <span class="status status-${escapeHtml(turn.status)}">${escapeHtml(turn.status)}</span></summary>
        <table class="steps"><thead><tr>
          <th>Step</th><th>Start</th><th>Agent</th><th>Model</th><th>Prompt</th><th>In</th><th>Out</th><th>Reason</th><th>Cache R/W</th><th>Hit</th><th>Model time</th><th>Tool time</th><th>Total</th><th>Out/s</th><th>Tools</th><th>Status</th>
        </tr></thead><tbody>${stepRowsHtml(turn)}</tbody></table>
        ${turn.steps.filter((step) => step.responseText.length > 0 || step.reasoningText.length > 0).map((step) => `<details class="response"><summary>Turn ${turn.index}.${step.index} response</summary>${step.reasoningText ? `<h4>Reasoning</h4><pre class="text">${escapeHtml(step.reasoningText.slice(0, 3e4))}</pre>` : ""}${step.responseText ? `<h4>Response</h4><pre class="text">${escapeHtml(step.responseText.slice(0, 3e4))}</pre>` : ""}</details>`).join("")}
      </details>`).join("");
	const compactionRows = analysis.compactions.map((item) => `<tr>
        <td class="mono">${escapeHtml(formatDateTime(item.timestamp))}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${escapeHtml(item.reason ?? "—")}</td>
        <td class="mono">${escapeHtml(modelLabel(item.model))}</td>
        <td>${htmlMetric(item.contextBefore, formatNumber)}</td>
        <td>${htmlMetric(item.contextAfter, formatNumber)}</td>
        <td>${htmlMetric(item.contextDelta, (value) => value === null ? "—" : `${value >= 0 ? "+" : ""}${formatNumber(value)}`)}</td>
        <td>${htmlMetric(item.removedTokens, formatNumber)}</td>
        <td class="mono">${formatNumber(item.summaryChars)}</td>
        <td class="mono">${formatNumber(item.tokens?.output ?? null)}</td>
        <td>${formatCost(item.cost)}</td>
        <td class="muted">— only completion time persisted</td>
      </tr>`).join("");
	const byTurn = /* @__PURE__ */ new Map();
	for (const event of analysis.events) {
		const list = byTurn.get(event.turnID) ?? [];
		list.push(event);
		byTurn.set(event.turnID, list);
	}
	const turnIndex = new Map(analysis.turns.map((turn) => [turn.id, turn.index]));
	const trajectory = [...byTurn.entries()].sort((a, b) => {
		if (a[0] === null) return 1;
		if (b[0] === null) return -1;
		return (turnIndex.get(a[0]) ?? 0) - (turnIndex.get(b[0]) ?? 0);
	}).map(([turnID, events]) => {
		const label = turnID === null ? "Unattached events" : `Turn ${turnIndex.get(turnID) ?? "?"} — ${analysis.turns.find((turn) => turn.id === turnID)?.trigger.label ?? ""}`;
		const rows = events.map((event) => {
			const full = eventById.get(event.id);
			return `<div class="event">
            <div class="event-meta">
              <span class="mono">${escapeHtml(formatTime(event.timestamp))}</span>
              ${htmlBadge(event.kind, event.kind === "error" ? "error" : event.kind === "tool" ? "tool" : "neutral")}
              ${htmlEventBadges(event)}
            </div>
            <div class="event-title">${escapeHtml(event.title)}</div>
            <div class="event-sub">
              ${event.agent ? `agent=${escapeHtml(event.agent)} ` : ""}
              ${event.model ? `model=${escapeHtml(modelLabel(event.model))} ` : ""}
              ${event.toolName ? `tool=${escapeHtml(event.toolName)}(${escapeHtml(event.toolStatus ?? "?")}) ` : ""}
              ${event.status ? `status=${escapeHtml(event.status)}` : ""}
            </div>
            ${event.preview ? `<div class="event-preview">${escapeHtml(event.preview)}</div>` : ""}
            ${eventPayloadHtml(full)}
          </div>`;
		}).join("");
		return `<section class="trajectory-group"><h3>${escapeHtml(label)}</h3>${rows}</section>`;
	}).join("");
	const limitations = [
		"M = measured, D = derived, E = estimated, — = unavailable.",
		"TTFT, permission/approval decisions, request headers and tool-set changes are not persisted in OpenCode 2.2.x session data.",
		"Prompt tokens = input + cache read + cache write.",
		"Model time is created → streamed (provider generation, before tool settlement). Step total is created → completed.",
		"Tool time is the sum of recorded tool durations; parallel calls can exceed wall-clock.",
		...analysis.capabilities.notes
	];
	return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — OpenCode session report</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --surface-2: #f3f3f0;
  --text: #0b0b0b;
  --text-2: #52514e;
  --muted: #6b6a66;
  --border: rgba(11,11,11,0.10);
  --grid: #e1e0d9;
  --accent: #1f6ac2;
  --good: #0a7f0a;
  --warning: #fab219;
  --serious: #ec835a;
  --critical: #c23535;
  --radius: 10px;
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --surface-2: #232322;
    --text: #f0efec;
    --text-2: #c3c2b7;
    --muted: #898781;
    --border: rgba(255,255,255,0.10);
    --grid: #2c2c2a;
    --accent: #3987e5;
    --good: #0ca30c;
    --critical: #ef6a6a;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface: #1a1a19;
  --surface-2: #232322;
  --text: #f0efec;
  --text-2: #c3c2b7;
  --muted: #898781;
  --border: rgba(255,255,255,0.10);
  --grid: #2c2c2a;
  --accent: #3987e5;
  --good: #0ca30c;
  --critical: #ef6a6a;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--text); font: 14px/1.5 var(--sans); }
a { color: var(--accent); }
header { padding: 24px clamp(16px, 4vw, 48px) 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
h1 { margin: 0 0 6px; font-size: clamp(20px, 3vw, 28px); line-height: 1.2; }
h2 { margin: 32px 0 12px; font-size: 18px; }
h3 { margin: 20px 0 8px; font-size: 15px; color: var(--text-2); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--text-2); font-size: 13px; }
.meta code { color: var(--text); }
main { padding: 20px clamp(16px, 4vw, 48px) 64px; max-width: 1500px; margin: 0 auto; }
.warning { border: 1px solid var(--warning); background: color-mix(in srgb, var(--warning) 12%, var(--surface)); border-radius: var(--radius); padding: 10px 14px; margin: 16px 0; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 18px 0 8px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.stat-label { color: var(--muted); font-size: 11px; }
.stat-value { font-size: 22px; font-weight: 650; margin-top: 4px; }
.stat-sub { color: var(--text-2); font-size: 12px; margin-top: 2px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 4px 0; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th { position: sticky; top: 0; background: var(--surface-2); color: var(--text-2); font-weight: 600; font-size: 11px; }
tr:last-child td { border-bottom: 0; }
.mono, .metric { font-variant-numeric: tabular-nums; }
.metric sup { font-size: 10px; color: var(--muted); margin-left: 1px; }
.metric-estimated { color: var(--text-2); }
.unavailable { color: var(--muted); }
.muted { color: var(--muted); }
.badge { display: inline-block; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); font-size: 11px; line-height: 1.5; color: var(--text-2); background: var(--surface-2); }
.badge-error { border-color: color-mix(in srgb, var(--critical) 55%, transparent); color: var(--critical); background: color-mix(in srgb, var(--critical) 9%, var(--surface)); }
.badge-retry, .badge-compaction, .badge-context { border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--surface)); }
.badge-subagent { border-color: color-mix(in srgb, var(--good) 45%, transparent); color: var(--good); background: color-mix(in srgb, var(--good) 8%, var(--surface)); }
.badge-uncertain { border-style: dashed; }
.status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.status-completed { color: var(--good); }
.status-error, .status-interrupted { color: var(--critical); }
.status-incomplete, .status-unknown, .status-running { color: var(--text-2); }
details.turn { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin: 8px 0; padding: 8px 12px; }
details.turn > summary { cursor: pointer; color: var(--text-2); font-size: 13px; }
details.turn > summary .mono { color: var(--text); }
details.response { margin: 8px 0 4px; }
details.response > summary, details.payload > summary { cursor: pointer; color: var(--text-2); font-size: 12px; }
pre.text, pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; max-height: 480px; overflow: auto; font: 12px/1.5 var(--mono); }
.trajectory-group { margin: 18px 0; }
.event { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin: 6px 0; }
.event-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--muted); font-size: 11px; }
.event-title { margin-top: 2px; font-weight: 600; }
.event-sub { color: var(--text-2); font-size: 11.5px; }
.event-preview { color: var(--text-2); font-size: 12px; margin-top: 4px; }
.payload-actions { margin: 6px 0; }
button { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; cursor: pointer; }
button:hover { border-color: var(--accent); }
footer { color: var(--muted); font-size: 12px; border-top: 1px solid var(--border); margin-top: 40px; padding-top: 12px; }
@media (max-width: 640px) {
  .stats { grid-template-columns: repeat(2, 1fr); }
  th, td { padding: 6px 8px; }
}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">
    <span>Session <code>${escapeHtml(session.id)}</code></span>
    <span>Directory <code>${escapeHtml(session.directory ?? "—")}</code></span>
    <span>Agent <code>${escapeHtml(session.agent ?? "—")}</code></span>
    <span>Model <code>${escapeHtml(modelLabel(session.model))}</code></span>
    <span>Outcome <code>${escapeHtml(session.outcome ?? "—")}</code></span>
    <span>Source <code>${escapeHtml(analysis.capabilities.source)}</code></span>
    <span>Scope <code>${analysis.coverage.complete ? "session" : "window"}</code></span>
    <span>Generated ${escapeHtml(formatDateTime(analysis.generatedAt))}</span>
  </div>
</header>
<main>
${redacted ? `<div class="warning"><strong>Redacted export.</strong> Credential-shaped values were replaced with <code>[REDACTED]</code>. Re-export with <code>reveal</code> to include raw values.</div>` : ""}
<h2>${totals.scope === "session" ? "Session total" : "Window total"}</h2>
<div class="stats">
  ${stat("Turns", formatNumber(totals.turns), `${formatNumber(totals.steps)} steps`)}
  ${stat("Input tokens", formatNumber(totals.tokens.input), `output ${formatNumber(totals.tokens.output)}`)}
  ${stat("Reasoning tokens", formatNumber(totals.tokens.reasoning), `cache R ${formatNumber(totals.tokens.cacheRead)}`)}
  ${stat("Cache hit rate", htmlMetric(totals.cacheHitRate, formatPercent), `write ${formatNumber(totals.tokens.cacheWrite)}`)}
  ${stat("Cost", htmlMetric(totals.cost, formatCost), "steps + compactions")}
  ${stat("Model time", htmlMetric(totals.modelTime, formatDuration), "created → streamed")}
  ${stat("Tool time", htmlMetric(totals.toolTime, formatDuration), "sum; may overlap")}
  ${stat("Active turn time", htmlMetric(totals.activeTurnTime, formatDuration), `wall ${formatMetricText(totals.wallClockTime, formatDuration)}`)}
  ${stat("Output speed", htmlMetric(totals.outputSpeed, (value) => `${value?.toFixed(1) ?? "—"} tok/s`), "output / model time")}
  ${stat("Errors", formatNumber(totals.errors.total), `${formatNumber(totals.retries)} retries · ${formatNumber(totals.compactions)} compactions`)}
  ${stat("Final context", htmlMetric(totals.finalContext, formatNumber), `cumulative ${formatMetricText(totals.cumulativePrompt, formatNumber)}`)}
  ${stat("Tool calls", formatNumber(totals.toolCalls), `${formatNumber(totals.subagentCalls)} subagent`)}
</div>

<h2>Turns</h2>
<div class="card">
<table>
<thead><tr><th>#</th><th>Trigger</th><th>Start</th><th>Duration</th><th>Model</th><th>Steps</th><th>In</th><th>Out</th><th>Cache R/W</th><th>Hit</th><th>Context latest</th><th>Context cum.</th><th>Δ context</th><th>Model time</th><th>Tool time</th><th>Residual</th><th>Out/s</th><th>Cost</th><th>Status</th></tr></thead>
<tbody>${turnRows}</tbody>
</table>
</div>

<h2>Turns and steps</h2>
${turnSections || `<p class="muted">No turns recorded.</p>`}

${analysis.compactions.length > 0 ? `<h2>Compactions</h2><div class="card"><table><thead><tr><th>Time</th><th>Status</th><th>Reason</th><th>Model</th><th>Before</th><th>After</th><th>Δ</th><th>Removed</th><th>Summary chars</th><th>Output tokens</th><th>Cost</th><th>Duration</th></tr></thead><tbody>${compactionRows}</tbody></table></div>` : ""}

<h2>Trajectory</h2>
${trajectory || `<p class="muted">No events recorded.</p>`}

<h2>Limitations and metric basis</h2>
<ul>${limitations.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
<footer>Generated by ${escapeHtml(GENERATOR)} · ${escapeHtml(formatDateTime(analysis.generatedAt))}</footer>
</main>
<script>
(() => {
  const theme = document.documentElement;
  const stored = (() => { try { return localStorage.getItem("observability-theme"); } catch { return null; } })();
  if (stored === "light" || stored === "dark") theme.dataset.theme = stored;
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const pre = button.closest("details")?.querySelector("pre");
      if (!pre) return;
      const text = pre.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
      } catch {
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try { document.execCommand("copy"); button.textContent = "Copied"; } catch {}
        area.remove();
      }
      setTimeout(() => { button.textContent = "Copy JSON"; }, 1200);
    });
  }
})();
<\/script>
</body>
</html>`;
}
function formatMetricText(metric, formatter) {
	return metric.value === null ? "—" : formatter(metric.value);
}
// src/core/episodes.ts
function toEpisode(incident, sessionID) {
	const failureEventIDs = [...incident.failureEventIDs];
	const [firstFailureID] = failureEventIDs;
	return {
		id: `${sessionID}:${incident.turnID}:${incident.tool}:${firstFailureID}`,
		sessionID,
		turnID: incident.turnID,
		turnIndex: incident.turn,
		tool: incident.tool,
		attemptCount: incident.attempts,
		recovery: incident.recovery,
		similarity: incident.similarity,
		failureEventIDs,
		recoveryEventID: incident.recoveryEventID
	};
}
/**
* Lists one episode per diagnostic incident, in recorded order.
*
* `sessionID` is the session the diagnostics were evaluated for (normally
* `analysis.session.id`). It is part of every episode id, so callers must pass
* the same session that produced the incidents. Returns an empty array when
* nothing failed.
*/
function listDiagnosticEpisodes(diagnostics, sessionID) {
	return diagnostics.incidents.map((incident) => toEpisode(incident, sessionID));
}
// src/core/episodeCompare.ts
/**
* Ordinal, descriptive comparison of two recorded diagnostic episodes.
*
* The layer is pure and server-agnostic: it never reads events, storage, HTTP
* or the DOM, and it never ranks the two sides. Attempts are aligned by
* recorded position only (1<->1, 2<->2, ...); a differing attempt count yields
* trailing one-sided rows instead of a fuzzy match. Every difference is
* `left - right` and carries the epistemic basis of its inputs.
*
* DTO neutrality: no field in these comparison shapes names a winner, an
* optimum, a recommendation, a verdict or a "better" side. The only
* judgement-like value (`inputSimilarity`) is copied verbatim from the purely
* descriptive diagnostics layer. A recursive key-scan test enforces the
* absence of ranking fields in every DTO object.
*/
function describeEpisode(episode) {
	return {
		id: episode.id,
		sessionID: episode.sessionID,
		turnID: episode.turnID,
		turnIndex: episode.turnIndex,
		tool: episode.tool,
		attemptCount: episode.attemptCount,
		recovery: episode.recovery,
		similarity: episode.similarity,
		recoveryEventID: episode.recoveryEventID
	};
}
function copyAttempt(attempt) {
	return {
		eventID: attempt.eventID,
		tool: attempt.tool,
		status: attempt.status,
		input: attempt.input,
		duration: { ...attempt.duration }
	};
}
function copyTotals(totals) {
	return {
		tokens: { ...totals.tokens },
		tokensComplete: totals.tokensComplete,
		cost: { ...totals.cost },
		modelTime: { ...totals.modelTime },
		toolTime: { ...totals.toolTime },
		totalTime: { ...totals.totalTime },
		outputSpeed: { ...totals.outputSpeed },
		cacheHitRate: { ...totals.cacheHitRate }
	};
}
function copyTurn(turn) {
	return {
		...copyTotals(turn),
		index: turn.index,
		promptTokensLatest: { ...turn.promptTokensLatest }
	};
}
/**
* `left - right` for two already-computed metrics. A delta is `derived` only
* when both sides are; an estimated or unavailable component makes the delta
* unavailable rather than presenting an inferred magnitude as measured. The
* same policy governs the attempt duration deltas below.
*/
function differenceMetric(left, right, label) {
	if (left.value === null || right.value === null) return metric(null, "unavailable", `${label} is unavailable on one side`);
	if (left.basis === "estimated" || right.basis === "estimated") return metric(null, "unavailable", `${label} is estimated on one side`);
	if (left.basis === "unavailable" || right.basis === "unavailable") return metric(null, "unavailable", `${label} is unavailable on one side`);
	return metric(left.value - right.value, "derived", `${label} left − right`);
}
/** `left - right` for one `TokenUsage` field, gated by completeness. */
function tokenDifference(field, label, left, right) {
	if (!left.tokensComplete || !right.tokensComplete) return metric(null, "unavailable", `${label} tokens are incomplete on one side`);
	return metric(left.tokens[field] - right.tokens[field], "derived", `${label} tokens left − right`);
}
function latencyDelta(left, right) {
	if (left === null) return metric(null, "unavailable", "left attempt is missing");
	if (right === null) return metric(null, "unavailable", "right attempt is missing");
	if (left.duration.value === null || right.duration.value === null) return metric(null, "unavailable", "left − right duration is unavailable");
	if (left.duration.basis === "estimated" || right.duration.basis === "estimated") return metric(null, "unavailable", "left − right duration is estimated on one side");
	return metric(left.duration.value - right.duration.value, "derived", "left − right");
}
/**
* Compares one aligned pair of inputs. Absent, truncated and redacted inputs
* are terminal: similarity is `"not-comparable"` and no overlap is guessed.
*/
function comparePairInputs(left, right) {
	const leftState = left === null ? "absent" : classifyInput(left.input);
	const rightState = right === null ? "absent" : classifyInput(right.input);
	const comparability = {
		left: leftState,
		right: rightState
	};
	if (left === null || right === null) return {
		comparability,
		similarity: "not-comparable",
		overlap: null
	};
	if (leftState !== "comparable" || rightState !== "comparable") return {
		comparability,
		similarity: "not-comparable",
		overlap: null
	};
	const comparison = compareInputs(left.input, right.input);
	return {
		comparability,
		similarity: comparison.verdict,
		overlap: comparison.overlap
	};
}
function buildRow(index, kind, left, right, notes) {
	const inputs = comparePairInputs(left, right);
	const label = kind === "recovery" ? "recovery call" : `attempt ${index}`;
	if (left !== null && right !== null && inputs.similarity === "not-comparable") notes.push(`${label} inputs are not comparable (left ${inputs.comparability.left}, right ${inputs.comparability.right})`);
	if (left !== null && right !== null && left.tool !== right.tool) notes.push(`${label} uses ${left.tool} on the left and ${right.tool} on the right`);
	return {
		index,
		kind,
		presence: left !== null && right !== null ? "both" : left !== null ? "left-only" : "right-only",
		left: left === null ? null : copyAttempt(left),
		right: right === null ? null : copyAttempt(right),
		latencyDelta: latencyDelta(left, right),
		inputComparability: inputs.comparability,
		inputSimilarity: inputs.similarity,
		inputOverlap: inputs.overlap
	};
}
function dataNotes(side, input, notes) {
	if (input.redacted === true) notes.push(`${side} inputs are redacted`);
	if (input.attempts.length !== input.episode.attemptCount) notes.push(`${side} episode records ${input.episode.attemptCount} attempt(s) but ${input.attempts.length} attempt(s) were supplied`);
	if (input.episode.recoveryEventID !== null && input.recovery === null) notes.push(`${side} episode records a recovery event without a supplied recovery attempt`);
	if (input.recovery !== null && input.episode.recoveryEventID === null) notes.push(`${side} recovery attempt was supplied but the episode records no recovery event`);
}
function alignAttempts(left, right, notes) {
	const leftAttempts = [...left.attempts];
	const rightAttempts = [...right.attempts];
	const paired = Math.min(leftAttempts.length, rightAttempts.length);
	const rows = [];
	for (let position = 0; position < paired; position += 1) rows.push(buildRow(rows.length + 1, "attempt", leftAttempts[position], rightAttempts[position], notes));
	for (let position = paired; position < leftAttempts.length; position += 1) rows.push(buildRow(rows.length + 1, "attempt", leftAttempts[position], null, notes));
	for (let position = paired; position < rightAttempts.length; position += 1) rows.push(buildRow(rows.length + 1, "attempt", null, rightAttempts[position], notes));
	const leftRecovery = left.episode.recoveryEventID !== null ? left.recovery : null;
	const rightRecovery = right.episode.recoveryEventID !== null ? right.recovery : null;
	if (leftRecovery !== null || rightRecovery !== null) {
		if (leftRecovery !== null && rightRecovery === null) notes.push("recovery call only in left");
		else if (rightRecovery !== null && leftRecovery === null) notes.push("recovery call only in right");
		rows.push(buildRow(rows.length + 1, "recovery", leftRecovery, rightRecovery, notes));
	}
	return rows;
}
function totalsDelta(left, right) {
	return {
		tokens: {
			input: tokenDifference("input", "input", left, right),
			output: tokenDifference("output", "output", left, right),
			reasoning: tokenDifference("reasoning", "reasoning", left, right),
			cacheRead: tokenDifference("cacheRead", "cache read", left, right),
			cacheWrite: tokenDifference("cacheWrite", "cache write", left, right)
		},
		cost: differenceMetric(left.cost, right.cost, "cost"),
		modelTime: differenceMetric(left.modelTime, right.modelTime, "model time"),
		toolTime: differenceMetric(left.toolTime, right.toolTime, "tool time"),
		totalTime: differenceMetric(left.totalTime, right.totalTime, "total time"),
		outputSpeed: differenceMetric(left.outputSpeed, right.outputSpeed, "output speed"),
		cacheHitRate: differenceMetric(left.cacheHitRate, right.cacheHitRate, "cache hit rate")
	};
}
function turnDelta(left, right) {
	return {
		...totalsDelta(left, right),
		promptTokensLatest: differenceMetric(left.promptTokensLatest, right.promptTokensLatest, "turn prompt tokens")
	};
}
/**
* Compares two episodes by recorded ordinal.
*
* Pure and deterministic: repeated calls with equal inputs return deep-equal
* results, no input is mutated, and the returned arrays are fresh. No attempt
* is ever matched by input shape, so a count mismatch stays visible as
* trailing one-sided rows plus a note.
*/
function compareEpisodeData(leftInput, rightInput) {
	const notes = [];
	dataNotes("left", leftInput, notes);
	dataNotes("right", rightInput, notes);
	if (leftInput.episode.tool !== rightInput.episode.tool) notes.push(`left episode tool is ${leftInput.episode.tool} and right episode tool is ${rightInput.episode.tool}`);
	const leftCount = leftInput.attempts.length;
	const rightCount = rightInput.attempts.length;
	if (leftCount > rightCount) notes.push(`${leftCount - rightCount} attempt(s) only in left`);
	else if (rightCount > leftCount) notes.push(`${rightCount - leftCount} attempt(s) only in right`);
	const alignment = alignAttempts(leftInput, rightInput, notes);
	return {
		schemaVersion: 1,
		redacted: leftInput.redacted === true || rightInput.redacted === true,
		left: describeEpisode(leftInput.episode),
		right: describeEpisode(rightInput.episode),
		alignment,
		totals: {
			left: copyTotals(leftInput.totals),
			right: copyTotals(rightInput.totals),
			delta: totalsDelta(leftInput.totals, rightInput.totals)
		},
		turn: {
			left: copyTurn(leftInput.turn),
			right: copyTurn(rightInput.turn),
			delta: turnDelta(leftInput.turn, rightInput.turn)
		},
		notes
	};
}
// src/core/service.ts
var SessionNotFoundError = class extends Error {
	constructor(sessionID) {
		super(`Session not found: ${sessionID}`);
		this.name = "SessionNotFoundError";
	}
};
var EventNotFoundError = class extends Error {
	constructor(eventID) {
		super(`Event not found: ${eventID}`);
		this.name = "EventNotFoundError";
	}
};
var EpisodeNotFoundError = class extends Error {
	constructor(episodeID) {
		super(`Episode not found: ${episodeID}`);
		this.name = "EpisodeNotFoundError";
	}
};
var CACHE_TTL_MS = 4e3;
var MAX_CACHE_ENTRIES = 8;
/**
* Projection service shared by the HTTP server and the OpenCode 2 plugin RPC.
* It is read-only: the source interface has no mutation methods.
*/
var ObservabilityService = class {
	source;
	cache = /* @__PURE__ */ new Map();
	redactedEvents = /* @__PURE__ */ new WeakMap();
	searchCorpora = /* @__PURE__ */ new WeakMap();
	constructor(source) {
		this.source = source;
	}
	describe() {
		return {
			source: this.source.kind,
			cacheEntries: this.cache.size
		};
	}
	async listSessions(options = {}) {
		const limit = Math.max(1, Math.min(1e3, options.limit ?? 200));
		const query = options.query?.trim();
		if (options.reveal) return this.source.listSessions({
			query,
			limit
		});
		if (!query) return redactValue(await this.source.listSessions({ limit }));
		const visible = redactValue(await this.source.listSessions({ limit: 1e3 }));
		const needle = query.toLowerCase();
		return visible.filter((session) => [
			session.id,
			session.slug,
			session.title,
			session.directory,
			session.projectID,
			session.agent
		].filter((value) => typeof value === "string").some((value) => value.toLowerCase().includes(needle))).slice(0, limit);
	}
	async getSession(sessionID, options = {}) {
		const session = await this.source.getSession(sessionID);
		if (!session) throw new SessionNotFoundError(sessionID);
		const family = await this.source.getFamily(sessionID);
		if (options.reveal) return {
			session,
			family
		};
		return redactValue({
			session,
			family
		});
	}
	async loadDataset(sessionID, options = {}) {
		const session = await this.source.getSession(sessionID);
		if (!session) throw new SessionNotFoundError(sessionID);
		const sessionUpdated = session.time.updated ?? 0;
		const requestKey = [
			sessionUpdated,
			options.fromSeq ?? "",
			options.toSeq ?? "",
			options.windowed ? "window" : "full"
		].join(":");
		const warm = this.cache.get(sessionID);
		if (warm && warm.requestKey === requestKey && Date.now() - warm.at < CACHE_TTL_MS) {
			this.touchCache(sessionID, warm);
			return warm.dataset;
		}
		const bounds = await this.source.messageBounds(sessionID);
		const fromSeq = options.fromSeq ?? bounds.minSeq;
		const toSeq = options.toSeq ?? bounds.maxSeq;
		const key = [
			sessionUpdated,
			bounds.count,
			fromSeq,
			toSeq,
			options.windowed ? "window" : "full"
		].join(":");
		const cached = this.cache.get(sessionID);
		if (cached && cached.key === key && Date.now() - cached.at < CACHE_TTL_MS) {
			this.touchCache(sessionID, cached);
			return cached.dataset;
		}
		const [family, messages] = await Promise.all([this.source.getFamily(sessionID), this.source.listMessages(sessionID, {
			fromSeq,
			toSeq
		})]);
		const coverage = {
			fromSeq,
			toSeq,
			minSeq: bounds.minSeq,
			maxSeq: bounds.maxSeq,
			complete: fromSeq <= bounds.minSeq && toSeq >= bounds.maxSeq,
			messages: bounds.count,
			windowMessages: messages.length
		};
		const events = normalizeMessages(messages, { session });
		const analysis = projectSession(events, {
			session,
			family,
			coverage,
			sourceKind: this.source.kind,
			windowed: options.windowed === true
		});
		const turnByEvent = new Map(analysis.events.map((event) => [event.id, event.turnID]));
		const assignedEvents = events.map((event) => ({
			...event,
			turnID: turnByEvent.get(event.id) ?? event.turnID
		}));
		const diagnostics = evaluateDiagnostics(assignedEvents, analysis);
		if (diagnostics.incidents.length > 0) analysis.diagnostics = diagnostics;
		analysis.health = evaluateSessionHealth(analysis);
		const attribution = evaluateAttribution(analysis);
		if (attribution !== null) analysis.attribution = attribution;
		const recommendations = evaluateRecommendations(analysis);
		if (recommendations !== null) analysis.recommendations = recommendations;
		const dataset = {
			session,
			family,
			coverage,
			events: assignedEvents,
			analysis
		};
		this.cache.delete(sessionID);
		this.cache.set(sessionID, {
			key,
			requestKey,
			at: Date.now(),
			sessionUpdated,
			dataset
		});
		this.evictCache();
		return dataset;
	}
	/** Marks a cache entry as recently used (the Map preserves insertion order). */
	touchCache(sessionID, entry) {
		this.cache.delete(sessionID);
		this.cache.set(sessionID, entry);
	}
	/** Drops expired entries and keeps the dataset cache within a small bound. */
	evictCache() {
		const now = Date.now();
		for (const [sessionID, entry] of this.cache) if (now - entry.at >= CACHE_TTL_MS) this.cache.delete(sessionID);
		while (this.cache.size > MAX_CACHE_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest === void 0) break;
			this.cache.delete(oldest);
		}
	}
	redactedFor(dataset) {
		const cached = this.redactedEvents.get(dataset);
		if (cached) return cached;
		const redacted = redactValue(dataset.events);
		this.redactedEvents.set(dataset, redacted);
		return redacted;
	}
	corporaFor(events) {
		const cached = this.searchCorpora.get(events);
		if (cached) return cached;
		const built = events.map((event) => eventSearchCorpus(event));
		this.searchCorpora.set(events, built);
		return built;
	}
	/** Diagnostics over the stream the caller is allowed to see. */
	diagnosticsFor(dataset, reveal) {
		return evaluateDiagnostics(reveal ? dataset.events : this.redactedFor(dataset), dataset.analysis);
	}
	/**
	* Synthetic full-range child for a dataset that could not be loaded. The
	* empty stream keeps the child counted (`totalChildren`) and classifies it
	* `insufficient-data` instead of silently dropping it; only the recorded
	* session summary is copied, never exception text.
	*/
	emptyChildInput(child, family) {
		const session = {
			id: child.id,
			parentID: child.parentID,
			title: child.title,
			directory: child.directory,
			agent: child.agent,
			model: child.model,
			cost: child.cost,
			tokens: child.tokens,
			outcome: child.outcome,
			time: {
				created: child.timeCreated,
				updated: child.timeUpdated
			}
		};
		const coverage = {
			fromSeq: 0,
			toSeq: 0,
			minSeq: 0,
			maxSeq: 0,
			complete: false,
			messages: 0,
			windowMessages: 0
		};
		const events = [];
		const analysis = projectSession(events, {
			session,
			family,
			coverage,
			sourceKind: this.source.kind
		});
		return {
			sessionID: child.id,
			events,
			analysis,
			diagnostics: evaluateDiagnostics(events, analysis)
		};
	}
	/**
	* Resolves one side of a comparison. The episode is re-derived from the same
	* event stream that supplies its attempts, so an unknown id always fails
	* instead of matching a stale incident.
	*/
	episodeSide(dataset, sessionID, episodeID, reveal) {
		const events = reveal ? dataset.events : this.redactedFor(dataset);
		const episode = listDiagnosticEpisodes(this.diagnosticsFor(dataset, reveal), sessionID).find((item) => item.id === episodeID);
		if (!episode) throw new EpisodeNotFoundError(episodeID);
		const byID = new Map(events.map((event) => [event.id, event]));
		const attempts = [];
		for (const eventID of episode.failureEventIDs) {
			const attempt = attemptFor(byID, eventID);
			if (!attempt) throw new EpisodeNotFoundError(episodeID);
			attempts.push(attempt);
		}
		const recovery = episode.recoveryEventID === null ? null : attemptFor(byID, episode.recoveryEventID);
		const turn = dataset.analysis.turns.find((item) => item.id === episode.turnID);
		if (!turn) throw new EpisodeNotFoundError(episodeID);
		return {
			episode,
			attempts,
			recovery,
			totals: totalsSubset(dataset.analysis.totals),
			turn: turnSubset(turn),
			redacted: !reveal
		};
	}
	async analyze(sessionID, options = {}) {
		const dataset = await this.loadDataset(sessionID, options);
		const reveal = options.reveal === true;
		return {
			analysis: presentAnalysis(dataset.analysis, !reveal),
			events: reveal ? dataset.events : this.redactedFor(dataset),
			redacted: !reveal
		};
	}
	/**
	* Compact live snapshot for an in-progress session.
	*
	* The dataset is loaded through the same requestKey-coherent cache as
	* `analyze`; this method never clears it. The derive step is pure, so the
	* live endpoint re-projects once per poll and re-shapes the result. Without
	* `reveal` the whole snapshot passes through the same redaction path as the
	* analysis payload.
	*/
	async liveSnapshot(sessionID, options = {}) {
		const snapshot = deriveLiveSnapshot((await this.loadDataset(sessionID)).analysis, {
			lastTurns: options.lastTurns,
			since: options.since
		});
		return options.reveal === true ? snapshot : redactValue(snapshot);
	}
	/**
	* Cross-session benchmark over a bounded, recency-sorted candidate set.
	*
	* Candidates come from `listSessions`, so they are redacted when `reveal` is
	* false: an in-memory filter can never turn a redacted value into a
	* match/no-match oracle. Summary-level filters run first, the survivors are
	* sorted by `timeUpdated` descending and capped at `MAX_BENCHMARK_SESSIONS`,
	* and only then is each dataset loaded through the shared requestKey-coherent
	* cache. The task-type filter runs last, because turn triggers only exist
	* after projection.
	*
	* Loading up to `MAX_BENCHMARK_SESSIONS` datasets evicts the cache working
	* set (the cache holds at most `MAX_CACHE_ENTRIES` projections); it does not
	* clear the cache — `clearCache` is never called here — and the event streams
	* are dropped as soon as the totals-level row is read.
	*/
	async benchmark(filters = {}, options = {}) {
		const reveal = options.reveal === true;
		const ordered = [...(await this.listSessions({
			limit: CANDIDATE_LISTING_LIMIT,
			reveal
		})).filter((summary) => matchesBenchmarkFilters(summary, filters))].sort((left, right) => (right.timeUpdated ?? right.timeCreated) - (left.timeUpdated ?? left.timeCreated) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
		const capped = ordered.slice(0, 50);
		const inputs = [];
		let skipped = 0;
		for (const summary of capped) {
			let dataset;
			try {
				dataset = await this.loadDataset(summary.id);
			} catch (error) {
				if (!(error instanceof SessionNotFoundError)) throw error;
				skipped += 1;
				continue;
			}
			const input = benchmarkInputFrom(summary, dataset.analysis);
			if (!matchesBenchmarkTaskType(input, filters.taskType)) continue;
			inputs.push(input);
		}
		const benchmark = computeBenchmark(inputs, {
			groupBy: filters.groupBy,
			sessionsCapped: ordered.length > capped.length,
			candidatesConsidered: ordered.length,
			candidatesLoaded: capped.length,
			skippedSessions: skipped
		});
		return reveal ? benchmark : redactValue(benchmark);
	}
	/**
	* Diagnostics plus the episodes derived from them.
	*
	* Without `reveal: true` the rule runs on the redacted event stream, so an
	* input that was credential-redacted classifies as `"redacted"` instead of
	* being silently reported as comparable. Episodes are a pure projection of
	* the same diagnostics; their ids are identical in both modes because event
	* ids are not payload data.
	*/
	async diagnostics(sessionID, options = {}) {
		const dataset = await this.loadDataset(sessionID);
		const reveal = options.reveal === true;
		const diagnostics = this.diagnosticsFor(dataset, reveal);
		return {
			diagnostics,
			episodes: listDiagnosticEpisodes(diagnostics, sessionID),
			redacted: !reveal
		};
	}
	/**
	* Delegation recovery across a root session and its direct children.
	*
	* Parent and child datasets are always loaded full-range: a windowed stream
	* could not claim a complete failure picture. Linkage is derived from the
	* recorded parent delegation tool events, never guessed. As in
	* `diagnostics`, the no-reveal mode evaluates the redacted event stream, so a
	* credential-bearing delegation input classifies as `"redacted"` instead of
	* comparable; the dataset cache stays raw, so flipping `reveal` on a warm
	* cache is still correct. A child that cannot be loaded is reported as an
	* empty synthetic child (`insufficient-data`) plus a sanitized note.
	*/
	async familyRecovery(sessionID, options = {}) {
		const reveal = options.reveal === true;
		const parentDataset = await this.loadDataset(sessionID);
		const children = [];
		const notes = [];
		for (const child of parentDataset.family.children) try {
			const dataset = await this.loadDataset(child.id);
			children.push({
				sessionID: child.id,
				events: reveal ? dataset.events : this.redactedFor(dataset),
				analysis: dataset.analysis,
				diagnostics: this.diagnosticsFor(dataset, reveal)
			});
		} catch (error) {
			if (!(error instanceof SessionNotFoundError)) throw error;
			notes.push(`child ${child.id}: child load unavailable`);
			children.push(this.emptyChildInput(child, parentDataset.family));
		}
		const recovery = evaluateDelegationRecovery({
			rootSessionID: sessionID,
			parentSessionID: sessionID,
			parentEvents: reveal ? parentDataset.events : this.redactedFor(parentDataset),
			parentAnalysis: parentDataset.analysis,
			parentDiagnostics: this.diagnosticsFor(parentDataset, reveal),
			children,
			reveal,
			seen: /* @__PURE__ */ new Set([sessionID])
		});
		if (notes.length === 0) return recovery;
		return {
			...recovery,
			notes: [...recovery.notes, ...notes]
		};
	}
	/**
	* Aligns two episodes by recorded ordinal, or throws when either id does not
	* name an episode of its session. Inputs come from the raw dataset under
	* reveal and from the redacted event stream otherwise; totals and turn
	* metrics are the structural numeric subsets of `Analysis`.
	*/
	async compareEpisodes(input) {
		const reveal = input.reveal === true;
		const datasets = /* @__PURE__ */ new Map();
		const load = async (sessionID) => {
			const warm = datasets.get(sessionID);
			if (warm) return warm;
			const dataset = await this.loadDataset(sessionID);
			datasets.set(sessionID, dataset);
			return dataset;
		};
		const leftDataset = await load(input.leftSessionID);
		const rightDataset = await load(input.rightSessionID);
		return compareEpisodeData(this.episodeSide(leftDataset, input.leftSessionID, input.leftEpisodeID, reveal), this.episodeSide(rightDataset, input.rightSessionID, input.rightEpisodeID, reveal));
	}
	async events(query) {
		const dataset = await this.loadDataset(query.sessionID, {
			reveal: query.reveal,
			windowed: false
		});
		const reveal = query.reveal === true;
		const sanitized = reveal ? dataset.events : this.redactedFor(dataset);
		const sorted = [...filterEvents(sanitized, query, query.q?.trim() ? this.corporaFor(sanitized) : null)].sort((a, b) => a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0);
		const limit = Math.max(1, Math.min(1e3, query.limit ?? 200));
		const direction = query.direction ?? "backward";
		let start;
		let end;
		const anchor = query.around ? sorted.findIndex((event) => event.id === query.around || event.orderKey === query.around) : -1;
		if (anchor >= 0) {
			start = Math.max(0, Math.min(sorted.length - limit, anchor - Math.floor(limit / 2)));
			end = Math.min(sorted.length, start + limit);
		} else if (direction === "forward") {
			start = query.after ? sorted.findIndex((event) => event.orderKey > query.after) : 0;
			if (start < 0) start = sorted.length;
			end = Math.min(sorted.length, start + limit);
		} else {
			end = query.before ? sorted.findIndex((event) => event.orderKey >= query.before) : sorted.length;
			if (end < 0) end = sorted.length;
			start = Math.max(0, end - limit);
		}
		const slice = sorted.slice(start, end).map(toListEvent);
		return {
			events: slice,
			page: {
				limit,
				returned: slice.length,
				totalMatched: sorted.length,
				totalInSession: dataset.events.length,
				hasMoreBefore: start > 0,
				hasMoreAfter: end < sorted.length,
				before: slice[0]?.orderKey ?? null,
				after: slice[slice.length - 1]?.orderKey ?? null,
				direction
			},
			coverage: dataset.coverage,
			capabilities: dataset.analysis.capabilities,
			redacted: !reveal
		};
	}
	async eventDetail(sessionID, eventID, options = {}) {
		const event = (await this.loadDataset(sessionID)).events.find((item) => item.id === eventID);
		if (!event) throw new EventNotFoundError(eventID);
		return options.reveal === true ? event : redactValue(event);
	}
	async export(sessionID, options) {
		const dataset = await this.loadDataset(sessionID);
		const reveal = options.reveal === true;
		const analysis = reveal ? {
			...dataset.analysis,
			redacted: false
		} : {
			...redactValue(dataset.analysis),
			redacted: true
		};
		const events = reveal ? dataset.events : this.redactedFor(dataset);
		return exportSession({
			session: reveal ? dataset.session : redactValue(dataset.session),
			analysis,
			events,
			format: options.format,
			includeEvents: options.includeEvents !== false,
			prompt: options.prompt === true,
			redacted: !reveal
		});
	}
	clearCache() {
		this.cache.clear();
	}
};
/**
* The analysis endpoint returns step prose and tool previews only. Full tool
* inputs/outputs and unbounded assistant text are available from the event
* detail endpoint, which keeps the analysis payload small for long sessions.
*/
function presentAnalysis(analysis, redacted) {
	const base = redacted ? redactValue(analysis) : analysis;
	return {
		...base,
		redacted,
		turns: base.turns.map((turn) => ({
			...turn,
			steps: turn.steps.map((step) => {
				const responseText = truncate(step.responseText, 8e4);
				const reasoningText = truncate(step.reasoningText, 8e4);
				const trimmed = responseText.length < step.responseText.length || reasoningText.length < step.reasoningText.length;
				return {
					...step,
					responseText,
					reasoningText,
					toolCalls: step.toolCalls.map((tool) => ({
						...tool,
						input: null,
						output: null,
						metadata: null
					})),
					uncertainty: trimmed ? [.../* @__PURE__ */ new Set([...step.uncertainty, "response-truncated-in-analysis"])] : step.uncertainty
				};
			})
		}))
	};
}
/**
* Reads one attempt off the resolved event stream. Under no reveal the stream
* is already redacted, so the input here is the redacted value: the comparison
* layer classifies it as `"redacted"` rather than assuming it is comparable.
*/
function attemptFor(events, eventID) {
	const tool = events.get(eventID)?.tool;
	if (!tool) return null;
	return {
		eventID,
		tool: tool.name,
		status: tool.status,
		input: tool.input,
		duration: tool.duration
	};
}
/** The numeric totals subset `compareEpisodeData` accepts. */
function totalsSubset(totals) {
	return {
		tokens: totals.tokens,
		tokensComplete: totals.tokensComplete,
		cost: totals.cost,
		modelTime: totals.modelTime,
		toolTime: totals.toolTime,
		totalTime: totals.activeTurnTime,
		outputSpeed: totals.outputSpeed,
		cacheHitRate: totals.cacheHitRate
	};
}
/** The numeric turn subset `compareEpisodeData` accepts. */
function turnSubset(turn) {
	return {
		tokens: turn.tokens,
		tokensComplete: turn.tokensComplete,
		cost: turn.cost,
		modelTime: turn.modelTime,
		toolTime: turn.toolTime,
		totalTime: turn.totalTime,
		outputSpeed: turn.outputSpeed,
		cacheHitRate: turn.cacheHitRate,
		index: turn.index,
		promptTokensLatest: turn.promptTokensLatest
	};
}
function toListEvent(event) {
	const meta = event.meta ?? {};
	const smallMeta = {};
	for (const key of [
		"delegatedAgent",
		"description",
		"notice",
		"source",
		"state",
		"reason",
		"summaryChars",
		"recentChars",
		"keepID",
		"shellID",
		"exit",
		"truncated",
		"attempt",
		"previous",
		"directory",
		"projectID",
		"timestampApproximate"
	]) if (key in meta) smallMeta[key] = meta[key];
	return {
		...event,
		text: null,
		payload: null,
		tool: event.tool ? {
			...event.tool,
			input: null,
			output: null,
			metadata: null
		} : null,
		meta: Object.keys(smallMeta).length > 0 ? smallMeta : void 0
	};
}
function filterEvents(events, filter, corpora = null) {
	const query = filter.q?.trim().toLowerCase();
	const kinds = filter.kinds?.length ? new Set(filter.kinds) : null;
	const agents = filter.agents?.length ? new Set(filter.agents.map((value) => value.toLowerCase())) : null;
	const models = filter.models?.length ? new Set(filter.models.map((value) => value.toLowerCase())) : null;
	const providers = filter.providers?.length ? new Set(filter.providers.map((value) => value.toLowerCase())) : null;
	const tools = filter.tools?.length ? new Set(filter.tools.map((value) => value.toLowerCase())) : null;
	const statuses = filter.statuses?.length ? new Set(filter.statuses.map((value) => value.toLowerCase())) : null;
	return events.filter((event, index) => {
		if (kinds && !kinds.has(event.kind)) return false;
		if (agents) {
			if (![event.agent, typeof event.meta?.delegatedAgent === "string" ? event.meta.delegatedAgent : null].filter((value) => typeof value === "string").map((value) => value.toLowerCase()).some((value) => agents.has(value))) return false;
		}
		if (models) {
			const value = event.model ? `${event.model.providerID}/${event.model.id}`.toLowerCase() : "";
			if (![...models].some((candidate) => value === candidate || value.endsWith(`/${candidate}`))) return false;
		}
		if (providers) {
			const value = event.provider?.toLowerCase() ?? "";
			if (!providers.has(value)) return false;
		}
		if (tools) {
			const value = event.tool?.name.toLowerCase() ?? "";
			if (!tools.has(value)) return false;
		}
		if (statuses) {
			const value = (event.tool?.status ?? event.status ?? "").toLowerCase();
			if (!statuses.has(value)) return false;
		}
		if (filter.errorsOnly && !event.flags.error) return false;
		if (filter.retriesOnly && event.kind !== "retry") return false;
		if (filter.compactionsOnly && event.kind !== "compaction") return false;
		if (filter.subagentsOnly && !event.flags.subagent) return false;
		if (filter.contextOnly && !event.flags.context) return false;
		if (filter.from !== void 0 && event.timestamp < filter.from) return false;
		if (filter.to !== void 0 && event.timestamp > filter.to) return false;
		if (filter.minPromptTokens !== void 0 || filter.maxPromptTokens !== void 0) {
			const prompt = promptTokensMetric(event.tokens).value;
			if (prompt === null) return false;
			if (filter.minPromptTokens !== void 0 && prompt < filter.minPromptTokens) return false;
			if (filter.maxPromptTokens !== void 0 && prompt > filter.maxPromptTokens) return false;
		}
		if (query) {
			if (!(corpora ? corpora[index] : eventSearchCorpus(event)).includes(query)) return false;
		}
		return true;
	});
}
// src/core/guardrails.ts
/**
* The out-of-the-box budgets. They sit just above the approved health watch
* levels on purpose: health flags an anomaly, a guardrail flags a budget the
* user chose to track. Frozen so the UI mirror, the TUI and the tests all
* assert against the same numbers.
*/
var DEFAULT_GUARDRAILS = Object.freeze({
	tokensTotal: 2e6,
	costTotal: 5,
	contextRun: 6,
	retries: 10,
	toolFailures: 5,
	elapsedMinutes: 60
});
/**
* The largest accepted value per budget. This table is the single source of
* truth: the GET `gr.*` contract validates against it, the browser settings
* panel mirrors it as a frozen literal and a test pins the mirror field for
* field, so a client and the server can never disagree on a bound.
*/
var GUARDRAIL_MAX = Object.freeze({
	tokensTotal: 0xe8d4a51000,
	costTotal: 0xe8d4a51000,
	contextRun: 0xe8d4a51000,
	retries: 0xe8d4a51000,
	toolFailures: 0xe8d4a51000,
	elapsedMinutes: 1e5
});
GUARDRAIL_MAX.elapsedMinutes;
var LABELS = Object.freeze({
	"tokens-total": "Token budget",
	"cost-total": "Cost budget",
	"context-run": "Context growth budget",
	retries: "Retry budget",
	"tool-failures": "Tool-failure budget",
	"elapsed-minutes": "Elapsed-time budget"
});
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
var NONE = { kind: "none" };
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
// src/server/http.ts
var UI_ROOT = fileURLToPath(new URL("../src/ui/", import.meta.url));
var VERSION$1 = "0.1.0";
/**
* Hard ceiling for a request body. The API is read-only and every action
* travels in the URL, so no route consumes a payload; the cap still bounds
* what a client can push at a socket. A declared `Content-Length` is rejected
* from the header alone, chunked framing is counted as it arrives, and the
* drain only starts after the Host and token gates accepted the request.
*/
var MAX_BODY_BYTES = 65536;
/** Tracked addresses before idle buckets are swept. */
var RATE_LIMIT_MAX_CLIENTS = 1024;
/**
* The 429 body is a fixed byte string: the limiter runs before routing, so no
* request-provided value can reach it.
*/
var RATE_LIMIT_BODY = "{\"error\":\"rate_limited\",\"message\":\"Too many requests. Retry later.\"}";
/**
* Node's own request timeout default is five minutes; the listener answers well
* before that, and the drain deadline below bounds a body that trickles in
* after its headers were accepted.
*/
var REQUEST_TIMEOUT_MS = 3e4;
/** A body still streaming after this long is aborted and its socket dropped. */
var DRAIN_DEADLINE_MS = 1e4;
/**
* `/api/sessions/{id}/diagnostics`. Exported so tests build requests from the
* same shape the router matches instead of re-typing the pattern.
*/
var SESSION_DIAGNOSTICS_PATTERN = /^\/api\/sessions\/([^/]+)\/diagnostics$/;
/** `/api/sessions/{id}/family-recovery`, shared with the tests that call it. */
var SESSION_FAMILY_RECOVERY_PATTERN = /^\/api\/sessions\/([^/]+)\/family-recovery$/;
/** `/api/sessions/{id}/live`, shared with the tests that call it. */
var SESSION_LIVE_PATTERN = /^\/api\/sessions\/([^/]+)\/live$/;
var MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2"
};
function securityHeaders(res) {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
}
function sendJson(req, res, status, payload, headers = {}) {
	if (res.headersSent || res.writableEnded || res.destroyed) return;
	const body = JSON.stringify(payload);
	securityHeaders(res);
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	res.end(body);
}
function sendText(req, res, status, body, contentType, headers = {}) {
	if (res.headersSent || res.writableEnded || res.destroyed) return;
	securityHeaders(res);
	res.statusCode = status;
	res.setHeader("Content-Type", contentType);
	res.setHeader("Cache-Control", "no-store");
	for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	res.end(body);
}
/**
* True when the request declares a body through either HTTP/1.1 framing
* header. No route reads a payload, but a declared body still has to be
* bounded before the router can ignore it.
*/
function declaresBody(req) {
	return req.headers["content-length"] !== void 0 || req.headers["transfer-encoding"] !== void 0;
}
/**
* Consumes a declared request body under `limit` and discards it. The declared
* `Content-Length` is rejected before a single byte is buffered, and a chunked
* body is counted as it arrives; crossing either bound stops the read and the
* caller answers 413 with `Connection: close`. A body still streaming when
* `deadlineMs` elapses is aborted: the socket is destroyed and the caller
* sends nothing. Nothing accumulates past `limit`, which is the point: the
* entry point owns the bound even though no route consumes the bytes.
*
* Request errors are sunk twice on purpose. One listener settles this promise
* and is removed with it; a second, permanent no-op listener keeps a late
* reset (after the response, while the socket closes) from surfacing as an
* uncaught exception.
*/
function drainBody(req, limit, deadlineMs) {
	return new Promise((resolve) => {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > limit) {
			resolve("too_large");
			return;
		}
		let total = 0;
		let settled = false;
		const deadline = setTimeout(() => {
			req.destroy();
			settle("timeout");
		}, deadlineMs);
		deadline.unref();
		function settle(result) {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			req.off("data", onData);
			req.off("end", onEnd);
			req.off("error", onError);
			resolve(result);
		}
		function onData(chunk) {
			total += chunk.length;
			if (total > limit) {
				req.pause();
				settle("too_large");
			}
		}
		function onEnd() {
			settle("ok");
		}
		function onError() {
			settle("ok");
		}
		req.on("error", () => {});
		req.on("data", onData);
		req.once("end", onEnd);
		req.once("error", onError);
	});
}
/**
* In-process token bucket, keyed by remote address and consulted before
* routing. It is deliberately generous (see `RATE_LIMIT_BURST` and
* `RATE_LIMIT_REFILL_PER_MINUTE`): the real UI never notices it, while a local
* loop cannot drive the filesystem-backed handlers without bound.
*/
var ClientRateLimiter = class {
	#burst;
	#refillPerMs;
	#maxClients;
	#now;
	#buckets = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.#burst = options.burst ?? 300;
		const refillPerMinute = options.refillPerMinute ?? 300;
		this.#refillPerMs = refillPerMinute / 6e4;
		this.#maxClients = options.maxClients ?? RATE_LIMIT_MAX_CLIENTS;
		this.#now = options.now ?? Date.now;
		if (!Number.isFinite(this.#burst) || this.#burst <= 0) throw new Error("rate limit burst must be a positive number");
		if (!Number.isFinite(this.#refillPerMs) || this.#refillPerMs <= 0) throw new Error("rate limit refill must be a positive number");
	}
	take(key) {
		const now = this.#now();
		const stored = this.#buckets.get(key);
		const available = stored === void 0 ? this.#burst : Math.min(this.#burst, stored.tokens + (now - stored.updatedAt) * this.#refillPerMs);
		if (available < 1) {
			this.#buckets.set(key, {
				tokens: available,
				updatedAt: now
			});
			const waitMs = (1 - available) / this.#refillPerMs;
			return {
				allowed: false,
				retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1e3))
			};
		}
		this.#buckets.set(key, {
			tokens: available - 1,
			updatedAt: now
		});
		this.#sweep(now);
		return {
			allowed: true,
			retryAfterSeconds: 0
		};
	}
	/**
	* Drops buckets that have refilled completely; they behave exactly like a
	* fresh entry, so removing them costs nothing. A bounded map is what keeps
	* the limiter itself out of the resource story.
	*/
	#sweep(now) {
		if (this.#buckets.size < this.#maxClients) return;
		for (const [key, bucket] of this.#buckets) if (bucket.tokens + (now - bucket.updatedAt) * this.#refillPerMs >= this.#burst) this.#buckets.delete(key);
	}
};
/**
* IPv4-mapped IPv6 addresses key the same bucket as their IPv4 form, so a
* client cannot double its budget by alternating representations.
*/
function clientKey(req) {
	const address = req.socket.remoteAddress ?? "unknown";
	return address.startsWith("::ffff:") ? address.slice(7) : address;
}
/**
* Maps an exception to a wire response. Only the status and code carry
* exception identity: every message is a fixed string, so neither an error
* object nor a request path can reach the response body. Exported so the
* regression tests can drive the mapping directly.
*/
function errorBody(error) {
	if (error instanceof SessionNotFoundError) return {
		status: 404,
		code: "session_not_found",
		message: "Session not found."
	};
	if (error instanceof EventNotFoundError) return {
		status: 404,
		code: "event_not_found",
		message: "Event not found."
	};
	if (error instanceof EpisodeNotFoundError) return {
		status: 404,
		code: "episode_not_found",
		message: "Episode not found."
	};
	if (error instanceof DatabaseBusyError) return {
		status: 503,
		code: "database_busy",
		message: "The OpenCode database is locked. Retry when the session is idle."
	};
	if (error instanceof UnsupportedSchemaError) return {
		status: 500,
		code: "unsupported_schema",
		message: "The database schema is not supported by this build."
	};
	if (error instanceof URIError) return {
		status: 400,
		code: "invalid_path",
		message: "Malformed request path."
	};
	if (error instanceof SyntaxError) return {
		status: 400,
		code: "invalid_query",
		message: "Invalid request."
	};
	return {
		status: 500,
		code: "internal_error",
		message: "Internal error."
	};
}
/**
* Rejects requests whose Host/Origin do not belong to this listener. Without
* this, a page that DNS-rebinds its own hostname to 127.0.0.1 is treated as
* same-origin and can read the API.
*/
function requestAllowed(req, bindHost, port) {
	const hostHeader = req.headers.host?.toLowerCase();
	if (!hostHeader) return false;
	const authorities = /* @__PURE__ */ new Set([
		`127.0.0.1:${port}`,
		`localhost:${port}`,
		`[::1]:${port}`
	]);
	const bind = bindHost.toLowerCase();
	if (bind && bind !== "0.0.0.0" && bind !== "::" && bind !== "127.0.0.1" && bind !== "::1" && bind !== "localhost") authorities.add(`${bind}:${port}`);
	const local = (req.socket.localAddress ?? "").toLowerCase();
	if (local) {
		const bare = local.startsWith("::ffff:") ? local.slice(7) : local;
		authorities.add(`${bare}:${port}`);
		authorities.add(`[${bare}]:${port}`);
	}
	if (!authorities.has(hostHeader)) return false;
	const site = req.headers["sec-fetch-site"];
	if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;
	const origin = req.headers.origin;
	if (typeof origin === "string") try {
		if (!authorities.has(new URL(origin).host.toLowerCase())) return false;
	} catch {
		return false;
	}
	return true;
}
function bool(search, name) {
	const value = search.get(name);
	return value === "1" || value === "true" || value === "yes" || value === "on";
}
function numberParam(search, name) {
	const raw = search.get(name);
	if (raw === null || raw === "") return void 0;
	const value = Number(raw);
	if (!Number.isFinite(value)) return void 0;
	return value;
}
function listParams(search, ...names) {
	const values = [];
	for (const name of names) for (const raw of search.getAll(name)) for (const part of raw.split(",")) {
		const value = part.trim();
		if (value.length > 0) values.push(value);
	}
	return values.length > 0 ? [...new Set(values)] : void 0;
}
function filterFromSearch(search) {
	return {
		q: search.get("q")?.trim() || void 0,
		kinds: listParams(search, "kind", "kinds"),
		agents: listParams(search, "agent", "agents"),
		models: listParams(search, "model", "models"),
		providers: listParams(search, "provider", "providers"),
		tools: listParams(search, "tool", "tools"),
		statuses: listParams(search, "status", "statuses"),
		errorsOnly: bool(search, "errors") || bool(search, "errorsOnly"),
		retriesOnly: bool(search, "retries") || bool(search, "retriesOnly"),
		compactionsOnly: bool(search, "compactions") || bool(search, "compactionsOnly"),
		subagentsOnly: bool(search, "subagents") || bool(search, "subagentsOnly"),
		contextOnly: bool(search, "context") || bool(search, "contextOnly"),
		from: numberParam(search, "from"),
		to: numberParam(search, "to"),
		minPromptTokens: numberParam(search, "minPromptTokens"),
		maxPromptTokens: numberParam(search, "maxPromptTokens")
	};
}
/** Longest benchmark filter value echoed back by a validation error. */
var MAX_FILTER_PARAM_LENGTH = 120;
/**
* A trimmed benchmark string parameter. Values are length-capped so a hostile
* query cannot grow the response, and an empty value means "not set".
*/
function trimmedParam(search, name) {
	const raw = search.get(name);
	if (raw === null) return void 0;
	const value = raw.trim().slice(0, MAX_FILTER_PARAM_LENGTH);
	return value.length > 0 ? value : void 0;
}
/**
* A numeric parameter that distinguishes "absent" from "present but not a
* number", so the benchmark route can answer 400 instead of silently dropping
* a malformed bound.
*/
function numericParam(search, name) {
	const raw = search.get(name);
	if (raw === null || raw.trim() === "") return { invalid: false };
	const value = Number(raw);
	if (!Number.isFinite(value)) return { invalid: true };
	return {
		value,
		invalid: false
	};
}
/**
* The closed `gr.*` vocabulary: one bounded budget per query parameter. The
* bounds come from `GUARDRAIL_MAX`, the same table the browser panel mirrors.
*/
var GUARDRAIL_PARAM_SPECS = [
	{
		name: "tokensTotal",
		key: "tokensTotal"
	},
	{
		name: "costTotal",
		key: "costTotal"
	},
	{
		name: "contextRun",
		key: "contextRun"
	},
	{
		name: "retries",
		key: "retries"
	},
	{
		name: "toolFailures",
		key: "toolFailures"
	},
	{
		name: "elapsedMinutes",
		key: "elapsedMinutes"
	}
];
/** Count budgets are whole numbers; cost and elapsed minutes may be fractional. */
var GUARDRAIL_INTEGER_KEYS = /* @__PURE__ */ new Set([
	"tokensTotal",
	"contextRun",
	"retries",
	"toolFailures"
]);
/** Plain decimal only: `0x10`, `1e3`, `+5` and `" 12 "` are all rejected. */
var GUARDRAIL_NUMBER_PATTERN = /^\d+(\.\d+)?$/;
Object.freeze(GUARDRAIL_PARAM_SPECS.map((spec) => `gr.${spec.name}`));
/**
* Reads the browser-owned guardrail budgets. The vocabulary is closed: an
* unknown `gr.*` key is invalid instead of silently ignored, a key repeated in
* the query is invalid instead of "first one wins", and every present value
* must be a plain decimal inside its documented bound (and a whole number for
* the count budgets). Absent keys fall back to `DEFAULT_GUARDRAILS`, so the
* evaluator stays stateless and the route is still a pure function of the query.
*/
function guardrailQuery(search) {
	const thresholds = { ...DEFAULT_GUARDRAILS };
	const seen = /* @__PURE__ */ new Set();
	let present = false;
	for (const key of search.keys()) {
		if (!key.startsWith("gr.")) continue;
		present = true;
		if (seen.has(key)) return {
			present,
			invalid: true,
			thresholds
		};
		seen.add(key);
		const name = key.slice(3);
		const spec = GUARDRAIL_PARAM_SPECS.find((entry) => entry.name === name);
		if (!spec) return {
			present,
			invalid: true,
			thresholds
		};
		const values = search.getAll(key);
		if (values.length !== 1) return {
			present,
			invalid: true,
			thresholds
		};
		const raw = values[0] ?? "";
		if (!GUARDRAIL_NUMBER_PATTERN.test(raw)) return {
			present,
			invalid: true,
			thresholds
		};
		const value = Number(raw);
		if (!Number.isFinite(value) || value < 0 || value > GUARDRAIL_MAX[spec.key]) return {
			present,
			invalid: true,
			thresholds
		};
		if (GUARDRAIL_INTEGER_KEYS.has(spec.key) && !Number.isInteger(value)) return {
			present,
			invalid: true,
			thresholds
		};
		thresholds[spec.key] = value;
	}
	return {
		present,
		invalid: false,
		thresholds
	};
}
var COMPARE_REQUIRED_PARAMS = [
	"leftSession",
	"leftEpisode",
	"rightSession",
	"rightEpisode"
];
/**
* Reads the four required comparison parameters. Returns null when one is
* absent or empty; `decodeURIComponent` is strict, so a malformed sequence
* throws `URIError` and the route answers with a stable 400 instead of a 500.
* A single encoding is already undone by `URLSearchParams`; the second decode
* only matters for ids a client encoded by hand with `encodeURIComponent`.
*/
function compareQuery(search) {
	const values = [];
	for (const name of COMPARE_REQUIRED_PARAMS) {
		const raw = search.get(name);
		if (raw === null || raw === "") return null;
		values.push(decodeURIComponent(raw));
	}
	const [leftSessionID, leftEpisodeID, rightSessionID, rightEpisodeID] = values;
	if (!leftSessionID || !leftEpisodeID || !rightSessionID || !rightEpisodeID) return null;
	return {
		leftSessionID,
		leftEpisodeID,
		rightSessionID,
		rightEpisodeID
	};
}
async function createObservabilityServer(options = {}) {
	const host = options.host ?? "127.0.0.1";
	if (host.trim() === "") throw new Error("host must not be empty");
	const authToken = options.authToken === void 0 ? void 0 : options.authToken.trim();
	if (options.authToken !== void 0 && authToken === "") throw new Error("authToken must not be empty");
	const authRequired = authToken !== void 0;
	if (!(host === "127.0.0.1" || host === "::1" || host === "localhost") && !authRequired) throw new Error("non-loopback hosts require authToken");
	const port = options.port ?? 4517;
	const allowReveal = options.allowReveal === true;
	const uiRoot = resolve(options.uiRoot ?? UI_ROOT);
	const dbPath = options.dbPath ?? discoverDatabase().path;
	const source = openWorkerSqliteSource(dbPath);
	try {
		await source.ready();
	} catch (error) {
		source.close();
		throw error;
	}
	const service = new ObservabilityService(source);
	let boundPort = port;
	const handle = async (req, res) => {
		try {
			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const path = decodeURIComponent(requestUrl.pathname);
			if (path.includes("\0")) {
				sendJson(req, res, 400, {
					error: "invalid_path",
					message: "Malformed request path."
				});
				return;
			}
			if (!requestAllowed(req, host, boundPort)) {
				sendJson(req, res, 403, {
					error: "forbidden_host",
					message: "Request host is not allowed."
				});
				return;
			}
			const bodyBearing = declaresBody(req);
			if (!bodyBearing && req.method !== "GET" && req.method !== "HEAD") {
				sendJson(req, res, 405, {
					error: "method_not_allowed",
					message: "Only GET and HEAD are supported."
				});
				return;
			}
			const search = requestUrl.searchParams;
			if (authToken !== void 0 && path.startsWith("/api/") && path !== "/api/health" && !isAuthorized(req, authToken)) {
				sendJson(req, res, 401, {
					error: "unauthorized",
					message: "A valid access token is required."
				}, {
					"WWW-Authenticate": "Bearer realm=\"opencode-observability\"",
					...bodyBearing ? { Connection: "close" } : {}
				});
				return;
			}
			if (bodyBearing && path.startsWith("/api/")) {
				const verdict = await drainBody(req, MAX_BODY_BYTES, DRAIN_DEADLINE_MS);
				if (verdict === "timeout") return;
				if (verdict === "too_large") {
					sendJson(req, res, 413, {
						error: "payload_too_large",
						message: "Request body is too large."
					}, { Connection: "close" });
					return;
				}
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				sendJson(req, res, 405, {
					error: "method_not_allowed",
					message: "Only GET and HEAD are supported."
				}, bodyBearing ? { Connection: "close" } : {});
				return;
			}
			const revealRequested = bool(search, "reveal");
			if (revealRequested && !allowReveal) {
				sendJson(req, res, 403, {
					error: "reveal_disabled",
					message: "Raw payload reveal is disabled by the server configuration."
				});
				return;
			}
			const reveal = revealRequested && allowReveal;
			if (!SESSION_LIVE_PATTERN.test(path) && path !== "/api/benchmark" && bool(search, "refresh")) service.clearCache();
			if (path === "/api/health") {
				sendJson(req, res, 200, {
					ok: true,
					name: "opencode-session-observability",
					version: VERSION$1,
					source: service.describe(),
					dbPath: basename(dbPath),
					revealAllowed: allowReveal,
					authRequired,
					readOnly: true,
					theme: readOpenCodeTheme()
				});
				return;
			}
			if (path === "/api/sessions") {
				sendJson(req, res, 200, {
					sessions: await service.listSessions({
						query: search.get("q") ?? void 0,
						limit: numberParam(search, "limit") ?? 200,
						reveal
					}),
					revealAllowed: allowReveal
				});
				return;
			}
			let match = /^\/api\/sessions\/([^/]+)$/.exec(path);
			if (match) {
				const sessionID = match[1];
				sendJson(req, res, 200, {
					...await service.getSession(sessionID, { reveal }),
					revealAllowed: allowReveal
				});
				return;
			}
			match = /^\/api\/sessions\/([^/]+)\/analysis$/.exec(path);
			if (match) {
				const sessionID = match[1];
				const fromSeq = numberParam(search, "fromSeq");
				const toSeq = numberParam(search, "toSeq");
				const guardrails = guardrailQuery(search);
				if (guardrails.invalid) {
					sendJson(req, res, 400, {
						error: "invalid_guardrails",
						message: "Guardrail budgets must be finite, non-negative numbers inside their documented bounds, and only the documented gr.* keys are accepted."
					});
					return;
				}
				const { analysis } = await service.analyze(sessionID, {
					fromSeq,
					toSeq,
					reveal,
					windowed: fromSeq !== void 0 || toSeq !== void 0
				});
				if (guardrails.present) {
					sendJson(req, res, 200, {
						analysis,
						guardrails: evaluateGuardrails(analysis, guardrails.thresholds),
						revealAllowed: allowReveal
					});
					return;
				}
				sendJson(req, res, 200, {
					analysis,
					revealAllowed: allowReveal
				});
				return;
			}
			match = SESSION_DIAGNOSTICS_PATTERN.exec(path);
			if (match) {
				const sessionID = match[1];
				sendJson(req, res, 200, {
					...await service.diagnostics(sessionID, { reveal }),
					revealAllowed: allowReveal
				});
				return;
			}
			match = SESSION_FAMILY_RECOVERY_PATTERN.exec(path);
			if (match) {
				const sessionID = match[1];
				sendJson(req, res, 200, {
					recovery: await service.familyRecovery(sessionID, { reveal }),
					revealAllowed: allowReveal
				});
				return;
			}
			match = /^\/api\/sessions\/([^/]+)\/events\/(.+)$/.exec(path);
			if (match) {
				const sessionID = match[1];
				const eventID = match[2];
				sendJson(req, res, 200, {
					event: await service.eventDetail(sessionID, eventID, { reveal }),
					revealAllowed: allowReveal
				});
				return;
			}
			match = /^\/api\/sessions\/([^/]+)\/events$/.exec(path);
			if (match) {
				const sessionID = match[1];
				const direction = search.get("direction") === "forward" ? "forward" : "backward";
				sendJson(req, res, 200, {
					...await service.events({
						sessionID,
						...filterFromSearch(search),
						limit: numberParam(search, "limit") ?? 240,
						before: search.get("before") ?? void 0,
						after: search.get("after") ?? void 0,
						around: search.get("around") ?? void 0,
						direction,
						reveal
					}),
					revealAllowed: allowReveal
				});
				return;
			}
			match = SESSION_LIVE_PATTERN.exec(path);
			if (match) {
				const sessionID = match[1];
				const since = search.get("since");
				sendJson(req, res, 200, {
					...await service.liveSnapshot(sessionID, {
						reveal,
						lastTurns: numberParam(search, "lastTurns"),
						since: since === null || since === "" ? void 0 : since
					}),
					revealAllowed: allowReveal
				});
				return;
			}
			match = /^\/api\/sessions\/([^/]+)\/export$/.exec(path);
			if (match) {
				const sessionID = match[1];
				const formatRaw = (search.get("format") ?? "json").toLowerCase();
				if (formatRaw !== "json" && formatRaw !== "markdown" && formatRaw !== "html" && formatRaw !== "digest") {
					sendJson(req, res, 400, {
						error: "invalid_format",
						message: "format must be json, markdown, html or digest"
					});
					return;
				}
				const options = {
					format: formatRaw,
					reveal,
					includeEvents: search.get("includeEvents") !== "0",
					prompt: bool(search, "prompt")
				};
				const result = await service.export(sessionID, options);
				sendText(req, res, 200, result.content, result.mime, {
					"Content-Disposition": `attachment; filename="${result.filename.replaceAll("\"", "")}"`,
					"X-Observability-Redacted": String(result.redacted)
				});
				return;
			}
			if (path === "/api/episodes/compare") {
				let query;
				try {
					query = compareQuery(search);
				} catch {
					sendJson(req, res, 400, {
						error: "invalid_query",
						message: "Malformed query string."
					});
					return;
				}
				if (!query) {
					sendJson(req, res, 400, {
						error: "invalid_query",
						message: "leftSession, leftEpisode, rightSession and rightEpisode are required."
					});
					return;
				}
				sendJson(req, res, 200, {
					comparison: await service.compareEpisodes({
						...query,
						reveal
					}),
					revealAllowed: allowReveal
				});
				return;
			}
			if (path === "/api/benchmark") {
				const groupBy = trimmedParam(search, "groupBy");
				if (groupBy !== void 0 && !isBenchmarkGroupBy(groupBy)) {
					sendJson(req, res, 400, {
						error: "invalid_group_by",
						message: `groupBy must be one of ${BENCHMARK_GROUP_BYS.join(", ")}.`
					});
					return;
				}
				const from = numericParam(search, "from");
				const to = numericParam(search, "to");
				if (from.invalid || to.invalid) {
					sendJson(req, res, 400, {
						error: "invalid_filters",
						message: "from and to must be finite epoch milliseconds."
					});
					return;
				}
				const outcomeParam = trimmedParam(search, "outcome");
				const outcome = outcomeParam === void 0 ? void 0 : outcomeParam.toLowerCase();
				if (outcome !== void 0 && !isBenchmarkOutcome(outcome)) {
					sendJson(req, res, 400, {
						error: "invalid_filters",
						message: `outcome must be one of ${BENCHMARK_OUTCOMES.join(", ")}.`
					});
					return;
				}
				const taskType = trimmedParam(search, "taskType");
				if (taskType !== void 0 && !isBenchmarkTaskType(taskType)) {
					sendJson(req, res, 400, {
						error: "invalid_filters",
						message: `taskType must be one of ${BENCHMARK_TASK_TYPES.join(", ")}.`
					});
					return;
				}
				const filters = {
					from: from.value,
					to: to.value,
					model: trimmedParam(search, "model"),
					provider: trimmedParam(search, "provider"),
					agent: trimmedParam(search, "agent"),
					directory: trimmedParam(search, "directory"),
					outcome,
					taskType,
					groupBy
				};
				if (!hasBenchmarkCriteria(filters)) {
					sendJson(req, res, 400, {
						error: "invalid_filters",
						message: "At least one filter is required: from, to, model, provider, agent, directory, outcome or taskType."
					});
					return;
				}
				sendJson(req, res, 200, {
					benchmark: await service.benchmark(filters, { reveal }),
					revealAllowed: allowReveal
				});
				return;
			}
			if (path === "/" || path === "/index.html") {
				await serveFile(req, res, join(uiRoot, "index.html"));
				return;
			}
			if (path.startsWith("/ui/")) {
				const relative = path.slice(4);
				const safe = normalize(relative).replace(/^([/\\])+/, "");
				const target = resolve(uiRoot, safe);
				if (!target.startsWith(uiRoot + sep) && target !== uiRoot) {
					sendJson(req, res, 403, {
						error: "forbidden",
						message: "Path escapes the UI root."
					});
					return;
				}
				await serveFile(req, res, target);
				return;
			}
			if (path === "/favicon.ico") {
				res.statusCode = 204;
				res.end();
				return;
			}
			sendJson(req, res, 404, {
				error: "not_found",
				message: "No route for this request."
			});
		} catch (error) {
			if (res.headersSent) {
				try {
					res.end();
				} catch {}
				return;
			}
			const mapped = errorBody(error);
			sendJson(req, res, mapped.status, {
				error: mapped.code,
				message: mapped.message
			});
		}
	};
	let inFlight = 0;
	const limiter = new ClientRateLimiter(options.rateLimit);
	const server = createServer((req, res) => {
		req.on("error", () => {});
		const budget = limiter.take(clientKey(req));
		if (!budget.allowed) {
			sendText(req, res, 429, RATE_LIMIT_BODY, "application/json; charset=utf-8", {
				"Retry-After": String(budget.retryAfterSeconds),
				...declaresBody(req) ? { Connection: "close" } : {}
			});
			return;
		}
		if (inFlight >= 32) {
			sendJson(req, res, 503, {
				error: "busy",
				message: "Too many concurrent requests."
			}, { "Retry-After": "1" });
			return;
		}
		inFlight++;
		(async () => {
			try {
				await handle(req, res);
			} catch (error) {
				try {
					process.stderr.write(`opencode-observability: request failed: ${error instanceof Error ? error.message : String(error)}\n`);
				} catch {}
			} finally {
				inFlight -= 1;
			}
		})();
	});
	server.requestTimeout = REQUEST_TIMEOUT_MS;
	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(port, host, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	const actualPort = address && typeof address === "object" ? address.port : port;
	boundPort = actualPort;
	return {
		server,
		url: `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${actualPort}`,
		host,
		port: actualPort,
		dbPath,
		source,
		service,
		close: async () => {
			await new Promise((resolveClose) => {
				server.close(() => resolveClose());
			});
			source.close();
		}
	};
}
/**
* Serves one static file under `MAX_SERVED_FILE_BYTES`. The size is read from
* the handle's own `stat` before any buffer is allocated, and the read stops
* at that size, so the allocation is bounded by the cap even if the file grows
* between the stat and the read. An oversized file is answered exactly like a
* missing one: the response never reveals whether it exists.
*/
async function serveFile(req, res, path) {
	try {
		const handle = await open(path, "r");
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size > 8388608) {
				sendJson(req, res, 404, {
					error: "not_found",
					message: "Static file not found."
				});
				return;
			}
			const body = Buffer.alloc(info.size);
			let offset = 0;
			while (offset < body.length) {
				const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			securityHeaders(res);
			res.statusCode = 200;
			res.setHeader("Content-Type", MIME[extname(path).toLowerCase()] ?? "application/octet-stream");
			res.setHeader("Cache-Control", "no-cache");
			res.setHeader("Content-Length", String(offset));
			if (req.method === "HEAD") {
				res.end();
				return;
			}
			res.end(offset === body.length ? body : body.subarray(0, offset));
		} finally {
			try {
				await handle.close();
			} catch {}
		}
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT" || code === "EISDIR") {
			sendJson(req, res, 404, {
				error: "not_found",
				message: "Static file not found."
			});
			return;
		}
		throw error;
	}
}
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
/**
* Writes a per-port token record with user-only permissions. The TUI reads it
* so default-on authentication does not require copying the token by hand.
*/
async function writeTokenFile(port, token) {
	const directory = tokenDirectory();
	await mkdir(directory, {
		recursive: true,
		mode: 448
	});
	const target = tokenFilePath(port);
	const temporary = `${target}.${process.pid}.tmp`;
	const record = {
		version: 1,
		port,
		token,
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		pid: process.pid
	};
	await writeFile(temporary, `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		mode: 384
	});
	await rm(target, { force: true });
	await rename(temporary, target);
	try {
		await chmod(target, 384);
	} catch {}
	return target;
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
/** Removes the file only when it still belongs to this run. */
async function removeTokenFile(port, token) {
	const record = await readTokenFile(port);
	if (!record || record.token !== token) return;
	await clearTokenFile(port);
}
/** Removes any token file for the port, including one left by a hard kill. */
async function clearTokenFile(port) {
	try {
		await rm(tokenFilePath(port), { force: true });
	} catch {}
}
// src/server/index.ts
var VERSION = "0.1.0";
var HELP = `opencode-session-observability ${VERSION}

Local, read-only Trajectory and Statistics views for OpenCode 2 sessions.

Usage:
  opencode-observability [options]

Options:
  --db <path>       Path to the OpenCode 2 SQLite database
                    (default: discover XDG/OpenCode 2 locations)
  --host <host>     Bind address (default: 127.0.0.1)
  --port <port>     Port (default: 4517; 0 picks a free port)
  --reveal          Allow the explicit "reveal secrets" mode
  --no-reveal       Keep reveal disabled (the default)
  --token           Generate a per-run access token (default) and print it
  --token=<value>   Use an explicit access token (at least 16 characters)
  --no-auth         Disable the access token (loopback only)
  --allow-remote    Allow a non-loopback --host; requires authentication
  --open            Open the browser after starting
  --help, -h        Show this help
  --version, -v     Print the version

The server is read-only: it opens the database with SQLITE_OPEN_READONLY and
PRAGMA query_only. It never writes sessions, messages or configuration.
`;
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"::1",
	"localhost"
]);
function isLoopback(host) {
	return LOOPBACK_HOSTS.has(host.toLowerCase());
}
function parseArgs(argv) {
	const options = {
		host: "127.0.0.1",
		port: 4517,
		allowReveal: false,
		allowRemote: false,
		generatedToken: false,
		noAuth: false,
		open: false,
		help: false,
		version: false
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--version" || arg === "-v") options.version = true;
		else if (arg === "--reveal") options.allowReveal = true;
		else if (arg === "--no-reveal") options.allowReveal = false;
		else if (arg === "--allow-remote") options.allowRemote = true;
		else if (arg === "--token") {
			options.authToken = generateToken();
			options.generatedToken = true;
		} else if (arg.startsWith("--token=")) {
			const value = arg.slice(8).trim();
			if (value.length < 16) throw new Error("--token must be at least 16 characters");
			options.authToken = value;
			options.generatedToken = false;
		} else if (arg === "--no-auth") options.noAuth = true;
		else if (arg === "--open") options.open = true;
		else if (arg === "--db") {
			const value = argv[++index];
			if (!value) throw new Error("--db requires a path");
			options.dbPath = value;
		} else if (arg.startsWith("--db=")) options.dbPath = arg.slice(5);
		else if (arg === "--host") {
			const value = argv[++index];
			if (!value) throw new Error("--host requires a value");
			options.host = value;
		} else if (arg.startsWith("--host=")) {
			const value = arg.slice(7);
			if (!value) throw new Error("--host requires a value");
			options.host = value;
		} else if (arg === "--port") {
			const value = Number(argv[++index]);
			if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("--port must be an integer between 0 and 65535");
			options.port = value;
		} else if (arg.startsWith("--port=")) {
			const value = Number(arg.slice(7));
			if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("--port must be an integer between 0 and 65535");
			options.port = value;
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	if (options.noAuth && options.authToken !== void 0) throw new Error("--token and --no-auth are mutually exclusive");
	if (options.noAuth) {
		options.authToken = void 0;
		options.generatedToken = false;
	} else if (options.authToken === void 0) {
		options.authToken = generateToken();
		options.generatedToken = true;
	}
	return options;
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
	} catch {}
}
async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	if (options.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	if (!isLoopback(options.host) && !options.allowRemote) {
		process.stderr.write(`Refusing to bind ${options.host}: the server is loopback-only by default.\nUse --allow-remote to expose it on a non-loopback interface; authentication stays required.
`);
		process.exitCode = 2;
		return;
	}
	if (!isLoopback(options.host) && options.authToken === void 0) {
		process.stderr.write(`Refusing to bind ${options.host} without authentication.\n--no-auth is loopback-only. Remove it or bind to a loopback address.
`);
		process.exitCode = 2;
		return;
	}
	let dbPath = options.dbPath;
	if (!dbPath) try {
		dbPath = discoverDatabase().path;
	} catch (error) {
		if (error instanceof DatabaseDiscoveryError) {
			process.stderr.write(`${error.message}\n\nCandidates:\n`);
			for (const candidate of error.candidates) process.stderr.write(`  [${candidate.exists ? candidate.schema : "missing"}] ${candidate.path}\n`);
			process.stderr.write("\nStart OpenCode 2 once, or pass --db <path> to an OpenCode 2 database.\n");
		} else if (error instanceof UnsupportedSchemaError) process.stderr.write(`${error.message}\n`);
		else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
		return;
	}
	let running;
	try {
		running = await createObservabilityServer({
			dbPath,
			host: options.host,
			port: options.port,
			allowReveal: options.allowReveal,
			authToken: options.authToken
		});
	} catch (error) {
		if (error instanceof UnsupportedSchemaError || error instanceof DatabaseBusyError) {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 1;
			return;
		}
		if (error.code === "EADDRINUSE") {
			process.stderr.write(`Port ${options.port} is already in use. Try --port 0 or another port.\n`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
	let tokenFile = null;
	if (options.authToken && options.generatedToken) try {
		tokenFile = await writeTokenFile(running.port, options.authToken);
	} catch (error) {
		process.stderr.write(`Warning: could not write the token file: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	else await clearTokenFile(running.port);
	const uiUrl = options.authToken ? `${running.url}/#/?token=${encodeURIComponent(options.authToken)}` : running.url;
	process.stdout.write([
		"OpenCode Session Observability",
		`Database: ${running.dbPath}`,
		`Bind:     ${running.host}:${running.port}`,
		`URL:      ${uiUrl}`,
		"Mode:     read-only (SQLITE_OPEN_READONLY, PRAGMA query_only)",
		options.allowReveal ? "Secrets:  redacted by default; explicit reveal is allowed" : "Secrets:  redacted; reveal is disabled (use --reveal to allow)",
		options.authToken ? `Auth:     token required (${options.generatedToken ? "generated" : "explicit"}); do not share this URL` : "Auth:     disabled (--no-auth; loopback only)",
		...tokenFile ? [`Token:    ${tokenFile} (read by the TUI)`] : [],
		...isLoopback(options.host) ? [] : ["Warning:  non-loopback bind; access requires the run token."],
		"Press Ctrl+C to stop.",
		""
	].join("\n"));
	if (options.open) openBrowser(uiUrl);
	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			await running.close();
		} finally {
			if (tokenFile && options.authToken) await removeTokenFile(running.port, options.authToken);
			process.exit(0);
		}
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
});
export {};
