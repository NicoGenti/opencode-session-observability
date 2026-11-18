/**
 * Pure helpers for the Statistics "copy for LLM review" actions.
 *
 * The digest is rendered server-side (`GET /api/sessions/{id}/export?format=digest`)
 * and requested through `exportRequestPath` in `app.js`, so this module owns
 * only the reveal warning and the copy confirmation copy. It is a plain browser
 * ES module with no DOM access, which keeps it testable from Node without a
 * browser harness. No LLM API is contacted: the copied text is handed to the
 * user's clipboard and nowhere else.
 */

/** Shown before copying while reveal is active, mirroring the reveal dialog. */
export const REVEAL_COPY_WARNING = {
  title: "Copy unredacted review material?",
  message:
    "Reveal is active, so API keys, tokens and credentials may appear in the copied text and on your clipboard. Treat the clipboard as sensitive and turn reveal off when you are finished.",
  acceptLabel: "Copy unredacted",
};

/** Toast confirmation for the copy action, honest about the redaction state. */
export function digestToastMessage(prompt, reveal) {
  const subject = prompt ? "Review prompt" : "Session digest";
  return reveal
    ? `${subject} copied (unredacted — contains secrets)`
    : `${subject} copied (credentials redacted)`;
}
