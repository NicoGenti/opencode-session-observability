import type { ModelRef, TokenUsage, TokenUsagePartial } from "./types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Parses a JSON string, returning the input unchanged when it is already data. */
export function parseJson(value: unknown): unknown {
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
export function toMillis(value: unknown): number | null {
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

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

export function preview(value: unknown, max = 240): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

export function safeStringify(value: unknown, space = 0): string {
  try {
    return JSON.stringify(value, null, space) ?? "";
  } catch {
    return String(value);
  }
}

export function normalizeModel(value: unknown): ModelRef | null {
  const record = asRecord(parseJson(value));
  const providerID = str(record.providerID) ?? str(record.provider);
  const id = str(record.id) ?? str(record.modelID);
  if (!providerID || !id) return null;
  const variant = str(record.variant) ?? undefined;
  return variant ? { providerID, id, variant } : { providerID, id };
}

export function modelLabel(model: ModelRef | null): string | null {
  if (!model) return null;
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

/** Reads a token usage object defensively. Returns null when no count exists. */
export function normalizeTokens(value: unknown): TokenUsage | null {
  const source = asRecord(parseJson(value));
  const cache = asRecord(source.cache);
  const partial: TokenUsagePartial = {
    input: num(source.input) ?? undefined,
    output: num(source.output) ?? undefined,
    reasoning: num(source.reasoning) ?? undefined,
    cacheRead: num(cache.read) ?? undefined,
    cacheWrite: num(cache.write) ?? undefined,
  };
  const present = Object.values(partial).some((v) => v !== undefined);
  if (!present) return null;
  return {
    input: partial.input ?? 0,
    output: partial.output ?? 0,
    reasoning: partial.reasoning ?? 0,
    cacheRead: partial.cacheRead ?? 0,
    cacheWrite: partial.cacheWrite ?? 0,
  };
}

export function tokensArePartial(value: unknown): boolean {
  const source = asRecord(parseJson(value));
  const cache = asRecord(source.cache);
  return (
    source.input === undefined ||
    source.output === undefined ||
    source.reasoning === undefined ||
    cache.read === undefined ||
    cache.write === undefined
  );
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const SECRET_KEY_TOKENS = new Set([
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
  "signingkey",
]);

/** Object keys are matched by normalized name, so new key spellings are covered. */
function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SECRET_KEY_TOKENS.has(normalized)) return true;
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials")
  );
}

const PRIVATE_KEY_HEADER = "PRIVATE KEY-----";
const PRIVATE_KEY_END = "-----END ";

/**
 * Replaces complete PEM private-key blocks with a marker without a regex.
 * The previous pattern used an unbounded lazy wildcard, which was quadratic
 * on text containing many BEGIN markers and no END marker. Unterminated
 * blocks (including previews cut mid-key) are redacted to end of string.
 */
function redactPemBlocks(value: string): string {
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
    let endStart = value.indexOf(PRIVATE_KEY_END, headerEnd + PRIVATE_KEY_HEADER.length);
    let endEnd = -1;
    while (endStart !== -1) {
      const marker = value.indexOf(PRIVATE_KEY_HEADER, endStart + PRIVATE_KEY_END.length);
      if (marker === -1) break;
      if (value.slice(endStart + PRIVATE_KEY_END.length, marker) === label) {
        endEnd = marker + PRIVATE_KEY_HEADER.length;
        break;
      }
      endStart = value.indexOf(PRIVATE_KEY_END, marker + PRIVATE_KEY_HEADER.length);
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
function redactTruncatedTail(value: string): string {
  let out = value;
  out = out.replace(
    /\b(?:sk-[A-Za-z0-9_-]*|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]*|gh[pousr]_[A-Za-z0-9]*|glpat-[A-Za-z0-9_-]*|npm_[A-Za-z0-9]*|pypi-[A-Za-z0-9_-]*|hf_[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]*|xox[baprs]-?[A-Za-z0-9-]*|AIza[0-9A-Za-z_-]*|AKIA[0-9A-Z]*)…$/,
    "[REDACTED]…",
  );
  out = out.replace(/\beyJ[A-Za-z0-9_-]*…$/, "[REDACTED:jwt]…");
  out = out.replace(
    /((?:"(?:api[-_]?key|apikey|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|authorization|database[-_]?url|dsn)"\s*:\s*")[^"]*)…$/gi,
    "$1[REDACTED]…",
  );
  out = out.replace(
    /((?:api[-_]?key|apikey|password|passwd|passphrase|secret|token|authorization|database[-_]?url|dsn)\s*[:=]\s*)(?:"[^"]*|'[^']*|[^\s&;,"']*)…$/gi,
    "$1[REDACTED]…",
  );
  out = out.replace(
    /((?<![A-Za-z0-9_])(?:token|id[-_]?token|session[-_]?token)\s*[:=]\s*)(?:"[^"]*|'[^']*|[^\s&;,"']*)…$/gi,
    "$1[REDACTED]…",
  );
  out = out.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*…$/i,
    "$1[REDACTED]…",
  );
  out = out.replace(
    /((?:Proxy-)?Authorization\s*:\s*(?:Basic|Digest)\s+)[^\s]*…$/i,
    "$1[REDACTED]…",
  );
  out = out.replace(/((?:Set-)?Cookie\s*:\s*)[^\r\n]*…$/i, "$1[REDACTED]…");
  return out;
}

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{10,}/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: "stripe-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { name: "github-fine-grained", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { name: "pypi-token", pattern: /\bpypi-[A-Za-z0-9_-]{20,}/g },
  { name: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}/g },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { name: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{1,}\.[A-Za-z0-9_-]{1,}/g },
  { name: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "aws-secret",
    pattern:
      /((?:aws[-_]?secret[-_]?access[-_]?key|secret[-_]?access[-_]?key|secretAccessKey)\s*[:=]\s*['"]?)[A-Za-z0-9/+=]{30,}/gi,
  },
  { name: "url-credentials", pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi },
  {
    name: "query-credential",
    pattern: /([?&](?:api[-_]?key|token|access[-_]?token|key|secret|password)=)[^&\s]+/gi,
  },
  {
    name: "json-credential",
    pattern:
      /("(?:api[-_]?key|apikey|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|authorization|database[-_]?url|dsn)"\s*:\s*")[^"]*(")/gi,
  },
  {
    name: "basic-auth",
    pattern: /(\b(?:Proxy-)?Authorization\s*:\s*(?:Basic|Digest)\s+)[A-Za-z0-9+/=._~-]+/gi,
  },
  { name: "cookie-header", pattern: /(\b(?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi },
  {
    name: "assignment-credential",
    pattern:
      /((?:api[-_]?key|apikey|password|passwd|passphrase|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|auth[-_]?token|api[-_]?token|secret[-_]?access[-_]?key|database[-_]?url|dsn)(?:[A-Za-z0-9_-]*)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&;,"']+)/gi,
  },
  {
    name: "token-assignment",
    // Bare token assignments need a length and letter guard so token counts
    // such as `input_tokens: 100` and `token: 100` stay readable.
    pattern:
      /((?<![A-Za-z0-9_])(?:token|id[-_]?token|session[-_]?token)\s*[:=]\s*)(?:"[^"]+"|'[^']+'|(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=-]{8,})/gi,
  },
];

const REDACTED = "[REDACTED]";

/**
 * Redacts credential-shaped keys and strings. Token *counts* (`tokens.input`,
 * `cache.read`, ...) are deliberately preserved: they are metrics, not secrets.
 */
export function redactValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value as object)) return "[Circular]";
  ancestors.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(item, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value as object);
  }
}

export function redactString(value: string): string {
  let out = redactPemBlocks(value);
  for (const { name, pattern } of SECRET_PATTERNS) {
    out = out.replace(
      pattern,
      (match: string, prefix?: string, suffix?: string) => {
        if (name === "url-credentials" && prefix) return `${prefix}[REDACTED]@`;
        if (name === "query-credential" && prefix) return `${prefix}[REDACTED]`;
        if (name === "json-credential" && prefix && suffix) {
          return `${prefix}[REDACTED]${suffix}`;
        }
        if (
          (name === "assignment-credential" ||
            name === "token-assignment" ||
            name === "aws-secret" ||
            name === "basic-auth" ||
            name === "cookie-header") &&
          prefix
        ) {
          return `${prefix}[REDACTED]`;
        }
        return `[REDACTED:${name}]`;
      },
    );
  }
  if (out.endsWith("…")) out = redactTruncatedTail(out);
  return out;
}

export function containsSecret(value: string): boolean {
  return redactString(value) !== value;
}
