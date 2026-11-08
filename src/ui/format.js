const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

export function formatNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return numberFormat.format(value);
}

export function formatCompact(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const abs = Math.abs(ms);
  if (abs < 1_000) return `${Math.round(ms)} ms`;
  if (abs < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  if (abs < 3_600_000) {
    const minutes = Math.floor(abs / 60_000);
    const seconds = Math.round((abs % 60_000) / 1_000);
    return `${ms < 0 ? "-" : ""}${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.round((abs % 3_600_000) / 60_000);
  return `${ms < 0 ? "-" : ""}${hours}h ${minutes}m`;
}

export function formatPercent(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatCost(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

export function formatDateTime(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString();
}

export function formatTime(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().slice(11, 23);
}

export function formatRelative(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return formatDateTime(ms);
  const seconds = Math.round(diff / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function modelLabel(model) {
  if (!model) return "—";
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`;
}

export function modelParts(model) {
  if (!model) return { id: "—", provider: "—", variant: "", label: "—" };
  return {
    id: model.id,
    provider: model.providerID,
    variant: model.variant ?? "",
    label: modelLabel(model),
  };
}

export function turnModelParts(turn) {
  for (let index = turn.steps.length - 1; index >= 0; index--) {
    const step = turn.steps[index];
    if (step.model) return modelParts(step.model);
  }
  return modelParts(null);
}

export function basisMark(basis) {
  if (basis === "measured") return "M";
  if (basis === "derived") return "D";
  if (basis === "estimated") return "E";
  return "—";
}

export function basisLabel(basis) {
  return basis === "unavailable" ? "unavailable" : basis;
}

export function metricValue(metric, formatter) {
  if (!metric || metric.value === null || metric.value === undefined) return "—";
  return formatter(metric.value);
}

export function metricHtml(metric, formatter) {
  if (!metric || metric.value === null || metric.value === undefined) {
    return `<span class="metric unavailable" title="${escapeAttr(
      metric?.note ?? "unavailable",
    )}">—</span>`;
  }
  const text = escapeHtml(formatter(metric.value));
  if (metric.basis === "measured") return `<span class="metric">${text}</span>`;
  const title = `${basisLabel(metric.basis)}${metric.note ? `: ${metric.note}` : ""}`;
  return `<span class="metric metric-${escapeAttr(metric.basis)}" title="${escapeAttr(
    title,
  )}">${text}<sup>${basisMark(metric.basis)}</sup></span>`;
}

export function statusClass(status) {
  if (status === "completed" || status === "succeeded") return "status-completed";
  if (status === "error" || status === "failed") return "status-error";
  if (status === "interrupted") return "status-interrupted";
  if (status === "running") return "status-running";
  return "status-incomplete";
}

export function badge(label, kind = "neutral", title = "") {
  return `<span class="badge badge-${escapeAttr(kind)}"${
    title ? ` title="${escapeAttr(title)}"` : ""
  }>${escapeHtml(label)}</span>`;
}

export function eventBadges(event) {
  const badges = [];
  if (event.flags?.error && event.kind !== "error") {
    badges.push(badge("error", "error"));
  }
  if (event.flags?.retry && event.kind !== "retry") {
    badges.push(badge("retry", "retry"));
  }
  if (event.flags?.compaction && event.kind !== "compaction") {
    badges.push(badge("compaction", "compaction"));
  }
  if (event.flags?.context) {
    badges.push(badge("context", "context"));
  }
  if (event.flags?.subagent) badges.push(badge("subagent", "subagent"));
  if (event.uncertainty?.length) {
    badges.push(
      badge("uncertain", "uncertain", event.uncertainty.join(", ")),
    );
  }
  return badges.join("");
}

export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function parseFilename(disposition, fallback) {
  if (!disposition) return fallback;
  const match = /filename=\"?([^\";]+)\"?/i.exec(disposition);
  return match?.[1] ?? fallback;
}
