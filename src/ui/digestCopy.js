/**
 * Pure helpers for the Statistics "copy for LLM review" actions.
 *
 * The digest is rendered server-side (`GET /api/sessions/{id}/export?format=digest`),
 * so this module owns only the same-origin URL and the copy confirmation copy.
 * It is a plain browser ES module with no DOM access, which keeps it testable
 * from Node without a browser harness. No LLM API is contacted: the copied text
 * is handed to the user's clipboard and nowhere else.
 */

/** Shown before copying while reveal is active, mirroring the reveal dialog. */
export const REVEAL_COPY_WARNING = {
  title: "Copy unredacted review material?",
  message:
    "Reveal is active, so API keys, tokens and credentials may appear in the copied text and on your clipboard. Treat the clipboard as sensitive and turn reveal off when you are finished.",
  acceptLabel: "Copy unredacted",
};

/**
 * Same-origin export URL for the digest. No `includeEvents`: the digest renders
 * from the normalized projection and ignores the event set.
 */
export function digestExportUrl(origin, sessionID, { prompt = false, reveal = false } = {}) {
  const url = new URL(
    `/api/sessions/${encodeURIComponent(sessionID)}/export`,
    origin,
  );
  url.searchParams.set("format", "digest");
  if (prompt) url.searchParams.set("prompt", "1");
  if (reveal) url.searchParams.set("reveal", "1");
  return url;
}

/** Toast confirmation for the copy action, honest about the redaction state. */
export function digestToastMessage(prompt, reveal) {
  const subject = prompt ? "Review prompt" : "Session digest";
  return reveal
    ? `${subject} copied (unredacted — contains secrets)`
    : `${subject} copied (credentials redacted)`;
}
