import clsx from "clsx";
import type { BadgeKind } from "../lib/ledger.ts";
import type { DiagnosticBadgeKind } from "../lib/diagnostics.ts";

type AnyBadgeKind = BadgeKind | DiagnosticBadgeKind;

/**
 * The one badge renderer. Every badge is text plus a token treatment; no state
 * relies on colour alone (`DESIGN.md:50`, `:60-62`). The semantic classes reuse
 * `--accent-weak`, `--good`, `--critical` and the dashed uncertain border; no
 * literal colour enters the component.
 */
const KIND_CLASS: Record<AnyBadgeKind, string> = {
  neutral: "border-border bg-surface-2 text-text-2",
  error: "border-critical bg-surface-2 text-critical",
  retry: "border-accent bg-accent-weak text-accent",
  compaction: "border-accent bg-accent-weak text-accent",
  context: "border-accent bg-accent-weak text-accent",
  tool: "border-accent bg-accent-weak text-accent",
  subagent: "border-good bg-surface-2 text-good",
  uncertain: "border-dashed border-border-strong bg-surface-2 text-text-2",
  good: "border-good bg-surface-2 text-good",
  accent: "border-accent bg-accent-weak text-accent",
};

export interface BadgeProps {
  label: string;
  kind?: AnyBadgeKind;
  title?: string;
}

export function Badge({ label, kind = "neutral", title }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px] leading-[1.55] whitespace-nowrap",
        KIND_CLASS[kind],
      )}
      title={title}
    >
      {label}
    </span>
  );
}
