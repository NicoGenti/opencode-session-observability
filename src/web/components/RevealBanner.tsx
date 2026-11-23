import { REVEAL_BANNER } from "../lib/export.ts";

/**
 * The persistent reveal banner (`index.html:63-65`).
 *
 * `DESIGN.md:55` is the rule: a banner may tint its border/background with a
 * semantic colour, but its body text stays ink — never warning-coloured. The
 * banner is present for as long as reveal is on and disappears the moment it is
 * turned off, before the redacted re-request settles.
 */
export function RevealBanner({ reveal }: { reveal: boolean }) {
  if (!reveal) return null;
  return (
    <div
      role="status"
      className="border-b border-warning bg-surface-2 px-4 py-1.5 text-[12px] text-text"
    >
      {REVEAL_BANNER}
    </div>
  );
}
