import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { slugify } from "../../core/format.ts";

/**
 * Delivery of the LLM review prompt inside the TUI.
 *
 * The TUI host exposes no clipboard API, so the prompt is written to one
 * deterministic file under the caller's temp directory and the panel toasts the
 * path. The name is derived from the session id only (`slugify` strips path
 * separators and traversal), so repeating the action overwrites the same file
 * instead of scattering copies.
 */

const FILE_PREFIX = "opencode-observability-review";
const FILE_EXTENSION = ".md";

/** Deterministic, sanitized path for one session's review prompt file. */
export function reviewPromptFilePath(tmpDir: string, sessionID: string): string {
  return join(tmpDir, `${FILE_PREFIX}-${slugify(sessionID)}${FILE_EXTENSION}`);
}

/** Writer seam: `node:fs/promises` in production, a recorder in tests. */
export type ReviewPromptWriter = (
  path: string,
  content: string,
) => Promise<void>;

const writeUtf8: ReviewPromptWriter = (path, content) =>
  writeFile(path, content, { encoding: "utf8", mode: 0o600 });

/** Writes (or overwrites) the prompt file through an injectable writer. */
export async function writeReviewPromptFile(
  path: string,
  content: string,
  write: ReviewPromptWriter = writeUtf8,
): Promise<void> {
  await write(path, content);
}
