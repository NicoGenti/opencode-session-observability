import type { StatTileModel } from "../lib/statistics.ts";

/**
 * One headline figure (`DESIGN.md:47`): sentence-case label, value, sub-line
 * and the provenance superscript. There is no icon — the number is the icon.
 * The superscript prints on every tile, including `M`, so the basis is never
 * implied by omission.
 */
export function StatTile({ tile }: { tile: StatTileModel }) {
  return (
    <div className="min-w-0 rounded-sm border border-border bg-surface px-2.5 py-2">
      <div className="text-[11px] text-muted" title={tile.label}>
        {tile.label}
      </div>
      <div className="text-[18px] font-[650] leading-tight text-text tabular-nums" title={tile.title}>
        {tile.value}
        <sup className="ml-px align-super text-[10px] font-normal text-muted">
          {tile.mark}
        </sup>
      </div>
      {tile.sub ? (
        <div className="truncate text-[11px] text-text-2" title={tile.sub}>
          {tile.sub}
        </div>
      ) : null}
    </div>
  );
}
