import {
  badge,
  copyText,
  debounce,
  downloadBlob,
  escapeAttr,
  escapeHtml,
  eventBadges,
  formatCompact,
  formatCost,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTime,
  metricHtml,
  modelLabel,
  modelParts,
  parseFilename,
  statusClass,
  turnModelParts,
} from "./format.js";
import {
  authHeaders,
  consumeTokenFromLocation,
  storeToken,
} from "./auth.js";
import { renderMarkdown } from "./markdown.js";
import { mergePages } from "./paging.js";
import {
  THEMES,
  VIEW_MODES,
  applyPalette,
  applyTheme,
  applyViewMode,
  get,
  getTheme,
  getViewMode,
  migrate,
  readPaletteFromHash,
  readThemeFromHash,
  reset as resetSettings,
  set as setSetting,
  setTheme,
  setViewMode,
} from "./settings.js";
import { VirtualList } from "./virtual.js";

const eventKinds = [
  "assistant",
  "reasoning",
  "text",
  "tool",
  "user",
  "synthetic",
  "system",
  "skill",
  "shell",
  "compaction",
  "agent-switched",
  "model-switched",
  "location-switched",
  "idle",
  "retry",
  "error",
  "session",
  "unknown",
];

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const state = {
  token: null,
  sessions: [],
  sessionID: null,
  session: null,
  family: null,
  analysis: null,
  facets: null,
  view: "trajectory",
  filters: defaultFilters(),
  events: [],
  page: null,
  reveal: false,
  revealAllowed: false,
  viewMode: getViewMode(),
  contextBasis: get("contextBasis") === "cumulative" ? "cumulative" : "latest",
  showEventRows: get("showEventRows") === true,
  expandedTurns: new Set(),
  expandedSteps: new Set(),
  selectedEventID: null,
  // Event IDs in the currently opened incident's failing-event sequence.
  // Renderer state only: rebuilt from the stored diagnostics DTO, never
  // recomputed (DR-1) and read at row-render time (DR-10).
  highlightedDiagnosticEventIDs: new Set(),
  scrollTop: 0,
  ledger: null,
  detailEvent: null,
  liveTimer: null,
  sessionQuery: "",
  responseLimit: responseLimitSetting(),
  groupByProject: get("groupByProject") !== false,
  sessionTree: get("sessionTree") !== false,
  // Branches start collapsed; these sets remember what the user expanded.
  expandedProjects: new Set(
    Array.isArray(get("expandedProjects")) ? get("expandedProjects") : [],
  ),
  expandedParents: new Set(
    Array.isArray(get("expandedParents")) ? get("expandedParents") : [],
  ),
  settingsOpener: null,
  drawerOpener: null,
  shortcutsOpener: null,
  confirmOpener: null,
  loading: false,
};

function responseLimitSetting() {
  const value = Number(get("responseLimit"));
  return [4_000, 12_000, 20_000, 50_000, 80_000].includes(value) ? value : 20_000;
}

const dom = {};

function defaultFilters() {
  return {
    q: "",
    kinds: [],
    agents: [],
    models: [],
    providers: [],
    tools: [],
    statuses: [],
    errorsOnly: false,
    retriesOnly: false,
    compactionsOnly: false,
    subagentsOnly: false,
    contextOnly: false,
    from: "",
    to: "",
    minPromptTokens: "",
    maxPromptTokens: "",
  };
}

function filtersActive() {
  return activeFilterCount() > 0;
}

function activeFilterCount() {
  const f = state.filters;
  const advanced = state.viewMode === "advanced";
  let count = 0;
  if (f.q.trim()) count++;
  const listKeys = advanced
    ? ["kinds", "agents", "models", "providers", "tools", "statuses"]
    : ["kinds"];
  for (const key of listKeys) {
    if (f[key].length > 0) count++;
  }
  for (const key of [
    "errorsOnly",
    "retriesOnly",
    "compactionsOnly",
    "subagentsOnly",
    "contextOnly",
  ]) {
    if (f[key]) count++;
  }
  if (advanced && f.from) count++;
  if (advanced && f.to) count++;
  if (advanced && f.minPromptTokens) count++;
  if (advanced && f.maxPromptTokens) count++;
  return count;
}

async function api(path, params = {}, options = {}) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) url.searchParams.set(key, value.join(","));
    } else if (value === true) {
      url.searchParams.set(key, "1");
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  if (state.reveal && !options.noReveal) url.searchParams.set("reveal", "1");
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...authHeaders(state.token) },
    cache: "no-store",
  });
  if (response.status === 401 && !options.authRetried) {
    state.token = null;
    const entered =
      typeof window !== "undefined" && typeof window.prompt === "function"
        ? window.prompt("Access token for the observability server:")
        : null;
    const token = typeof entered === "string" ? entered.trim() : "";
    if (token) {
      state.token = token;
      storeToken(token);
      return api(path, params, { ...options, authRetried: true });
    }
  }
  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw new ApiError(
      response.status,
      body?.error ?? "http_error",
      body?.message ?? `Request failed (${response.status})`,
    );
  }
  return response.json();
}

function $(selector) {
  return document.querySelector(selector);
}

function setText(element, value) {
  if (element) element.textContent = value ?? "";
}

function showError(error) {
  if (!dom.error) return;
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  dom.error.textContent = message;
  dom.error.hidden = false;
  if (error instanceof ApiError && error.code === "reveal_disabled") {
    state.revealAllowed = false;
    state.reveal = false;
    renderRevealState();
  }
}

function clearError() {
  if (dom.error) dom.error.hidden = true;
}

let toastTimer = null;
function toast(message) {
  if (!dom.toast) return;
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, 2400);
}

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

function filterParams() {
  const f = state.filters;
  const advanced = state.viewMode === "advanced";
  const from = advanced && f.from ? Date.parse(f.from) : undefined;
  const to = advanced && f.to ? Date.parse(f.to) : undefined;
  return {
    q: f.q.trim() || undefined,
    kind: f.kinds,
    ...(advanced
      ? {
          agent: f.agents,
          model: f.models,
          provider: f.providers,
          tool: f.tools,
          status: f.statuses,
          from: Number.isFinite(from) ? from : undefined,
          to: Number.isFinite(to) ? to : undefined,
          minPromptTokens: f.minPromptTokens || undefined,
          maxPromptTokens: f.maxPromptTokens || undefined,
        }
      : {}),
    errors: f.errorsOnly || undefined,
    retries: f.retriesOnly || undefined,
    compactions: f.compactionsOnly || undefined,
    subagents: f.subagentsOnly || undefined,
    context: f.contextOnly || undefined,
  };
}

async function loadSessions(query = state.sessionQuery) {
  state.sessionQuery = query;
  try {
    const data = await api("/api/sessions", { q: query || undefined, limit: 300 });
    state.sessions = data.sessions ?? [];
    renderSessionList();
  } catch (error) {
    showError(error);
  }
}

async function selectSession(sessionID, view = state.view, eventID = null) {
  dom.shell?.classList.remove("sidebar-open");
  const changed = sessionID !== state.sessionID;
  state.sessionID = sessionID;
  state.view = view;
  if (changed) {
    state.filters = defaultFilters();
    state.expandedTurns.clear();
    state.expandedSteps.clear();
    state.selectedEventID = null;
    state.events = [];
    state.page = null;
    state.scrollTop = 0;
    state.detailEvent = null;
    state.drawerOpener = null;
    setDiagnosticHighlight([]);
    closeDrawer();
  }
  updateHash();
  renderTabs();
  await loadSessionData({ resetScroll: true, openEventID: eventID });
  renderSessionList();
  renderFamily();
}

async function loadSessionData(options = {}) {
  if (!state.sessionID) return;
  const requestedSession = state.sessionID;
  state.loading = true;
  clearError();
  renderLoading();
  try {
    const [sessionData, analysisData] = await Promise.all([
      api(`/api/sessions/${encodeURIComponent(requestedSession)}`),
      api(`/api/sessions/${encodeURIComponent(requestedSession)}/analysis`, {
        refresh: options.refresh ? 1 : undefined,
      }),
    ]);
    if (state.sessionID !== requestedSession) return;
    state.session = sessionData.session;
    state.family = sessionData.family;
    state.analysis = analysisData.analysis;
    state.facets = buildFacets(state.analysis);
    state.revealAllowed = sessionData.revealAllowed !== false && analysisData.revealAllowed !== false;
    // D1: rebuild the highlight from the deep-linked/open event so it survives
    // a refresh. A session switch already cleared it, and an event that is not
    // an incident's first failure clears it again.
    const highlightAnchor = options.openEventID ?? state.detailEvent?.id ?? null;
    if (highlightAnchor) applyIncidentHighlight(highlightAnchor);
    renderHeader();
    renderFamily();
    await loadEvents({ reset: true, preserveScroll: options.preserveScroll });
    if (options.openEventID) {
      await ensureEventLoaded(options.openEventID);
      state.ledger?.scrollToEvent(options.openEventID);
      await openDetail(options.openEventID);
    }
  } catch (error) {
    showError(error);
    renderEmpty("Unable to load this session", error.message);
  } finally {
    state.loading = false;
    renderLoading();
  }
}

let eventRequestSeq = 0;

async function loadEvents(options = {}) {
  if (!state.sessionID) return;
  const requestSeq = ++eventRequestSeq;
  const params = {
    ...filterParams(),
    limit: 240,
    direction: "backward",
  };
  if (!options.reset && state.page?.before) params.before = state.page.before;
  if (options.forward && state.page?.after) {
    params.direction = "forward";
    params.after = state.page.after;
    delete params.before;
  }
  if (options.around) params.around = options.around;
  try {
    const data = await api(
      `/api/sessions/${encodeURIComponent(state.sessionID)}/events`,
      params,
    );
    if (requestSeq !== eventRequestSeq) return;
    const previousPage = state.page;
    if (options.reset) {
      state.events = data.events ?? [];
      state.page = data.page;
    } else if (options.forward) {
      const merged = mergePages(
        state.events,
        data.events ?? [],
        "forward",
        (event) => event.orderKey,
      );
      state.events = merged.items;
      state.page = {
        ...data.page,
        before: previousPage?.before ?? data.page.before,
        hasMoreBefore: previousPage?.hasMoreBefore ?? data.page.hasMoreBefore,
      };
    } else {
      const merged = mergePages(
        state.events,
        data.events ?? [],
        "backward",
        (event) => event.orderKey,
      );
      state.events = merged.items;
      state.page = {
        ...data.page,
        after: previousPage?.after ?? data.page.after,
        hasMoreBefore: data.page.hasMoreBefore,
        hasMoreAfter: merged.added > 0 ? true : data.page.hasMoreAfter,
      };
    }
    state.revealAllowed = data.revealAllowed !== false;
    if (state.view === "trajectory") {
      renderTrajectory({
        preserveScroll: !options.reset && !options.forward,
        scrollToBottom:
          options.reset && !filtersActive() ? true : undefined,
        scrollToTop: options.reset && filtersActive() ? true : undefined,
      });
    } else {
      renderStatistics();
    }
    const loaded = state.events.length;
    setText(
      dom.loadState,
      state.page
        ? `${formatNumber(loaded)} loaded · ${formatNumber(state.page.totalMatched)} matched`
        : "",
    );
  } catch (error) {
    showError(error);
  }
}

async function loadEarlier() {
  if (!state.page?.hasMoreBefore) return;
  await loadEvents({ reset: false });
}

async function loadNewer() {
  if (!state.page?.hasMoreAfter) return;
  await loadEvents({ reset: false, forward: true });
}

async function refreshCurrent() {
  const scrollTop = dom.ledger?.scroller?.scrollTop ?? state.scrollTop;
  const hadEarlier = state.page?.hasMoreAfter === true;
  await loadSessionData({ preserveScroll: hadEarlier, refresh: true });
  if (dom.ledger?.scroller) dom.ledger.scroller.scrollTop = scrollTop;
}

// ---------------------------------------------------------------------------
// Facets and filters
// ---------------------------------------------------------------------------

function buildFacets(analysis) {
  const maps = {
    kinds: new Map(),
    agents: new Map(),
    models: new Map(),
    providers: new Map(),
    tools: new Map(),
    statuses: new Map(),
  };
  const bump = (map, key) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const event of analysis?.events ?? []) {
    bump(maps.kinds, event.kind);
    bump(maps.agents, event.agent);
    if (event.meta?.delegatedAgent) bump(maps.agents, event.meta.delegatedAgent);
    if (event.model) bump(maps.models, `${event.model.providerID}/${event.model.id}`);
    bump(maps.providers, event.provider);
    bump(maps.tools, event.toolName);
    bump(maps.statuses, event.toolStatus ?? event.status);
  }
  const sorted = (map) =>
    [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    kinds: sorted(maps.kinds),
    agents: sorted(maps.agents),
    models: sorted(maps.models),
    providers: sorted(maps.providers),
    tools: sorted(maps.tools),
    statuses: sorted(maps.statuses),
  };
}

function selectOptions(entries, selected, allLabel) {
  const options = [`<option value="">${escapeHtml(allLabel)}</option>`];
  for (const [value, count] of entries) {
    options.push(
      `<option value="${escapeAttr(value)}"${selected.includes(value) ? " selected" : ""}>${escapeHtml(
        value,
      )} (${formatNumber(count)})</option>`,
    );
  }
  return options.join("");
}

function filterBarHtml() {
  const f = state.filters;
  const facets = state.facets ?? {
    kinds: [],
    agents: [],
    models: [],
    providers: [],
    tools: [],
    statuses: [],
  };
  const toolsActive = f.kinds.length === 1 && f.kinds[0] === "tool";
  const advanced = state.viewMode === "advanced" ? "" : " advanced-only";
  const chip = (kind, label, active) =>
    `<button type="button" class="chip${active ? " active" : ""}" data-chip="${kind}" aria-pressed="${active}">${escapeHtml(
      label,
    )}</button>`;
  return `<div class="filter-bar" role="search" aria-label="Event filters">
    <div class="field grow">
      <label for="event-search">Search prompts, outputs and tool payloads</label>
      <input id="event-search" type="search" placeholder="Search events…" value="${escapeAttr(
        f.q,
      )}" autocomplete="off" spellcheck="false">
    </div>
    <div class="field">
      <label for="filter-kind">Kind</label>
      <select id="filter-kind" data-filter="kinds">${selectOptions(
        facets.kinds.filter(([kind]) => eventKinds.includes(kind)),
        f.kinds,
        "All kinds",
      )}</select>
    </div>
    <div class="field${advanced}">
      <label for="filter-agent">Agent</label>
      <select id="filter-agent" data-filter="agents">${selectOptions(
        facets.agents,
        f.agents,
        "All agents",
      )}</select>
    </div>
    <div class="field${advanced}">
      <label for="filter-model">Model</label>
      <select id="filter-model" data-filter="models">${selectOptions(
        facets.models,
        f.models,
        "All models",
      )}</select>
    </div>
    <div class="field${advanced}">
      <label for="filter-provider">Provider</label>
      <select id="filter-provider" data-filter="providers">${selectOptions(
        facets.providers,
        f.providers,
        "All providers",
      )}</select>
    </div>
    <div class="field${advanced}">
      <label for="filter-tool">Tool</label>
      <select id="filter-tool" data-filter="tools">${selectOptions(
        facets.tools,
        f.tools,
        "All tools",
      )}</select>
    </div>
    <div class="field${advanced}">
      <label for="filter-status">Status</label>
      <select id="filter-status" data-filter="statuses">${selectOptions(
        facets.statuses,
        f.statuses,
        "All statuses",
      )}</select>
    </div>
    <div class="field${advanced}">
      <label for="filter-from">From</label>
      <input id="filter-from" type="datetime-local" data-filter="from" value="${escapeAttr(
        f.from,
      )}">
    </div>
    <div class="field${advanced}">
      <label for="filter-to">To</label>
      <input id="filter-to" type="datetime-local" data-filter="to" value="${escapeAttr(
        f.to,
      )}">
    </div>
    <div class="field${advanced}">
      <label for="filter-min-tokens">Min prompt tokens</label>
      <input id="filter-min-tokens" type="number" min="0" step="1" data-filter="minPromptTokens" value="${escapeAttr(
        f.minPromptTokens,
      )}">
    </div>
    <div class="field${advanced}">
      <label for="filter-max-tokens">Max prompt tokens</label>
      <input id="filter-max-tokens" type="number" min="0" step="1" data-filter="maxPromptTokens" value="${escapeAttr(
        f.maxPromptTokens,
      )}">
    </div>
    <div class="filter-actions">
      ${chip("errorsOnly", "Errors", f.errorsOnly)}
      ${chip("tools", "Tools", toolsActive)}
      ${chip("compactionsOnly", "Compactions", f.compactionsOnly)}
      ${chip("retriesOnly", "Retries", f.retriesOnly)}
      ${chip("subagentsOnly", "Subagents", f.subagentsOnly)}
      ${chip("contextOnly", "Context", f.contextOnly)}
      <button type="button" class="btn ghost" id="clear-filters"${
        activeFilterCount() === 0 ? " disabled" : ""
      }>Clear${activeFilterCount() ? ` (${activeFilterCount()})` : ""}</button>
    </div>
  </div>`;
}

function bindFilters() {
  const search = $("#event-search");
  if (search) {
    const onSearch = debounce(() => {
      state.filters.q = search.value;
      void loadEvents({ reset: true });
    }, 260);
    search.addEventListener("input", onSearch);
  }
  for (const element of document.querySelectorAll("[data-filter]")) {
    const key = element.dataset.filter;
    element.addEventListener("change", () => {
      if (element.tagName === "SELECT") {
        state.filters[key] = element.value ? [element.value] : [];
      } else {
        state.filters[key] = element.value;
      }
      void loadEvents({ reset: true });
    });
  }
  for (const chip of document.querySelectorAll("[data-chip]")) {
    chip.addEventListener("click", () => {
      const kind = chip.dataset.chip;
      if (kind === "tools") {
        state.filters.kinds =
          state.filters.kinds.length === 1 && state.filters.kinds[0] === "tool"
            ? []
            : ["tool"];
      } else {
        state.filters[kind] = !state.filters[kind];
      }
      void loadEvents({ reset: true });
    });
  }
  const clear = $("#clear-filters");
  if (clear) {
    clear.addEventListener("click", () => {
      state.filters = defaultFilters();
      void loadEvents({ reset: true });
    });
  }
}

// ---------------------------------------------------------------------------
// Rendering: shell
// ---------------------------------------------------------------------------

function renderLoading() {
  if (!dom.loadState) return;
  setText(dom.loadState, state.loading ? "Loading…" : "");
}

function renderEmpty(title, message = "") {
  if (!dom.view) return;
  dom.view.className = "view";
  dom.view.innerHTML = `<div class="empty"><h3>${escapeHtml(title)}</h3>${
    message ? `<p>${escapeHtml(message)}</p>` : ""
  }<p class="small">Start OpenCode 2 once, or launch this app with <code>--db &lt;path&gt;</code>.</p></div>`;
}

function sessionMatchesQuery(session, query) {
  if (!query) return true;
  return [
    session.title,
    session.id,
    session.slug,
    session.agent,
    session.directory,
    session.projectID,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function projectKey(session) {
  return session.directory || session.projectID || "(no project)";
}

/** Builds parent/child nodes from the flat session list already loaded. */
function buildSessionTree(sessions) {
  const nodes = new Map(
    sessions.map((session) => [
      session.id,
      { session, children: [], depth: 0 },
    ]),
  );
  const roots = [];
  for (const node of nodes.values()) {
    let parent = node.session.parentID ? nodes.get(node.session.parentID) : null;
    // A self-reference or a cycle must not hide sessions from the list.
    const seen = new Set([node.session.id]);
    let cursor = parent;
    while (cursor) {
      if (seen.has(cursor.session.id)) {
        parent = null;
        break;
      }
      seen.add(cursor.session.id);
      cursor = cursor.session.parentID ? nodes.get(cursor.session.parentID) : null;
    }
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (list) =>
    list.sort(
      (a, b) =>
        (a.session.timeCreated ?? 0) - (b.session.timeCreated ?? 0) ||
        String(a.session.id).localeCompare(String(b.session.id)),
    );
  const assignDepth = (node, depth) => {
    node.depth = depth;
    sortNodes(node.children);
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  roots.sort(
    (a, b) =>
      (b.session.timeUpdated ?? b.session.timeCreated ?? 0) -
        (a.session.timeUpdated ?? a.session.timeCreated ?? 0) ||
      String(a.session.id).localeCompare(String(b.session.id)),
  );
  for (const root of roots) assignDepth(root, 0);
  return roots;
}

function sessionItemHtml(session) {
  const totalIn =
    (session.tokens?.input ?? 0) +
    (session.tokens?.cacheRead ?? 0) +
    (session.tokens?.cacheWrite ?? 0);
  return `<button type="button" class="session-item${
    session.id === state.sessionID ? " active" : ""
  }" data-session-id="${escapeAttr(session.id)}" role="option" aria-selected="${
    session.id === state.sessionID
  }">
    <span class="session-title">${escapeHtml(session.title || session.id)}</span>
    <span class="session-meta"><span>${escapeHtml(
      session.agent || "—",
    )}</span><span>${escapeHtml(
      session.model ? `${session.model.providerID}/${session.model.id}` : "—",
    )}</span><span>${escapeHtml(formatRelative(session.timeUpdated ?? session.timeCreated))}</span></span>
    <span class="session-stats">${formatCompact(totalIn)} in · ${formatCompact(
      session.tokens?.output,
    )} out${
      session.cost !== undefined ? ` · ${formatCost(session.cost)}` : ""
    }${session.parentID ? " · subagent" : ""}</span>
  </button>`;
}

function renderSessionNode(node, forceExpand = false) {
  const { session, children, depth } = node;
  const hasChildren = children.length > 0 && state.sessionTree;
  const collapsed = !forceExpand && !state.expandedParents.has(session.id);
  const label = session.title || session.id;
  const toggle = hasChildren
    ? forceExpand
      ? `<span class="tree-toggle expanded" aria-hidden="true"><span class="tree-caret"></span></span>`
      : `<button type="button" class="tree-toggle" data-parent-toggle="${escapeAttr(
          session.id,
        )}" aria-expanded="${!collapsed}" aria-label="${
          collapsed ? "Expand" : "Collapse"
        } ${escapeAttr(label)} children" title="${
          collapsed ? "Expand" : "Collapse"
        } children"><span class="tree-caret"></span></button>`
    : `<span class="tree-toggle placeholder" aria-hidden="true"></span>`;
  const nested = depth > 0 ? " nested" : "";
  const childHtml =
    hasChildren && !collapsed
      ? children
          .map((child) => renderSessionNode(child, forceExpand))
          .join("")
      : "";
  return `<div class="session-node${nested}" style="--depth:${depth}">${toggle}${sessionItemHtml(
    session,
  )}</div>${childHtml}`;
}

function renderSessionList() {
  if (!dom.sessionList) return;
  const query = state.sessionQuery.trim().toLowerCase();
  const searching = query.length > 0;
  const sessions = state.sessions.filter((session) => sessionMatchesQuery(session, query));
  if (sessions.length === 0) {
    dom.sessionList.innerHTML = `<div class="empty"><p>No sessions found.</p></div>`;
    return;
  }

  const groups = new Map();
  for (const session of sessions) {
    const key = state.groupByProject ? projectKey(session) : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }

  dom.sessionList.innerHTML = [...groups.entries()]
    .map(([key, groupSessions]) => {
      const roots = buildSessionTree(groupSessions);
      const body = state.sessionTree
        ? roots.map((node) => renderSessionNode(node, searching)).join("")
        : groupSessions.map((session) => sessionItemHtml(session)).join("");
      if (!state.groupByProject) return body;
      const collapsed = !searching && !state.expandedProjects.has(key);
      const heading = searching
        ? `<div class="project-head" title="${escapeAttr(key)}">
            <span aria-hidden="true">▾</span>
            <span class="project-path">${escapeHtml(key)}</span>
            <span class="project-count">${formatNumber(groupSessions.length)}</span>
          </div>`
        : `<button type="button" class="project-head" data-project-toggle="${escapeAttr(
            key,
          )}" aria-expanded="${!collapsed}" title="${escapeAttr(key)}">
            <span aria-hidden="true">${collapsed ? "▸" : "▾"}</span>
            <span class="project-path">${escapeHtml(key)}</span>
            <span class="project-count">${formatNumber(groupSessions.length)}</span>
          </button>`;
      return `<section class="project-group">
        ${heading}
        ${collapsed ? "" : body}
      </section>`;
    })
    .join("");
}

function renderFamily() {
  if (!dom.family) return;
  const family = state.family;
  if (!family || (!family.parent && family.children.length === 0)) {
    dom.family.hidden = true;
    return;
  }
  dom.family.hidden = false;
  const link = (session, prefix) => {
    if (!session) return "";
    return `<button type="button" class="family-link" data-session-id="${escapeAttr(
      session.id,
    )}">${prefix}${escapeHtml(session.title || session.id)}</button>`;
  };
  dom.family.innerHTML = `<div class="family-title">Session family</div>${link(
    family.parent,
    "↑ ",
  )}${link(
    family.children[0],
    "↳ ",
  )}${family.children
    .slice(1)
    .map((child) => link(child, "↳ "))
    .join("")}`;
}

function renderHeader() {
  if (!dom.sessionHeader) return;
  const analysis = state.analysis;
  const session = state.session;
  if (!analysis || !session) {
    dom.sessionHeader.innerHTML = "";
    return;
  }
  const totals = analysis.totals;
  const title = session.title || session.slug || session.id;
  const scope = totals.scope === "session" ? "Session total" : "Window total";
  const allTiles = [
    {
      id: "turns",
      html: tile("Turns", formatNumber(totals.turns), `${formatNumber(totals.steps)} steps`),
    },
    {
      id: "tokens",
      html: tile(
        "Input tokens",
        formatNumber(totals.tokens.input),
        `out ${formatCompact(totals.tokens.output)} · reas ${formatCompact(
          totals.tokens.reasoning,
        )}`,
      ),
    },
    {
      id: "cache",
      html: tile(
        "Cache",
        metricHtml(totals.cacheHitRate, formatPercent),
        `R ${formatCompact(totals.tokens.cacheRead)} · W ${formatCompact(
          totals.tokens.cacheWrite,
        )}`,
      ),
    },
    {
      id: "cost",
      html: tile("Cost", metricHtml(totals.cost, formatCost), "steps + compactions"),
    },
    {
      id: "model-time",
      html: tile("Model time", metricHtml(totals.modelTime, formatDuration), "created → streamed"),
    },
    {
      id: "tool-time",
      html: tile("Tool time", metricHtml(totals.toolTime, formatDuration), "sum; may overlap"),
    },
    {
      id: "errors",
      html: tile(
        "Errors",
        formatNumber(totals.errors.total),
        `${formatNumber(totals.retries)} retries · ${formatNumber(
          totals.compactions,
        )} compactions`,
      ),
    },
    {
      id: "speed",
      html: tile(
        "Output speed",
        metricHtml(totals.outputSpeed, (value) => `${value.toFixed(1)} tok/s`),
        "output / model time",
      ),
    },
  ];
  const basicTileIds = new Set(["turns", "tokens", "cost", "errors"]);
  const tiles = allTiles
    .filter((item) => state.viewMode === "advanced" || basicTileIds.has(item.id))
    .map((item) => item.html)
    .join("");

  dom.sessionHeader.innerHTML = `<div class="session-headline">
      <div style="flex:1;min-width:220px">
        <h1 class="session-title-main">${escapeHtml(title)}</h1>
        <div class="session-meta">
          <span>Session <code>${escapeHtml(session.id)}</code></span>
          <span>${escapeHtml(session.directory || "—")}</span>
          <span>Agent <code>${escapeHtml(session.agent || "—")}</code></span>
          <span>Model <code>${escapeHtml(modelLabel(session.model))}</code></span>
          <span>Outcome <span class="status ${statusClass(session.outcome)}">${escapeHtml(
            session.outcome || "—",
          )}</span></span>
          <span>Source <code>${escapeHtml(analysis.capabilities.source)}</code></span>
          <span><span class="badge">${escapeHtml(scope)}</span></span>
        </div>
      </div>
    </div>
    <div class="stat-strip">${tiles}</div>`;
}

function tile(label, value, sub = "") {
  return `<div class="stat-tile"><div class="stat-label" title="${escapeAttr(
    label,
  )}">${escapeHtml(label)}</div><div class="stat-value">${value}</div>${
    sub ? `<div class="stat-sub" title="${escapeAttr(sub)}">${escapeHtml(sub)}</div>` : ""
  }</div>`;
}

function renderTabs() {
  for (const tab of document.querySelectorAll(".tab[data-view]")) {
    const selected = tab.dataset.view === state.view;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
}

function renderRevealState() {
  if (!dom.revealToggle) return;
  dom.revealToggle.setAttribute("aria-pressed", String(state.reveal));
  dom.revealToggle.textContent = state.reveal ? "Hide secrets" : "Reveal secrets";
  dom.revealToggle.disabled = !state.revealAllowed;
  dom.revealToggle.title = state.revealAllowed
    ? "Show raw payloads; off by default"
    : "Reveal is disabled by the server";
  if (dom.revealWarning) dom.revealWarning.hidden = !state.reveal;
  if (dom.exportNote) {
    dom.exportNote.textContent = state.reveal
      ? "Raw secrets included in exports"
      : "Redacted by default";
  }
}

function renderView() {
  if (!state.analysis) {
    renderEmpty("No session selected", "Choose a session from the sidebar.");
    return;
  }
  renderTabs();
  if (state.view === "statistics") renderStatistics();
  else renderTrajectory();
}

// ---------------------------------------------------------------------------
// Rendering: Trajectory
// ---------------------------------------------------------------------------

function hasEventSubLine(event) {
  return Boolean(event.agent || event.model || event.tool || event.stepID);
}

function eventSubLine(event) {
  const tool = event.tool;
  return [
    event.agent ? `agent ${escapeHtml(event.agent)}` : "",
    event.model ? escapeHtml(modelLabel(event.model)) : "",
    tool ? `tool ${escapeHtml(tool.name)} (${escapeHtml(tool.status)})` : "",
    event.stepID ? `step ${escapeHtml(event.stepID)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function eventMetrics(event) {
  const tool = event.tool;
  const metrics = [];
  if (event.tokens) {
    const prompt =
      event.tokens.input + event.tokens.cacheRead + event.tokens.cacheWrite;
    metrics.push(`prompt ${formatCompact(prompt)}`);
    metrics.push(`out ${formatCompact(event.tokens.output)}`);
    const rate =
      prompt > 0 ? event.tokens.cacheRead / prompt : null;
    if (rate !== null) metrics.push(`cache ${formatPercent(rate)}`);
  }
  if (tool?.duration?.value !== null && tool?.duration?.value !== undefined) {
    metrics.push(formatDuration(tool.duration.value));
  }
  if (event.cost !== null && event.cost !== undefined) {
    metrics.push(formatCost(event.cost));
  }
  return metrics;
}

function eventRowHeight(event) {
  const lineHeights = [20, 18, 18, 17];
  const present = [
    true,
    hasEventSubLine(event),
    Boolean(event.textPreview),
    eventMetrics(event).length > 0,
  ];
  let height = 16;
  let count = 0;
  for (let index = 0; index < present.length; index++) {
    if (!present[index]) continue;
    height += (count > 0 ? 3 : 0) + lineHeights[index];
    count++;
  }
  return Math.ceil(height + 2);
}

function eventRowHtml(event) {
  const titleBadges = [
    badge(event.kind, event.kind === "error" ? "error" : event.kind === "tool" ? "tool" : "neutral"),
    eventBadges(event),
  ].join("");
  const sub = hasEventSubLine(event) ? eventSubLine(event) : "";
  const metrics = eventMetrics(event);
  return `<button type="button" class="ledger-row${
    event.id === state.selectedEventID ? " selected" : ""
  }${
    state.highlightedDiagnosticEventIDs.has(event.id) ? " diagnostic-highlight" : ""
  }" data-event-id="${escapeAttr(event.id)}" aria-label="${escapeAttr(
    `${event.kind} ${event.title}`,
  )}">
    <div class="row-gutter" title="${
      event.meta?.timestampApproximate ? "Timestamp is approximate; recorded order is exact" : ""
    }">${event.meta?.timestampApproximate ? "~" : ""}${escapeHtml(
      formatTime(event.timestamp),
    )}</div>
    <div class="row-main">
      <div class="row-titleline"><span class="row-title">${escapeHtml(
        event.title,
      )}</span>${titleBadges}</div>
      ${sub ? `<div class="row-sub">${sub}</div>` : ""}
      ${
        event.textPreview
          ? `<div class="row-preview">${escapeHtml(event.meta?.description || event.textPreview)}</div>`
          : ""
      }
      ${metrics.length ? `<div class="row-metrics" title="${escapeAttr(metrics.join(" · "))}">${metrics.map((m) => `<span class="row-metric">${escapeHtml(m)}</span>`).join("")}</div>` : ""}
    </div>
    <div class="row-tail" aria-hidden="true">›</div>
  </button>`;
}

function buildLedgerRows() {
  const byTurn = new Map((state.analysis?.turns ?? []).map((turn) => [turn.id, turn]));
  const rows = [];
  let currentTurn = null;
  let currentStep = null;
  let unattachedHeader = false;
  for (const event of state.events) {
    if (event.turnID !== currentTurn) {
      currentTurn = event.turnID;
      currentStep = null;
      unattachedHeader = false;
      if (event.turnID === null) {
        if (!unattachedHeader) {
          rows.push({ type: "turn", turn: null });
          unattachedHeader = true;
        }
      } else {
        const turn = byTurn.get(event.turnID);
        if (turn) rows.push({ type: "turn", turn });
      }
    }
    if (event.stepID && event.stepID !== currentStep) {
      currentStep = event.stepID;
      const turn = event.turnID ? byTurn.get(event.turnID) : null;
      const step = turn?.steps.find((item) => item.id === event.stepID);
      rows.push({ type: "step", turn, step, stepID: event.stepID });
    }
    if (!event.stepID) currentStep = null;
    rows.push({ type: "event", event, eventID: event.id });
  }
  return rows;
}

function ledgerRowHtml(row) {
  if (row.type === "turn") {
    if (!row.turn) {
      return `<div class="row-turn-header"><span class="turn-index">Unattached</span><span class="turn-trigger">Events not attributable to a turn (preserved in recorded order)</span><span class="turn-spacer"></span>${badge(
        "uncertain",
        "uncertain",
      )}</div>`;
    }
    return `<div class="row-turn-header"><span class="turn-index">Turn ${
      row.turn.index
    }</span><span class="turn-trigger">${escapeHtml(
      row.turn.trigger.label,
    )}</span>${badge(row.turn.trigger.kind, "neutral")}<span class="turn-spacer"></span><span class="status ${statusClass(
      row.turn.status,
    )}">${escapeHtml(row.turn.status)}</span><span class="muted small">${row.turn.steps.length} step(s)</span></div>`;
  }
  if (row.type === "step") {
    const model = row.step?.model ? modelLabel(row.step.model) : "";
    return `<div class="row-step-header"><span class="step-label">Step ${
      row.step?.index ?? "?"
    }</span>${escapeHtml(model)}<span class="turn-spacer"></span><span class="status ${statusClass(
      row.step?.status ?? "",
    )}">${escapeHtml(row.step?.status ?? "?")}</span></div>`;
  }
  return eventRowHtml(row.event);
}

/**
 * DR-2 labels for the four engine recovery states. Anything else (an unknown
 * state from a newer engine, or a missing field) is surfaced as "Unknown"
 * instead of being folded into the real "Insufficient data" verdict.
 */
function recoveryLabel(recoveryState) {
  if (recoveryState === "recovered") return "Recovery observed";
  if (recoveryState === "possible-recovery") return "Possible recovery";
  if (recoveryState === "no-recovery-evidence") return "No recovery evidence";
  if (recoveryState === "insufficient-data") return "Insufficient data";
  return "Unknown";
}

/**
 * Map an engine recovery state onto an existing semantic badge kind.
 * "good" and "accent" are token-only aliases of the existing badge classes;
 * the two evidence-free states use the existing dashed neutral treatment.
 * Unknown states fall through to the same dashed neutral treatment.
 */
function recoveryBadgeKind(recoveryState) {
  if (recoveryState === "recovered") return "good";
  if (recoveryState === "possible-recovery") return "accent";
  return "uncertain";
}

/**
 * One incident card, shared by every view that renders diagnostics.
 * Text-only: `why` and the trigger label are escaped, and the DTO carries no
 * tool input/output to leak.
 */
function diagnosticCardHtml(incident) {
  const tool = incident.tool ?? "—";
  const triggerLabel = incident.trigger?.label ?? "—";
  const openLabel = `Open ${tool} incident in Trajectory`;
  return `<div class="diagnostic-card">
    <div class="diagnostic-head">
      ${badge(tool, "tool")}
      ${badge(recoveryLabel(incident.recovery), recoveryBadgeKind(incident.recovery))}
      <span class="muted small">Turn ${formatNumber(incident.turn)}</span>
      <span class="diagnostic-trigger">${escapeHtml(triggerLabel)}</span>
      <span class="grow"></span>
      <button type="button" class="link-button" data-open-incident data-event-id="${escapeAttr(
        incident.firstFailureEventID,
      )}" aria-label="${escapeAttr(openLabel)}">Open in Trajectory</button>
    </div>
    <div class="diagnostic-grid">
      <div class="diagnostic-stat"><div class="label">Attempts</div><div class="value">${formatNumber(
        incident.attempts,
      )}</div></div>
      <div class="diagnostic-stat"><div class="label">Elapsed (context)</div><div class="value">${metricHtml(
        incident.elapsed,
        formatDuration,
      )}</div></div>
      <div class="diagnostic-stat"><div class="label">Step cost sum (context)</div><div class="value">${metricHtml(
        incident.stepCostSum,
        formatCost,
      )}</div></div>
    </div>
    <p class="small muted diagnostic-why">${escapeHtml(incident.why)}</p>
    <p class="small muted">Footprint values are contextual to this incident; they are not a recovery signal.</p>
  </div>`;
}

/**
 * The card body shared by the Trajectory strip and both Statistics renderers
 * (DR-5): one data source, one card renderer, one empty state.
 */
function diagnosticCardsHtml() {
  const incidents = state.analysis?.diagnostics?.incidents ?? [];
  if (incidents.length === 0) {
    return `<p class="muted small">No diagnostic incidents recorded in this session.</p>`;
  }
  return incidents.map((incident) => diagnosticCardHtml(incident)).join("");
}

function recoveryMapHtml() {
  const incidents = state.analysis?.diagnostics?.incidents ?? [];
  return `<section class="recovery-map" aria-label="Recovery map">
    <div class="recovery-map-head">
      <h2 class="recovery-map-title">Recovery map</h2>
      <span class="muted small">${formatNumber(incidents.length)} incident(s) from the deterministic diagnostics engine</span>
    </div>
    <div class="recovery-cards">${diagnosticCardsHtml()}</div>
  </section>`;
}

/**
 * Statistics section wrapper: the same card body and section rhythm as the
 * existing Compactions section; no Statistics-specific card markup.
 */
function diagnosticsSectionHtml() {
  const incidents = state.analysis?.diagnostics?.incidents ?? [];
  return `<div class="compactions diagnostics-section">
    <h2 class="stats-title">Diagnostics</h2>
    <p class="muted small">${formatNumber(
      incidents.length,
    )} incident(s) from the deterministic diagnostics engine</p>
    <div class="recovery-cards">${diagnosticCardsHtml()}</div>
  </div>`;
}

/**
 * The stored incident anchored at `eventID` (its first failing event), if any.
 * Matching reads only DTO fields; no incident is derived here (DR-1).
 */
function incidentForFirstEvent(eventID) {
  if (!eventID) return null;
  const incidents = state.analysis?.diagnostics?.incidents ?? [];
  return (
    incidents.find((incident) => incident.firstFailureEventID === eventID) ?? null
  );
}

/**
 * Single write path for the diagnostic highlight set. IDs are validated
 * against the session's event index when it is available, so a stale or
 * unknown ID can never mark a row.
 */
function setDiagnosticHighlight(eventIDs = []) {
  const known = new Set((state.analysis?.events ?? []).map((event) => event.id));
  const next = new Set();
  for (const id of eventIDs) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (known.size > 0 && !known.has(id)) continue;
    next.add(id);
  }
  state.highlightedDiagnosticEventIDs = next;
}

/**
 * Rebuild the highlight from the incident that starts at `eventID`.
 * Detail events that match no incident's first failing event clear it.
 */
function applyIncidentHighlight(eventID) {
  const incident = incidentForFirstEvent(eventID);
  setDiagnosticHighlight(incident?.failureEventIDs ?? []);
  return incident;
}

/**
 * Reflect the current set on rows already in the DOM. Rows outside the
 * virtual window re-read the set when they render, so no scroll work is
 * needed beyond this one-shot sync (DR-10).
 */
function syncDiagnosticHighlightDom() {
  if (!dom.view) return;
  for (const row of dom.view.querySelectorAll(".ledger-row[data-event-id]")) {
    row.classList.toggle(
      "diagnostic-highlight",
      state.highlightedDiagnosticEventIDs.has(row.dataset.eventId),
    );
  }
}

function bindRecoveryMap() {
  const map = dom.view?.querySelector(".recovery-map");
  map?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-incident]");
    if (!button) return;
    const eventID = button.dataset.eventId;
    if (eventID) void jumpToEvent(eventID);
  });
}

function renderTrajectory(options = {}) {
  if (!dom.view) return;
  const previousScrollTop =
    state.ledger?.scroller?.scrollTop ?? state.scrollTop ?? 0;
  const previousHeight = state.ledger?.totalHeight ?? 0;
  dom.view.className = "view view-trajectory";
  const total = state.page?.totalMatched ?? state.events.length;
  const all = state.page?.totalInSession ?? total;
  dom.view.innerHTML = `${filterBarHtml()}
    <div class="legend">
      <span>${formatNumber(state.events.length)} loaded · ${formatNumber(
        total,
      )} matched · ${formatNumber(all)} in session</span>
      <span>·</span><span>${badge("M", "neutral")} measured</span><span>${badge(
        "D",
        "neutral",
      )} derived</span><span>${badge("E", "neutral")} estimated</span>
      <span>·</span><span>TTFT, approvals, request headers and tool-set changes are not recorded by OpenCode 2.</span>
    </div>
    ${recoveryMapHtml()}
    <div class="ledger">
      <div class="ledger-scroll" id="ledger-scroll" tabindex="-1"></div>
      <div class="ledger-foot">
        <span class="grow">${
          state.page
            ? `Order: recorded seq${state.page.hasMoreBefore ? " · earlier events available" : ""}`
            : ""
        }</span>
        <button type="button" class="btn ghost" id="load-earlier"${
          state.page?.hasMoreBefore ? "" : " disabled"
        }>Load earlier</button>
        <button type="button" class="btn ghost" id="load-newer"${
          state.page?.hasMoreAfter ? "" : " disabled"
        }>Load newer</button>
        <button type="button" class="btn ghost" id="jump-latest">Jump to latest</button>
      </div>
    </div>`;
  bindFilters();
  bindRecoveryMap();
  const scroller = $("#ledger-scroll");
  const rows = buildLedgerRows();
  if (rows.length === 0) {
    state.ledger = null;
    scroller.innerHTML = `<div class="empty"><h3>No events match</h3><p>Adjust the filters or clear them to see the full session.</p><button type="button" class="btn" id="empty-clear">Clear filters</button></div>`;
    $("#empty-clear")?.addEventListener("click", () => {
      state.filters = defaultFilters();
      void loadEvents({ reset: true });
    });
    bindLedgerFooter();
    return;
  }
  state.ledger?.destroy();
  state.ledger = new VirtualList(scroller, {
    heightFor: (row) =>
      row.type === "turn" ? 46 : row.type === "step" ? 32 : eventRowHeight(row.event),
    renderRow: (row) => ledgerRowHtml(row),
    overscan: 8,
  });
  state.ledger.setRows(rows, {
    scrollToBottom: options.scrollToBottom,
    scrollToTop: options.scrollToTop,
  });
  if (options.preserveScroll) {
    scroller.scrollTop = Math.max(
      0,
      previousScrollTop + (state.ledger.totalHeight - previousHeight),
    );
  } else if (!options.scrollToBottom && !options.scrollToTop) {
    scroller.scrollTop = state.scrollTop;
  }
  scroller.addEventListener(
    "scroll",
    () => {
      state.scrollTop = scroller.scrollTop;
    },
    { passive: true },
  );
  scroller.addEventListener("click", (event) => {
    const target = event.target.closest("[data-event-id]");
    if (!target) return;
    void openDetail(target.dataset.eventId);
  });
  bindLedgerFooter();
}

function bindLedgerFooter() {
  $("#load-earlier")?.addEventListener("click", () => void loadEarlier());
  $("#load-newer")?.addEventListener("click", () => void loadNewer());
  $("#jump-latest")?.addEventListener("click", () => {
    void loadEvents({ reset: true });
    state.ledger?.scrollToBottom();
  });
}

// ---------------------------------------------------------------------------
// Rendering: Statistics
// ---------------------------------------------------------------------------

function contextCell(turn) {
  return state.contextBasis === "cumulative"
    ? metricHtml(turn.promptTokensCumulative, formatNumber)
    : metricHtml(turn.promptTokensLatest, formatNumber);
}

function statisticsRowHtml(turn, expanded) {
  const tokens = turn.tokens;
  const model = turnModelParts(turn);
  return `<tr class="turn-row${expanded ? " expanded" : ""}" data-turn-id="${escapeAttr(
    turn.id,
  )}">
    <td class="mono col-index"><button type="button" class="turn-toggle" aria-label="${
      expanded ? "Collapse" : "Expand"
    } turn ${turn.index}">${expanded ? "▾" : "▸"}</button>${turn.index}</td>
    <td class="col-trigger">${escapeHtml(turn.trigger.label)}</td>
    <td class="mono">${escapeHtml(formatTime(turn.startTime))}<div class="sub-label">→ ${escapeHtml(
      formatTime(turn.endTime),
    )}</div></td>
    <td class="num">${metricHtml(turn.totalTime, formatDuration)}</td>
    <td class="mono">${escapeHtml(model.id)}<div class="sub-label">${escapeHtml(
      `${model.provider}${model.variant ? `#${model.variant}` : ""}`,
    )}</div></td>
    <td class="num">${turn.steps.length}</td>
    <td class="num">${formatNumber(tokens.input)}</td>
    <td class="num">${formatNumber(tokens.output)}</td>
    <td class="num">${formatNumber(tokens.reasoning)}</td>
    <td class="num">${formatNumber(tokens.cacheRead)} / ${formatNumber(tokens.cacheWrite)}</td>
    <td class="num">${metricHtml(turn.cacheHitRate, formatPercent)}</td>
    <td class="num">${contextCell(turn)}</td>
    <td class="num">${metricHtml(turn.contextDelta, (value) =>
      value === null ? "—" : `${value >= 0 ? "+" : ""}${formatNumber(value)}`,
    )}</td>
    <td class="num">${metricHtml(turn.modelTime, formatDuration)}</td>
    <td class="num">${metricHtml(turn.toolTime, formatDuration)}</td>
    <td class="num">${metricHtml(turn.residualTime, formatDuration)}</td>
    <td class="num">${metricHtml(turn.outputSpeed, (value) => `${value.toFixed(1)} tok/s`)}</td>
    <td class="num">${metricHtml(turn.cost, formatCost)}</td>
    <td class="col-status"><span class="status ${statusClass(turn.status)}">${escapeHtml(
      turn.status,
    )}</span>${turn.uncertainty.length ? ` ${badge("!", "uncertain", turn.uncertainty.join(", "))}` : ""}</td>
  </tr>`;
}

function stepRowHtml(turn, step) {
  const expanded = state.expandedSteps.has(`${turn.id}:${step.id}`);
  const model = modelParts(step.model);
  return `<tr class="step-row" data-step-id="${escapeAttr(
    step.id,
  )}" data-turn-id="${escapeAttr(turn.id)}" title="${escapeAttr(
    `Trigger: ${step.trigger}`,
  )}">
    <td class="mono step-cell col-index">${turn.index}.${step.index} ${
      expanded ? "▾" : "▸"
    }</td>
    <td class="col-trigger">${escapeHtml(step.trigger)}${
      step.agent ? `<div class="sub-label">${escapeHtml(step.agent)}</div>` : ""
    }</td>
    <td class="mono">${
      step.startUnknown
        ? '<span class="muted">start unknown</span>'
        : `${escapeHtml(formatTime(step.startTime))}<div class="sub-label">→ ${escapeHtml(
            formatTime(step.endTime),
          )}</div>`
    }</td>
    <td class="num">${metricHtml(step.totalTime, formatDuration)}</td>
    <td class="mono">${escapeHtml(model.id)}<div class="sub-label">${escapeHtml(
      `${model.provider}${model.variant ? `#${model.variant}` : ""}`,
    )}</div></td>
    <td class="num" title="Steps are not nested inside a step">—</td>
    <td class="num">${formatNumber(step.tokens?.input)}</td>
    <td class="num">${formatNumber(step.tokens?.output)}</td>
    <td class="num">${formatNumber(step.tokens?.reasoning)}</td>
    <td class="num">${formatNumber(step.tokens?.cacheRead)} / ${formatNumber(step.tokens?.cacheWrite)}</td>
    <td class="num">${metricHtml(step.cacheHitRate, formatPercent)}</td>
    <td class="num">${metricHtml(step.promptTokens, formatNumber)}</td>
    <td class="num" title="Context delta is computed per turn">—</td>
    <td class="num">${metricHtml(step.modelTime, formatDuration)}</td>
    <td class="num">${metricHtml(step.toolTime, formatDuration)}</td>
    <td class="num">${metricHtml(step.residualTime, formatDuration)}</td>
    <td class="num">${metricHtml(step.outputSpeed, (value) => `${value.toFixed(1)} tok/s`)}</td>
    <td class="num">${
      step.cost === null || step.cost === undefined ? "—" : formatCost(step.cost)
    }</td>
    <td class="col-status"><span class="status ${statusClass(step.status)}">${escapeHtml(
      step.status,
    )}</span> <button type="button" class="jump-link" data-jump-step="${escapeAttr(
      step.eventIDs[0] ?? "",
    )}" title="Open step ${turn.index}.${step.index} in Trajectory" aria-label="Open step ${turn.index}.${step.index} in Trajectory">View</button></td>
  </tr>`;
}

function stepDetailHtml(turn, step, colspan = 19) {
  const hasResponse = (step.responseText || "").trim().length > 0;
  const hasReasoning = (step.reasoningText || "").trim().length > 0;
  const primary = hasResponse ? step.responseText : step.reasoningText;
  const response = renderMarkdown(primary || "", {
    maxChars: state.responseLimit,
  });
  const reasoning =
    hasResponse && hasReasoning
      ? renderMarkdown(step.reasoningText, {
          maxChars: Math.min(12_000, state.responseLimit),
        })
      : null;
  const tools = step.toolCalls.length
    ? step.toolCalls
        .map(
          (tool) => `<div class="tool-mini">
            <div class="tool-mini-head">${badge(tool.status, tool.status === "error" ? "error" : "tool")}<strong>${escapeHtml(
              tool.name,
            )}</strong><span class="muted">${metricHtml(tool.duration, formatDuration)}</span>${
              tool.childSessionIDs.length
                ? tool.childSessionIDs
                    .map(
                      (id) =>
                        `<button type="button" class="link-button" data-session-id="${escapeAttr(
                          id,
                        )}">subagent ${escapeHtml(id)}</button>`,
                    )
                    .join(" ")
                : ""
            }</div>
            ${tool.inputPreview ? `<pre>${escapeHtml(tool.inputPreview)}</pre>` : ""}
            ${tool.outputPreview ? `<pre>${escapeHtml(tool.outputPreview)}</pre>` : ""}
          </div>`,
        )
        .join("")
    : `<p class="muted small">No tool calls in this step.</p>`;
  return `<tr class="step-detail-row"><td colspan="${colspan}"><div class="step-detail">
    <div>
      <h4>${hasResponse ? "Response" : "Reasoning"}${response.truncated ? " (truncated)" : ""}</h4>
      <div class="markdown">${response.html || '<p class="muted">No response text recorded.</p>'}</div>
      ${
        reasoning
          ? `<details><summary>Reasoning</summary><div class="markdown">${reasoning.html}</div></details>`
          : ""
      }
    </div>
    <div>
      <h4>Step facts</h4>
      <dl class="kv">
        <dt>Trigger</dt><dd>${escapeHtml(step.trigger)}</dd>
        <dt>Start</dt><dd>${
          step.startUnknown ? "start unknown" : escapeHtml(formatDateTime(step.startTime))
        }</dd>
        <dt>End</dt><dd>${escapeHtml(formatDateTime(step.endTime))}</dd>
        <dt>Model</dt><dd>${escapeHtml(step.model?.id || "—")}</dd>
        <dt>Provider</dt><dd>${escapeHtml(step.provider || "—")}</dd>
        <dt>TTFT</dt><dd>${metricHtml(step.ttft, formatDuration)}</dd>
        <dt>Finish</dt><dd>${escapeHtml(step.finish || "—")}</dd>
        <dt>Tools</dt><dd>${escapeHtml(step.toolNames.join(", ") || "—")}</dd>
        <dt>Subagents</dt><dd>${escapeHtml(step.subagentSessionIDs.join(", ") || "—")}</dd>
        <dt>Uncertainty</dt><dd>${escapeHtml(step.uncertainty.join(", ") || "—")}</dd>
      </dl>
      <h4>Tool calls</h4>
      <div class="tool-list">${tools}</div>
      <div class="copy-row"><button type="button" class="btn ghost" data-jump-step="${escapeAttr(
        step.eventIDs[0] ?? "",
      )}">Open step in Trajectory</button></div>
    </div>
  </div></td></tr>`;
}

function eventRowStatsHtml(event) {
  return `<tr class="event-row" data-event-id="${escapeAttr(event.id)}">
    <td class="event-cell mono">${escapeHtml(formatTime(event.timestamp))}</td>
    <td>${escapeHtml(event.kind)} ${eventBadges(event)}</td>
    <td colspan="17">${escapeHtml(event.title)}${
      event.textPreview ? ` — ${escapeHtml(event.textPreview)}` : ""
    } <span class="muted small">(not included in turn/step totals)</span></td>
  </tr>`;
}

function totalsRowHtml() {
  const totals = state.analysis.totals;
  const scope = totals.scope === "session" ? "Session total" : "Window total";
  const context = `Final ${metricHtml(
    totals.finalContext,
    formatNumber,
  )} · Cumulative ${metricHtml(totals.cumulativePrompt, formatNumber)}`;
  return `<tr class="total-row">
    <td colspan="5">${escapeHtml(scope)}</td>
    <td class="num">${formatNumber(totals.steps)}</td>
    <td class="num">${formatNumber(totals.tokens.input)}</td>
    <td class="num">${formatNumber(totals.tokens.output)}</td>
    <td class="num">${formatNumber(totals.tokens.reasoning)}</td>
    <td class="num">${formatNumber(totals.tokens.cacheRead)} / ${formatNumber(totals.tokens.cacheWrite)}</td>
    <td class="num">${metricHtml(totals.cacheHitRate, formatPercent)}</td>
    <td class="num">${context}</td>
    <td class="num">—</td>
    <td class="num">${metricHtml(totals.modelTime, formatDuration)}</td>
    <td class="num">${metricHtml(totals.toolTime, formatDuration)}</td>
    <td class="num" title="Active turn time: ${escapeAttr(
      formatDuration(totals.activeTurnTime.value),
    )}">—</td>
    <td class="num">${metricHtml(totals.outputSpeed, (value) => `${value.toFixed(1)} tok/s`)}</td>
    <td class="num">${metricHtml(totals.cost, formatCost)}</td>
    <td class="col-status">${formatNumber(totals.turns)} turns</td>
  </tr>`;
}

function compactionCardsHtml() {
  const compactions = state.analysis.compactions ?? [];
  if (compactions.length === 0) {
    return `<p class="muted small">No compactions recorded in this session.</p>`;
  }
  return compactions
    .map(
      (item, index) => `<div class="compaction-card">
        <div class="compaction-head">
          <strong>Compaction ${index + 1}</strong>
          ${badge(item.status, item.status === "failed" ? "error" : "compaction")}
          ${badge(item.reason || "unknown", "neutral")}
          <span class="muted small">${escapeHtml(formatDateTime(item.timestamp))}</span>
          <span class="grow"></span>
          <button type="button" class="link-button" data-event-id="${escapeAttr(
            item.eventID,
          )}">Open in Trajectory</button>
        </div>
        <div class="compaction-grid">
          <div class="compaction-stat"><div class="label">Context before</div><div class="value">${metricHtml(
            item.contextBefore,
            formatNumber,
          )}</div></div>
          <div class="compaction-stat"><div class="label">Context after</div><div class="value">${metricHtml(
            item.contextAfter,
            formatNumber,
          )}</div></div>
          <div class="compaction-stat"><div class="label">Removed</div><div class="value">${metricHtml(
            item.removedTokens,
            formatNumber,
          )}</div></div>
          <div class="compaction-stat"><div class="label">Summary</div><div class="value">${formatNumber(
            item.summaryChars,
          )} chars</div></div>
          <div class="compaction-stat"><div class="label">Output tokens</div><div class="value">${formatNumber(
            item.tokens?.output,
          )}</div></div>
          <div class="compaction-stat"><div class="label">Cost</div><div class="value">${formatCost(
            item.cost,
          )}</div></div>
          <div class="compaction-stat"><div class="label">Duration</div><div class="value">${metricHtml(
            item.duration,
            formatDuration,
          )}</div></div>
        </div>
        ${item.summaryPreview ? `<p class="small muted">${escapeHtml(item.summaryPreview)}</p>` : ""}
        <p class="small muted">Compaction is a separate transaction, not a step. Its tokens are included in session totals but excluded from turn/step totals.</p>
      </div>`,
    )
    .join("");
}

function basicTurnRowHtml(turn, expanded) {
  const tokens = turn.tokens;
  return `<tr class="turn-row${expanded ? " expanded" : ""}" data-turn-id="${escapeAttr(
    turn.id,
  )}">
    <td class="mono col-index"><button type="button" class="turn-toggle" aria-label="${
      expanded ? "Collapse" : "Expand"
    } turn ${turn.index}">${expanded ? "▾" : "▸"}</button>${turn.index}</td>
    <td class="col-trigger">${escapeHtml(turn.trigger.label)}</td>
    <td class="num">${metricHtml(turn.totalTime, formatDuration)}</td>
    <td class="num">${formatNumber(tokens.input)}</td>
    <td class="num">${formatNumber(tokens.output)}</td>
    <td class="num">${metricHtml(turn.cost, formatCost)}</td>
    <td class="col-status"><span class="status ${statusClass(turn.status)}">${escapeHtml(
      turn.status,
    )}</span>${turn.uncertainty.length ? ` ${badge("!", "uncertain", turn.uncertainty.join(", "))}` : ""}</td>
  </tr>`;
}

function basicStepRowHtml(turn, step) {
  return `<tr class="step-row" data-step-id="${escapeAttr(
    step.id,
  )}" data-turn-id="${escapeAttr(turn.id)}" title="${escapeAttr(
    `Trigger: ${step.trigger}`,
  )}">
    <td class="mono step-cell">${turn.index}.${step.index}</td>
    <td>${escapeHtml(step.agent || "—")}<div class="sub-label">${escapeHtml(
      step.trigger,
    )}</div></td>
    <td class="num">${metricHtml(step.totalTime, formatDuration)}</td>
    <td class="num">${formatNumber(step.tokens?.input)}</td>
    <td class="num">${formatNumber(step.tokens?.output)}</td>
    <td class="num">${
      step.cost === null || step.cost === undefined ? "—" : formatCost(step.cost)
    }</td>
    <td><span class="status ${statusClass(step.status)}">${escapeHtml(
      step.status,
    )}</span> <button type="button" class="jump-link" data-jump-step="${escapeAttr(
      step.eventIDs[0] ?? "",
    )}" title="Open step ${turn.index}.${step.index} in Trajectory" aria-label="Open step ${turn.index}.${step.index} in Trajectory">View</button></td>
  </tr>`;
}

function basicTotalsRowHtml() {
  const totals = state.analysis.totals;
  const scope = totals.scope === "session" ? "Session total" : "Window total";
  return `<tr class="total-row">
    <td colspan="2">${escapeHtml(scope)}</td>
    <td class="num">${metricHtml(totals.wallClockTime, formatDuration)}</td>
    <td class="num">${formatNumber(totals.tokens.input)}</td>
    <td class="num">${formatNumber(totals.tokens.output)}</td>
    <td class="num">${metricHtml(totals.cost, formatCost)}</td>
    <td>${formatNumber(totals.turns)} turns · ${formatNumber(totals.steps)} steps</td>
  </tr>`;
}

function renderStatisticsBasic() {
  const analysis = state.analysis;
  const turnBlocks = [];
  for (const turn of analysis.turns) {
    const expanded = state.expandedTurns.has(turn.id);
    const rows = [basicTurnRowHtml(turn, expanded)];
    if (expanded) {
      for (const step of turn.steps) {
        rows.push(basicStepRowHtml(turn, step));
        if (state.expandedSteps.has(`${turn.id}:${step.id}`)) {
          rows.push(stepDetailHtml(turn, step, 7));
        }
      }
    }
    turnBlocks.push(`<tbody class="turn-block">${rows.join("")}</tbody>`);
  }
  dom.view.innerHTML = `<div class="stats-toolbar">
      <h2 class="stats-title">${analysis.totals.scope === "session" ? "Session total" : "Window total"}</h2>
      <span class="muted small">${formatNumber(analysis.totals.turns)} turns · ${formatNumber(
        analysis.totals.steps,
      )} steps · ${formatNumber(analysis.totals.toolCalls)} tool calls</span>
      <span class="grow"></span>
      <span class="muted small">Basic view · switch to Advanced in the top bar or Settings</span>
      <button type="button" class="btn ghost" id="expand-all">${
        analysis.turns.every((turn) => state.expandedTurns.has(turn.id))
          ? "Collapse all"
          : "Expand all"
      }</button>
    </div>
    <div class="table-wrap">
      <table class="stats-table basic-stats">
        <thead><tr>
          <th>#</th><th>Trigger</th><th class="num">Duration</th>
          <th class="num">In</th><th class="num">Out</th><th class="num">Cost</th><th>Status</th>
        </tr></thead>
        ${turnBlocks.join("")}
        <tbody>${basicTotalsRowHtml()}</tbody>
      </table>
    </div>
    ${diagnosticsSectionHtml()}
    <div class="compactions">
      <h2 class="stats-title">Compactions</h2>
      ${compactionCardsHtml()}
    </div>`;
  bindBasicStatistics();
}

function bindDiagnosticCards() {
  for (const button of dom.view.querySelectorAll("[data-open-incident]")) {
    button.addEventListener("click", (event) => {
      // Incident buttons carry both data attributes; take precedence over the
      // generic single-event binding so jumpToEvent runs exactly once.
      event.preventDefault();
      event.stopPropagation();
      const eventID = button.dataset.eventId;
      if (eventID) void jumpToEvent(eventID);
    });
  }
}

function bindBasicStatistics() {
  $("#expand-all")?.addEventListener("click", () => {
    const turns = state.analysis?.turns ?? [];
    const allOpen = turns.every((turn) => state.expandedTurns.has(turn.id));
    if (allOpen) {
      state.expandedTurns.clear();
      state.expandedSteps.clear();
    } else {
      for (const turn of turns) state.expandedTurns.add(turn.id);
    }
    renderStatistics();
  });
  for (const row of dom.view.querySelectorAll("tr.turn-row")) {
    row.addEventListener("click", () => {
      const turnID = row.dataset.turnId;
      if (state.expandedTurns.has(turnID)) state.expandedTurns.delete(turnID);
      else state.expandedTurns.add(turnID);
      renderStatistics();
    });
  }
  for (const row of dom.view.querySelectorAll("tr.step-row")) {
    row.addEventListener("click", () => {
      const key = `${row.dataset.turnId}:${row.dataset.stepId}`;
      if (state.expandedSteps.has(key)) state.expandedSteps.delete(key);
      else state.expandedSteps.add(key);
      state.expandedTurns.add(row.dataset.turnId);
      renderStatistics();
    });
  }
  for (const button of dom.view.querySelectorAll("[data-jump-step]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void jumpToEvent(button.dataset.jumpStep);
    });
  }
  bindDiagnosticCards();
  for (const element of dom.view.querySelectorAll(
    "[data-event-id]:not([data-open-incident])",
  )) {
    element.addEventListener("click", () => {
      const eventID = element.dataset.eventId;
      if (eventID) void jumpToEvent(eventID);
    });
  }
  for (const element of dom.view.querySelectorAll("[data-session-id]")) {
    element.addEventListener("click", () => {
      void selectSession(element.dataset.sessionId);
    });
  }
}

function renderStatistics() {
  if (!dom.view) return;
  dom.view.className = "view";
  const analysis = state.analysis;
  if (!analysis) {
    renderEmpty("No session selected");
    return;
  }
  if (state.viewMode === "basic") {
    renderStatisticsBasic();
    return;
  }
  const totals = analysis.totals;
  const turnBlocks = [];
  for (const turn of analysis.turns) {
    const expanded = state.expandedTurns.has(turn.id);
    const rows = [statisticsRowHtml(turn, expanded)];
    if (expanded) {
      for (const step of turn.steps) {
        rows.push(stepRowHtml(turn, step));
        if (state.expandedSteps.has(`${turn.id}:${step.id}`)) {
          rows.push(stepDetailHtml(turn, step));
        }
      }
    }
    if (state.showEventRows) {
      const events = analysis.events.filter(
        (event) =>
          event.turnID === turn.id &&
          ["system", "skill", "shell", "compaction", "agent-switched", "model-switched", "location-switched", "synthetic", "retry", "error"].includes(
            event.kind,
          ),
      );
      for (const event of events) rows.push(eventRowStatsHtml(event));
    }
    turnBlocks.push(`<tbody class="turn-block">${rows.join("")}</tbody>`);
  }
  const unattached =
    state.showEventRows
      ? analysis.events.filter((event) => event.turnID === null)
      : [];

  dom.view.innerHTML = `<div class="stats-toolbar">
      <h2 class="stats-title">${totals.scope === "session" ? "Session total" : "Window total"}</h2>
      <span class="muted small">${formatNumber(totals.turns)} turns · ${formatNumber(
        totals.steps,
      )} steps · ${formatNumber(totals.toolCalls)} tool calls · active ${metricHtml(
        totals.activeTurnTime,
        formatDuration,
      )} · wall ${metricHtml(totals.wallClockTime, formatDuration)}</span>
      <span class="grow"></span>
      <label class="field" style="flex-direction:row;align-items:center;gap:6px">Context basis
        <select id="context-basis">
          <option value="latest"${
            state.contextBasis === "latest" ? " selected" : ""
          }>Latest</option>
          <option value="cumulative"${
            state.contextBasis === "cumulative" ? " selected" : ""
          }>Cumulative</option>
        </select>
      </label>
      <label class="switch"><input type="checkbox" id="show-event-rows"${
        state.showEventRows ? " checked" : ""
      }> Show event rows</label>
      <label class="field" style="flex-direction:row;align-items:center;gap:6px">Response limit
        <select id="response-limit">
          ${[4_000, 12_000, 20_000, 50_000, 80_000]
            .map(
              (value) =>
                `<option value="${value}"${
                  state.responseLimit === value ? " selected" : ""
                }>${value / 1_000}k chars</option>`,
            )
            .join("")}
        </select>
      </label>
      <button type="button" class="btn ghost" id="expand-all">${
        analysis.turns.every((turn) => state.expandedTurns.has(turn.id))
          ? "Collapse all"
          : "Expand all"
      }</button>
    </div>
    <div class="table-wrap">
      <table class="stats-table advanced-stats">
        <thead><tr>
          <th class="col-index">#</th><th class="col-trigger">Trigger</th><th>Start</th><th>Duration</th><th>Model</th><th>Steps</th>
          <th class="num">In</th><th class="num">Out</th><th class="num">Reason</th><th class="num">Cache R/W</th>
          <th class="num">Hit</th><th class="num">Context</th><th class="num">Δ context</th>
          <th class="num">Model time</th><th class="num">Tool time</th><th class="num">Residual</th>
          <th class="num">Out/s</th><th class="num">Cost</th><th class="col-status">Status</th>
        </tr></thead>
        ${turnBlocks.join("")}
        <tbody>${totalsRowHtml()}</tbody>
      </table>
    </div>
    <div class="basis-legend">
      <span>${badge("M", "neutral")} measured</span>
      <span>${badge("D", "neutral")} derived</span>
      <span>${badge("E", "neutral")} estimated</span>
      <span>${badge("—", "neutral")} unavailable</span>
      <span>TTFT, approvals, request headers and tool-set changes are not persisted; prompt = input + cache read + cache write.</span>
    </div>
    ${
      totals.recorded
        ? `<div class="basis-legend"><span>Recorded by OpenCode: ${
            totals.recorded.tokens
              ? `in ${formatNumber(totals.recorded.tokens.input)} · out ${formatNumber(
                  totals.recorded.tokens.output,
                )} · cache R/W ${formatNumber(
                  totals.recorded.tokens.cacheRead,
                )}/${formatNumber(totals.recorded.tokens.cacheWrite)}`
              : "tokens unavailable"
          }${totals.recorded.cost !== undefined ? ` · cost ${formatCost(totals.recorded.cost)}` : ""}</span><span class="muted">${escapeHtml(
            totals.recorded.note,
          )}</span></div>`
        : ""
    }
    ${diagnosticsSectionHtml()}
    <div class="compactions">
      <h2 class="stats-title">Compactions</h2>
      ${compactionCardsHtml()}
    </div>
    ${
      unattached.length
        ? `<div class="compactions"><h2 class="stats-title">Unattached events</h2><div class="table-wrap"><table class="stats-table"><thead><tr><th>Time</th><th>Kind</th><th>Event</th></tr></thead><tbody>${unattached
            .map(
              (event) =>
                `<tr class="event-row" data-event-id="${escapeAttr(event.id)}"><td class="mono">${escapeHtml(
                  formatTime(event.timestamp),
                )}</td><td>${escapeHtml(event.kind)}</td><td>${escapeHtml(
                  event.title,
                )} <span class="muted small">(no turn attribution)</span></td></tr>`,
            )
            .join("")}</tbody></table></div></div>`
        : ""
    }`;
  bindStatistics();
}

function bindStatistics() {
  const contextBasis = $("#context-basis");
  contextBasis?.addEventListener("change", () => {
    state.contextBasis = contextBasis.value === "cumulative" ? "cumulative" : "latest";
    setSetting("contextBasis", state.contextBasis);
    renderStatistics();
  });
  const showEvents = $("#show-event-rows");
  showEvents?.addEventListener("change", () => {
    state.showEventRows = showEvents.checked;
    setSetting("showEventRows", state.showEventRows);
    renderStatistics();
  });
  const responseLimit = $("#response-limit");
  responseLimit?.addEventListener("change", () => {
    state.responseLimit = Number(responseLimit.value) || 20_000;
    setSetting("responseLimit", state.responseLimit);
    renderStatistics();
  });
  const expandAll = $("#expand-all");
  expandAll?.addEventListener("click", () => {
    const turns = state.analysis?.turns ?? [];
    const allOpen = turns.every((turn) => state.expandedTurns.has(turn.id));
    if (allOpen) {
      state.expandedTurns.clear();
      state.expandedSteps.clear();
    } else {
      for (const turn of turns) state.expandedTurns.add(turn.id);
    }
    renderStatistics();
  });
  for (const row of dom.view.querySelectorAll("tr.turn-row")) {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button[data-step-id]")) return;
      const turnID = row.dataset.turnId;
      if (state.expandedTurns.has(turnID)) state.expandedTurns.delete(turnID);
      else state.expandedTurns.add(turnID);
      renderStatistics();
    });
  }
  for (const row of dom.view.querySelectorAll("tr.step-row")) {
    row.addEventListener("click", () => {
      const key = `${row.dataset.turnId}:${row.dataset.stepId}`;
      if (state.expandedSteps.has(key)) state.expandedSteps.delete(key);
      else state.expandedSteps.add(key);
      state.expandedTurns.add(row.dataset.turnId);
      renderStatistics();
    });
  }
  for (const button of dom.view.querySelectorAll("[data-jump-step]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void jumpToEvent(button.dataset.jumpStep);
    });
  }
  bindDiagnosticCards();
  for (const element of dom.view.querySelectorAll(
    "[data-event-id]:not([data-open-incident])",
  )) {
    element.addEventListener("click", (event) => {
      if (event.target.closest("button[data-session-id]")) return;
      const eventID = element.dataset.eventId;
      if (!eventID) return;
      void jumpToEvent(eventID);
    });
  }
  for (const element of dom.view.querySelectorAll("[data-session-id]")) {
    element.addEventListener("click", () => {
      void selectSession(element.dataset.sessionId);
    });
  }
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

async function ensureEventLoaded(eventID) {
  if (state.events.some((event) => event.id === eventID)) return true;
  const known = state.analysis?.events.some((event) => event.id === eventID);
  if (!known) return false;
  if (filtersActive()) state.filters = defaultFilters();
  await loadEvents({ reset: true, around: eventID });
  return state.events.some((event) => event.id === eventID);
}

async function jumpToEvent(eventID) {
  if (!eventID) return;
  // Match before the render so the failing-event sequence is highlighted on
  // the first paint of the around-centred page (DR-4).
  applyIncidentHighlight(eventID);
  state.view = "trajectory";
  renderTabs();
  updateHash();
  await ensureEventLoaded(eventID);
  renderTrajectory({ scrollToBottom: false });
  state.ledger?.scrollToEvent(eventID);
  await openDetail(eventID);
}

async function openDetail(eventID) {
  if (!state.sessionID) return;
  if (dom.drawer.hidden) {
    const active = document.activeElement;
    state.drawerOpener =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }
  try {
    await ensureEventLoaded(eventID);
    const data = await api(
      `/api/sessions/${encodeURIComponent(
        state.sessionID,
      )}/events/${encodeURIComponent(eventID)}`,
    );
    state.detailEvent = data.event;
    state.selectedEventID = eventID;
    // An unrelated detail open must clear a stale incident range; an incident
    // first-event open rebuilds it from the DTO (DR-1/DR-4).
    applyIncidentHighlight(eventID);
    renderDrawer(data.event);
    dom.drawer.hidden = false;
    dom.drawerBackdrop.hidden = false;
    updateHash();
    dom.drawer.querySelector(".drawer-close")?.focus();
    if (state.view === "trajectory") {
      syncDiagnosticHighlightDom();
      for (const row of document.querySelectorAll(".ledger-row.selected")) {
        row.classList.remove("selected");
      }
      document
        .querySelector(`.ledger-row[data-event-id="${CSS.escape(eventID)}"]`)
        ?.classList.add("selected");
    }
  } catch (error) {
    showError(error);
  }
}

function closeDrawer() {
  if (!dom.drawer || dom.drawer.hidden) return;
  const opener = state.drawerOpener;
  const eventID = state.selectedEventID;
  state.drawerOpener = null;
  dom.drawer.hidden = true;
  if (dom.drawerBackdrop) dom.drawerBackdrop.hidden = true;
  state.detailEvent = null;
  state.selectedEventID = null;
  updateHash();
  const row = eventID
    ? document.querySelector(`.ledger-row[data-event-id="${CSS.escape(eventID)}"]`)
    : null;
  const target = opener?.isConnected ? opener : row ?? $("#ledger-scroll");
  if (target instanceof HTMLElement) target.focus();
}

function compactionFor(eventID) {
  return state.analysis?.compactions.find((item) => item.eventID === eventID) ?? null;
}

function renderToolDiff(tool) {
  const metadata = tool.metadata;
  if (!metadata || typeof metadata !== "object") return "";
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const patches = files
    .map((file) =>
      file && typeof file === "object"
        ? typeof file.patch === "string"
          ? file.patch
          : null
        : null,
    )
    .filter((patch) => typeof patch === "string");
  if (patches.length === 0) return "";
  return `<h4>Diff</h4><pre class="diff">${escapeHtml(patches.join("\n"))}</pre>`;
}

function drawerHtml(event) {
  const compaction = compactionFor(event.id);
  const tool = event.tool;
  const payload = event.payload === null || event.payload === undefined
    ? ""
    : typeof event.payload === "string"
      ? event.payload
      : JSON.stringify(event.payload, null, 2);
  const text = event.text ?? "";
  const meta = event.meta ?? {};
  const metaEntries = [
    ["Event ID", event.id, true],
    ["Message ID", event.messageID, true],
    ["Session", event.sessionID, true],
    ["Seq / order", `${event.seq} / ${event.order}`, true],
    ["Turn", event.turnID || "unattached", true],
    ["Timestamp", formatDateTime(event.timestamp), true],
    ["Step", event.stepID],
    ["Agent", event.agent],
    ["Model", event.model ? modelLabel(event.model) : ""],
    ["Provider", event.provider],
    ["Status", event.status],
    ["End", event.endTimestamp ? formatDateTime(event.endTimestamp) : ""],
    ["Duration", event.endTimestamp ? formatDuration(event.endTimestamp - event.timestamp) : ""],
    ["Tokens", event.tokens ? JSON.stringify(event.tokens) : ""],
    ["Cost", event.cost === null || event.cost === undefined ? "" : formatCost(event.cost)],
    ["Uncertainty", event.uncertainty.length ? event.uncertainty.join(", ") : ""],
  ];
  const presentMeta = metaEntries.filter(
    ([, value, always]) =>
      always ||
      (value !== null && value !== undefined && String(value).trim() !== "" && value !== "—"),
  );
  const missingLabels = metaEntries
    .filter((entry) => !presentMeta.includes(entry))
    .map(([label]) => label);
  const metaRows = presentMeta
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join("");
  const missingMeta = missingLabels.length
    ? `<details class="drawer-missing"><summary>Not recorded (${missingLabels.length})</summary><ul>${missingLabels
        .map((label) => `<li>${escapeHtml(label)}</li>`)
        .join("")}</ul></details>`
    : "";

  const toolSection = tool
    ? `<div class="drawer-section"><h3>Tool call</h3>
        <div class="tool-box">
          <div class="tool-box-head">${badge(
            tool.status,
            tool.status === "error" ? "error" : "tool",
          )}<h4>${escapeHtml(tool.name)}</h4><span class="muted small">${escapeHtml(
            tool.callID,
          )}</span><span class="muted small">${metricHtml(tool.duration, formatDuration)}</span></div>
          <div class="copy-row"><button type="button" class="btn ghost" data-copy-el="tool-input">Copy input</button><button type="button" class="btn ghost" data-copy-el="tool-output">Copy output</button></div>
          <h4>Input</h4><pre id="tool-input">${escapeHtml(
            JSON.stringify(tool.input, null, 2),
          )}</pre>
          <h4>Output</h4><pre id="tool-output">${escapeHtml(tool.output ?? "—")}</pre>
          ${
            tool.error
              ? `<h4>Error</h4><pre>${escapeHtml(JSON.stringify(tool.error, null, 2))}</pre>`
              : ""
          }
          ${
            tool.outputTruncated
              ? `<p class="small muted">The recorded tool output was truncated by OpenCode.</p>`
              : ""
          }
          ${
            tool.childSessionIDs.length
              ? `<h4>Subagent sessions</h4>${tool.childSessionIDs
                  .map(
                    (id) =>
                      `<button type="button" class="link-button" data-session-id="${escapeAttr(
                        id,
                      )}">${escapeHtml(id)}</button>`,
                  )
                  .join(" ")}`
              : ""
          }
          ${
            tool.metadata
              ? `<details><summary>Metadata</summary><pre>${escapeHtml(
                  JSON.stringify(tool.metadata, null, 2),
                )}</pre></details>`
              : ""
          }
          ${renderToolDiff(tool)}
        </div></div>`
    : "";

  const compactionSection = compaction
    ? `<div class="drawer-section"><h3>Compaction transaction</h3><dl class="kv">
        <dt>Status</dt><dd>${escapeHtml(compaction.status)}</dd>
        <dt>Reason</dt><dd>${escapeHtml(compaction.reason || "—")}</dd>
        <dt>Context before</dt><dd>${metricHtml(compaction.contextBefore, formatNumber)}</dd>
        <dt>Context after</dt><dd>${metricHtml(compaction.contextAfter, formatNumber)}</dd>
        <dt>Removed</dt><dd>${metricHtml(compaction.removedTokens, formatNumber)}</dd>
        <dt>Summary size</dt><dd>${formatNumber(compaction.summaryChars)} chars</dd>
        <dt>Output tokens</dt><dd>${formatNumber(compaction.tokens?.output)}</dd>
        <dt>Cost</dt><dd>${formatCost(compaction.cost)}</dd>
        <dt>Duration</dt><dd>${metricHtml(compaction.duration, formatDuration)}</dd>
      </dl><p class="small muted">Compaction is not a normal step; its usage is excluded from turn/step totals.</p></div>`
    : "";

  return `<div class="drawer-head">
      <div class="grow">
        <div class="drawer-title">${escapeHtml(event.title)}</div>
        <div class="drawer-sub">${escapeHtml(event.kind)} · ${escapeHtml(
          formatDateTime(event.timestamp),
        )}${
          event.status
            ? ` · <span class="status ${statusClass(event.status)}">${escapeHtml(
                event.status,
              )}</span>`
            : ""
        } ${eventBadges(event)}</div>
      </div>
      <button type="button" class="icon-btn drawer-close" aria-label="Close detail">×</button>
    </div>
    <div class="drawer-body">
      <div class="copy-row">
        <button type="button" class="btn ghost" data-copy-el="detail-payload">Copy JSON</button>
        <button type="button" class="btn ghost" data-copy-el="detail-text">Copy text</button>
        <button type="button" class="btn ghost" data-copy-metrics>Copy metrics</button>
        <button type="button" class="btn ghost" data-copy-turn>Copy turn chain</button>
        ${
          compaction
            ? `<button type="button" class="btn ghost" data-jump-event="${escapeAttr(
                compaction.eventID,
              )}">Show in Trajectory</button>`
            : ""
        }
      </div>
      <div class="drawer-section"><h3>Event</h3><dl class="kv">${metaRows}</dl>${missingMeta}</div>
      ${
        text
          ? `<div class="drawer-section"><h3>Text</h3><pre id="detail-text">${escapeHtml(
              text,
            )}</pre></div>`
          : `<pre id="detail-text" hidden></pre>`
      }
      ${toolSection}
      ${compactionSection}
      <div class="drawer-section"><h3>Payload</h3><details open><summary>Raw event payload (redacted unless reveal is on)</summary><pre id="detail-payload">${escapeHtml(
        payload || "—",
      )}</pre></details></div>
    </div>`;
}

function renderDrawer(event) {
  if (!dom.drawer) return;
  dom.drawer.innerHTML = drawerHtml(event);
  dom.drawer.querySelector(".drawer-close")?.addEventListener("click", closeDrawer);
  for (const button of dom.drawer.querySelectorAll("[data-copy-el]")) {
    button.addEventListener("click", async () => {
      const element = document.getElementById(button.dataset.copyEl);
      const text = element?.textContent ?? "";
      const ok = await copyText(text);
      toast(ok ? "Copied" : "Copy failed");
    });
  }
  dom.drawer.querySelector("[data-copy-metrics]")?.addEventListener("click", async () => {
    const event = state.detailEvent;
    if (!event) return;
    const tokens = event.tokens;
    const prompt = tokens
      ? tokens.input + tokens.cacheRead + tokens.cacheWrite
      : null;
    const line = [
      `event=${event.id}`,
      `turn=${event.turnID ?? ""}`,
      `step=${event.stepID ?? ""}`,
      `kind=${event.kind}`,
      `status=${event.status ?? ""}`,
      `prompt=${prompt ?? ""}`,
      `input=${tokens?.input ?? ""}`,
      `output=${tokens?.output ?? ""}`,
      `reasoning=${tokens?.reasoning ?? ""}`,
      `cache_read=${tokens?.cacheRead ?? ""}`,
      `cache_write=${tokens?.cacheWrite ?? ""}`,
      `cost=${event.cost ?? ""}`,
      `duration_ms=${
        event.endTimestamp !== null && event.endTimestamp !== undefined
          ? event.endTimestamp - event.timestamp
          : ""
      }`,
    ].join("\t");
    toast((await copyText(line)) ? "Metrics copied" : "Copy failed");
  });
  dom.drawer.querySelector("[data-copy-turn]")?.addEventListener("click", async () => {
    const event = state.detailEvent;
    if (!event) return;
    if (!event.turnID) {
      toast("This event has no turn attribution.");
      return;
    }
    const events =
      state.analysis?.events.filter((item) => item.turnID === event.turnID) ?? [];
    const text = events
      .map((item) =>
        [
          formatTime(item.timestamp),
          item.kind,
          item.title,
          item.status ?? "",
          item.toolName ?? "",
          item.preview ?? "",
        ].join("\t"),
      )
      .join("\n");
    toast((await copyText(text)) ? "Turn chain copied" : "Copy failed");
  });
  for (const button of dom.drawer.querySelectorAll("[data-session-id]")) {
    button.addEventListener("click", () => {
      closeDrawer();
      void selectSession(button.dataset.sessionId);
    });
  }
  for (const button of dom.drawer.querySelectorAll("[data-jump-event]")) {
    button.addEventListener("click", () => {
      closeDrawer();
      state.view = "trajectory";
      renderTabs();
      updateHash();
      renderTrajectory({ scrollToBottom: false });
      state.ledger?.scrollToEvent(button.dataset.jumpEvent);
    });
  }
}

// ---------------------------------------------------------------------------
// Export / reveal / theme / shortcuts / live
// ---------------------------------------------------------------------------

async function exportCurrent(format) {
  if (!state.sessionID) return;
  try {
    const url = new URL(
      `/api/sessions/${encodeURIComponent(state.sessionID)}/export`,
      location.origin,
    );
    url.searchParams.set("format", format);
    url.searchParams.set("includeEvents", "1");
    if (state.reveal) url.searchParams.set("reveal", "1");
    const response = await fetch(url, {
      cache: "no-store",
      headers: authHeaders(state.token),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ApiError(
        response.status,
        body?.error ?? "export_failed",
        body?.message ?? `Export failed (${response.status})`,
      );
    }
    const blob = await response.blob();
    const fallback = `session.${format === "markdown" ? "md" : format}`;
    const filename = parseFilename(
      response.headers.get("Content-Disposition"),
      fallback,
    );
    downloadBlob(filename, blob);
    toast(
      state.reveal
        ? "Exported with raw secrets"
        : "Exported (credentials redacted)",
    );
  } catch (error) {
    showError(error);
  }
}

async function toggleReveal() {
  if (!state.revealAllowed) {
    toast("Reveal is disabled by the server (start it with --reveal).");
    return;
  }
  if (!state.reveal) {
    const confirmed = await askConfirm({
      title: "Reveal raw payloads?",
      message:
        "API keys, tokens and credentials may appear on screen and in exports. Turn reveal off when you are finished.",
      acceptLabel: "Reveal secrets",
    });
    if (!confirmed) return;
  }
  state.reveal = !state.reveal;
  renderRevealState();
  await loadSessions(state.sessionQuery);
  await loadSessionData({ preserveScroll: true });
  if (state.detailEvent) await openDetail(state.detailEvent.id);
}

function applyStoredTheme() {
  migrate();
  // A TUI deep link may carry the exact resolved OpenCode palette (and the
  // theme name as a fallback). It only wins until the user picks a theme here.
  const hash = window.location.hash;
  const linkedPalette = readPaletteFromHash(hash);
  const linkedTheme = readThemeFromHash(hash);
  const userSet = get("themeUserSet") === true;
  if (!userSet && linkedPalette) {
    applyPalette(linkedPalette);
    setSetting("palette", linkedPalette);
    setTheme("opencode-current", false);
    return;
  }
  if (!userSet && linkedTheme) {
    setTheme(linkedTheme, false);
    return;
  }
  if (!userSet && get("palette")) {
    setTheme("opencode-current", false);
    return;
  }
  applyTheme(getTheme());
}

function renderViewModeState() {
  applyViewMode(state.viewMode);
  for (const button of document.querySelectorAll("[data-view-mode-option]")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.viewModeOption === state.viewMode),
    );
  }
}

function setMode(mode) {
  const next = mode === "advanced" ? "advanced" : "basic";
  if (state.viewMode === next) return;
  state.viewMode = setViewMode(next);
  renderViewModeState();
  renderHeader();
  if (state.sessionID) {
    // Advanced filters may be hidden but still present in state; reloading
    // applies only the filters the new mode actually shows.
    void loadEvents({ reset: true });
  } else {
    renderView();
  }
}

function toggleShortcuts(force) {
  if (!dom.shortcuts) return;
  const show = force ?? dom.shortcuts.hidden;
  if (show === !dom.shortcuts.hidden) return;
  if (show) {
    state.shortcutsOpener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dom.shortcuts.hidden = false;
    dom.shortcuts.querySelector(".modal-close")?.focus();
    return;
  }
  dom.shortcuts.hidden = true;
  const opener = state.shortcutsOpener;
  state.shortcutsOpener = null;
  if (opener?.isConnected) opener.focus();
}

let confirmResolve = null;

function askConfirm({ title, message, acceptLabel = "Continue", danger = true }) {
  if (!dom.confirm) return Promise.resolve(false);
  if (confirmResolve) {
    const previous = confirmResolve;
    confirmResolve = null;
    previous(false);
  }
  state.confirmOpener =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleElement = $("#confirm-title");
  const messageElement = $("#confirm-message");
  const accept = $("#confirm-accept");
  if (titleElement) titleElement.textContent = title;
  if (messageElement) messageElement.textContent = message;
  if (accept) {
    accept.textContent = acceptLabel;
    accept.classList.toggle("danger", danger);
  }
  dom.confirm.hidden = false;
  accept?.focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function settleConfirm(value) {
  if (!dom.confirm || dom.confirm.hidden) return;
  dom.confirm.hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(value);
  const opener = state.confirmOpener;
  state.confirmOpener = null;
  if (opener?.isConnected) opener.focus();
}

function selectOptionsHtml(entries, selected) {
  return entries
    .map(
      (entry) =>
        `<option value="${escapeAttr(entry.id)}"${
          entry.id === selected ? " selected" : ""
        }>${escapeHtml(entry.label)}</option>`,
    )
    .join("");
}

function renderSettingsForm() {
  if (!dom.settingsBody) return;
  const theme = getTheme();
  const themes = THEMES.filter(
    (entry) => entry.id !== "opencode-current" || get("palette"),
  );
  const viewMode = getViewMode();
  const responseLimit = responseLimitSetting();
  dom.settingsBody.innerHTML = `<div class="settings-group">
      <h3>Appearance</h3>
      <div class="settings-field">
        <label for="setting-theme">Theme</label>
        <select id="setting-theme" data-setting="theme">${selectOptionsHtml(themes, theme)}</select>
      </div>
      <div class="settings-field">
        <label for="setting-view-mode">View mode</label>
        <select id="setting-view-mode" data-setting="viewMode">${selectOptionsHtml(
          VIEW_MODES,
          viewMode,
        )}</select>
      </div>
    </div>
    <div class="settings-group">
      <h3>Sessions</h3>
      <label class="switch"><input type="checkbox" data-setting="groupByProject"${
        get("groupByProject") !== false ? " checked" : ""
      }> Group sessions by project path</label>
      <label class="switch"><input type="checkbox" data-setting="sessionTree"${
        get("sessionTree") !== false ? " checked" : ""
      }> Nest child sessions under parents</label>
    </div>
    <div class="settings-group">
      <h3>Statistics</h3>
      <div class="settings-field">
        <label for="setting-context-basis">Context basis</label>
        <select id="setting-context-basis" data-setting="contextBasis">
          <option value="latest"${state.contextBasis === "latest" ? " selected" : ""}>Latest</option>
          <option value="cumulative"${
            state.contextBasis === "cumulative" ? " selected" : ""
          }>Cumulative</option>
        </select>
      </div>
      <div class="settings-field">
        <label for="setting-response-limit">Response limit</label>
        <select id="setting-response-limit" data-setting="responseLimit">
          ${[4_000, 12_000, 20_000, 50_000, 80_000]
            .map(
              (value) =>
                `<option value="${value}"${
                  responseLimit === value ? " selected" : ""
                }>${value / 1_000}k chars</option>`,
            )
            .join("")}
        </select>
      </div>
      <label class="switch"><input type="checkbox" data-setting="showEventRows"${
        state.showEventRows ? " checked" : ""
      }> Show event rows in Statistics</label>
    </div>
    <div class="settings-actions">
      <button type="button" class="btn ghost" id="settings-reset">Restore defaults</button>
      <button type="button" class="btn" data-close-settings>Done</button>
    </div>`;
  bindSettingsForm();
}

function bindSettingsForm() {
  for (const element of dom.settingsBody.querySelectorAll("[data-setting]")) {
    element.addEventListener("change", () => {
      const key = element.dataset.setting;
      const value =
        element.type === "checkbox" ? element.checked : element.value;
      if (key === "theme") {
        setTheme(value, true);
      } else {
        setSetting(key, value);
      }
      applySettingToState(key, value);
    });
  }
  $("#settings-reset")?.addEventListener("click", () => {
    resetSettings();
    state.viewMode = "basic";
    state.contextBasis = "latest";
    state.responseLimit = 20_000;
    state.showEventRows = false;
    state.groupByProject = true;
    state.sessionTree = true;
    state.expandedProjects.clear();
    state.expandedParents.clear();
    renderViewModeState();
    renderSettingsForm();
    renderHeader();
    renderSessionList();
    renderView();
    if (state.sessionID) void loadEvents({ reset: true });
    toast("Settings restored to defaults");
  });
}

function applySettingToState(key, value) {
  if (key === "viewMode") {
    setMode(value);
    return;
  }
  if (key === "contextBasis") {
    state.contextBasis = value === "cumulative" ? "cumulative" : "latest";
    if (state.view === "statistics") renderStatistics();
    return;
  }
  if (key === "responseLimit") {
    const selected = Number(value);
    state.responseLimit = [4_000, 12_000, 20_000, 50_000, 80_000].includes(selected)
      ? selected
      : 20_000;
    if (state.view === "statistics") renderStatistics();
    return;
  }
  if (key === "showEventRows") {
    state.showEventRows = value === true;
    if (state.view === "statistics") renderStatistics();
    return;
  }
  if (key === "groupByProject") {
    state.groupByProject = value !== false;
    renderSessionList();
    return;
  }
  if (key === "sessionTree") {
    state.sessionTree = value !== false;
    renderSessionList();
  }
}

function openSettings() {
  if (!dom.settings) return;
  state.settingsOpener =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  renderSettingsForm();
  dom.settings.hidden = false;
  dom.settings.querySelector(".modal-close")?.focus();
}

function closeSettings() {
  if (!dom.settings || dom.settings.hidden) return;
  dom.settings.hidden = true;
  state.settingsOpener?.focus?.();
  state.settingsOpener = null;
}

function trapFocus(event, container) {
  const focusable = [...container.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!container.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function toggleLive() {
  if (state.liveTimer) {
    clearInterval(state.liveTimer);
    state.liveTimer = null;
  }
  if (dom.liveToggle?.checked) {
    state.liveTimer = setInterval(() => {
      if (document.visibilityState === "visible" && !state.loading) {
        void refreshCurrent();
      }
    }, 10_000);
  }
}

// ---------------------------------------------------------------------------
// Routing and events
// ---------------------------------------------------------------------------

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === "s" && parts[1]) {
    return {
      sessionID: decodeURIComponent(parts[1]),
      view: parts[2] === "statistics" ? "statistics" : "trajectory",
      eventID: params.get("event"),
    };
  }
  return { sessionID: null, view: "trajectory", eventID: null };
}

function updateHash() {
  if (!state.sessionID) return;
  const base = `#/s/${encodeURIComponent(state.sessionID)}/${state.view}`;
  const suffix =
    state.detailEvent?.id ? `?event=${encodeURIComponent(state.detailEvent.id)}` : "";
  if (location.hash !== base + suffix) {
    history.replaceState(null, "", base + suffix);
  }
}

async function onHashChange() {
  const route = parseHash();
  if (!route.sessionID) return;
  if (route.sessionID !== state.sessionID) {
    await selectSession(route.sessionID, route.view, route.eventID);
  } else {
    state.view = route.view;
    if (route.eventID) applyIncidentHighlight(route.eventID);
    renderTabs();
    renderView();
    if (route.eventID) {
      await ensureEventLoaded(route.eventID);
      state.ledger?.scrollToEvent(route.eventID);
      await openDetail(route.eventID);
    }
  }
}

function bindStaticEvents() {
  dom.sessionList?.addEventListener("click", (event) => {
    const parent = event.target.closest("[data-parent-toggle]");
    if (parent) {
      const id = parent.dataset.parentToggle;
      if (state.expandedParents.has(id)) state.expandedParents.delete(id);
      else state.expandedParents.add(id);
      setSetting("expandedParents", [...state.expandedParents]);
      renderSessionList();
      dom.sessionList
        .querySelector(`[data-parent-toggle="${CSS.escape(id)}"]`)
        ?.focus();
      return;
    }
    const project = event.target.closest("[data-project-toggle]");
    if (project) {
      const key = project.dataset.projectToggle;
      if (state.expandedProjects.has(key)) state.expandedProjects.delete(key);
      else state.expandedProjects.add(key);
      setSetting("expandedProjects", [...state.expandedProjects]);
      renderSessionList();
      dom.sessionList
        .querySelector(`[data-project-toggle="${CSS.escape(key)}"]`)
        ?.focus();
      return;
    }
    const item = event.target.closest("[data-session-id]");
    if (!item) return;
    void selectSession(item.dataset.sessionId);
  });
  dom.family?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-session-id]");
    if (!item) return;
    void selectSession(item.dataset.sessionId);
  });
  const search = $("#session-search");
  if (search) {
    search.addEventListener(
      "input",
      debounce(() => void loadSessions(search.value), 220),
    );
  }
  for (const tab of document.querySelectorAll(".tab[data-view]")) {
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      updateHash();
      renderTabs();
      renderView();
    });
  }
  $("#refresh")?.addEventListener("click", () => void refreshCurrent());
  dom.liveToggle?.addEventListener("change", toggleLive);
  dom.revealToggle?.addEventListener("click", () => void toggleReveal());
  $("#settings-btn")?.addEventListener("click", openSettings);
  for (const button of document.querySelectorAll("[data-view-mode-option]")) {
    button.addEventListener("click", () => setMode(button.dataset.viewModeOption));
  }
  dom.settings?.addEventListener("click", (event) => {
    if (event.target === dom.settings || event.target.closest("[data-close-settings]")) {
      closeSettings();
    }
  });
  $("#sidebar-toggle")?.addEventListener("click", () =>
    dom.shell?.classList.toggle("sidebar-open"),
  );
  $("#shortcuts-btn")?.addEventListener("click", () => toggleShortcuts(true));
  $("#shortcuts")?.addEventListener("click", (event) => {
    if (event.target === dom.shortcuts || event.target.closest("[data-close-shortcuts]")) {
      toggleShortcuts(false);
    }
  });
  dom.confirm?.addEventListener("click", (event) => {
    if (event.target === dom.confirm) {
      settleConfirm(false);
      return;
    }
    const button = event.target.closest("[data-confirm]");
    if (!button) return;
    settleConfirm(button.dataset.confirm === "accept");
  });
  dom.exportBtn?.addEventListener("click", () => {
    const open = dom.exportMenu.hidden;
    dom.exportMenu.hidden = !open;
    dom.exportBtn.setAttribute("aria-expanded", String(open));
  });
  dom.exportMenu?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-export]");
    if (!button) return;
    dom.exportMenu.hidden = true;
    dom.exportBtn.setAttribute("aria-expanded", "false");
    void exportCurrent(button.dataset.export);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu") && dom.exportMenu && !dom.exportMenu.hidden) {
      dom.exportMenu.hidden = true;
      dom.exportBtn?.setAttribute("aria-expanded", "false");
    }
  });
  dom.drawerBackdrop?.addEventListener("click", closeDrawer);
  window.addEventListener("hashchange", () => void onHashChange());
  window.addEventListener("keydown", onKeyDown);
}

function onKeyDown(event) {
  if (!dom.confirm?.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      settleConfirm(false);
    } else if (event.key === "Tab") {
      trapFocus(event, dom.confirm);
    }
    return;
  }
  if (!dom.settings?.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSettings();
    } else if (event.key === "Tab") {
      trapFocus(event, dom.settings);
    }
    return;
  }
  if (!dom.shortcuts?.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      toggleShortcuts(false);
    } else if (event.key === "?") {
      event.preventDefault();
      toggleShortcuts(false);
    } else if (event.key === "Tab") {
      trapFocus(event, dom.shortcuts);
    }
    return;
  }
  if (!dom.drawer?.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
    } else if (event.key === "Tab") {
      trapFocus(event, dom.drawer);
    }
    return;
  }
  const target = event.target;
  const typing =
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "SELECT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable);

  if (event.key === "Escape") {
    dom.shell?.classList.remove("sidebar-open");
    return;
  }
  if (typing) return;
  if (event.key === "?") {
    event.preventDefault();
    toggleShortcuts();
    return;
  }
  if (event.key === "/") {
    event.preventDefault();
    state.view = "trajectory";
    renderTabs();
    renderView();
    $("#event-search")?.focus();
    return;
  }
  if (event.key === "1") {
    state.view = "trajectory";
    updateHash();
    renderTabs();
    renderView();
    return;
  }
  if (event.key === "2") {
    state.view = "statistics";
    updateHash();
    renderTabs();
    renderView();
    return;
  }
  const toggleMap = {
    e: "errorsOnly",
    c: "compactionsOnly",
    r: "retriesOnly",
    s: "subagentsOnly",
  };
  if (toggleMap[event.key]) {
    state.filters[toggleMap[event.key]] = !state.filters[toggleMap[event.key]];
    state.view = "trajectory";
    renderTabs();
    void loadEvents({ reset: true, preserveScroll: false });
    return;
  }
  if (event.key === "t") {
    const active = state.filters.kinds.length === 1 && state.filters.kinds[0] === "tool";
    state.filters.kinds = active ? [] : ["tool"];
    state.view = "trajectory";
    renderTabs();
    void loadEvents({ reset: true, preserveScroll: false });
    return;
  }
  if (state.view === "trajectory" && (event.key === "j" || event.key === "k")) {
    event.preventDefault();
    const index = state.events.findIndex((item) => item.id === state.selectedEventID);
    const next = event.key === "j" ? Math.min(state.events.length - 1, index + 1) : Math.max(0, index - 1);
    const item = state.events[next];
    if (item) {
      state.selectedEventID = item.id;
      renderTrajectory({ preserveScroll: false });
      state.ledger?.scrollToEvent(item.id);
    }
    return;
  }
  if (event.key === "Enter" && state.selectedEventID) {
    void openDetail(state.selectedEventID);
    return;
  }
  if (state.view === "trajectory" && event.key === "g") {
    state.ledger?.scrollToTop();
  }
  if (state.view === "trajectory" && event.key === "G") {
    state.ledger?.scrollToBottom();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function collectDom() {
  dom.shell = $("#shell");
  dom.sessionList = $("#session-list");
  dom.family = $("#family");
  dom.sessionHeader = $("#session-header");
  dom.view = $("#view");
  dom.error = $("#error");
  dom.loadState = $("#load-state");
  dom.drawer = $("#drawer");
  dom.drawerBackdrop = $("#drawer-backdrop");
  dom.toast = $("#toast");
  dom.shortcuts = $("#shortcuts");
  dom.settings = $("#settings");
  dom.confirm = $("#confirm");
  dom.settingsBody = $("#settings-body");
  dom.revealToggle = $("#reveal-toggle");
  dom.revealWarning = $("#reveal-warning");
  dom.exportBtn = $("#export-btn");
  dom.exportMenu = $("#export-menu");
  dom.exportNote = $("#export-note");
  dom.liveToggle = $("#live-toggle");
  dom.dbInfo = $("#db-info");
}

async function boot() {
  state.token = consumeTokenFromLocation(window.location, window.history);
  const linkedTheme = Boolean(
    readThemeFromHash(window.location.hash) ||
      readPaletteFromHash(window.location.hash),
  );
  collectDom();
  applyStoredTheme();
  renderViewModeState();
  bindStaticEvents();
  renderRevealState();
  try {
    const health = await api("/api/health", {}, { noReveal: true });
    state.revealAllowed = health.revealAllowed !== false;
    setText(dom.dbInfo, health.dbPath ?? "");
    if (dom.dbInfo) dom.dbInfo.title = health.dbPath ?? "";
    const serverTheme = health.theme?.name;
    if (
      !linkedTheme &&
      get("themeUserSet") !== true &&
      typeof serverTheme === "string" &&
      serverTheme.trim().length > 0
    ) {
      // Open the same theme that OpenCode 2 has selected in its CLI config,
      // even when the user did not come through a TUI deep link.
      setTheme(serverTheme.trim(), false);
    }
    renderRevealState();
    await loadSessions("");
    const route = parseHash();
    const sessionID = route.sessionID ?? state.sessions[0]?.id ?? null;
    if (sessionID) {
      await selectSession(sessionID, route.view, route.eventID);
    } else {
      renderEmpty("No OpenCode 2 sessions found");
    }
  } catch (error) {
    showError(error);
    renderEmpty("Cannot connect to the observability server", error.message);
  }
}

void boot();
