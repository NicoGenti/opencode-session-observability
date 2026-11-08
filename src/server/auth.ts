import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const TOKEN_HEADER = "x-observability-token";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Hashes both values first so the comparison is constant-time regardless of
 * the supplied token's length. `timingSafeEqual` requires equal-length buffers;
 * SHA-256 digests always are.
 */
export function tokenMatches(
  expected: string,
  supplied: string | null | undefined,
): boolean {
  if (!supplied) return false;
  return timingSafeEqual(digest(expected), digest(supplied));
}

/** Accepts `Authorization: Bearer <token>` or the dedicated header. */
export function requestToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) {
      const value = match[1]!.trim();
      if (value.length > 0) return value;
    }
  }
  const header = req.headers[TOKEN_HEADER];
  if (typeof header === "string") {
    const value = header.trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

export function isAuthorized(req: IncomingMessage, expected: string): boolean {
  return tokenMatches(expected, requestToken(req));
}
