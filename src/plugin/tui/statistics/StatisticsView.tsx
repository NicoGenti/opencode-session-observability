import {
  createEffect,
  createMemo,
  For,
  onCleanup,
  onMount,
  Show,
  type Accessor,
} from "solid-js";
import {
  PluginContextProvider,
  usePlugin,
  type Plugin,
} from "@opencode/plugin/tui";

import type { Analysis, Metric, Turn, TurnStatus } from "../../../core/types.ts";
import {
  basisMark,
  formatCost,
  formatNumber,
  formatPercent,
} from "../../../core/format.ts";
import { themePalette } from "../../tui.ts";
import {
  formatHeader,
  formatRow,
  resolveLayout,
  type StatisticsLayout,
} from "./columns.ts";
import { statusMark } from "./status.ts";
import { formatStepRow } from "./stepRows.ts";
import {
  createStatisticsState,
  type StatisticsKeyboardBridge,
  type StatisticsKeyboardHandlers,
  type StatisticsState,
  type StatisticsTotals,
} from "./state.ts";

type Context = Plugin.Context;
type Palette = Readonly<Record<string, string>>;

const FALLBACK_FOREGROUND = "#ffffff";
const FALLBACK_BACKGROUND = "#000000";

/** Slot input subset the view needs; structurally compatible with `PanelInput`. */
export interface StatisticsPanelInput {
  readonly sessionID: string;
  readonly width: number;
}

function colorOf(palette: Palette, key: string): string {
  return (
    palette[key] ??
    palette.text ??
    palette.text2 ??
    FALLBACK_FOREGROUND
  );
}

function backgroundOf(palette: Palette): string {
  return palette.page ?? FALLBACK_BACKGROUND;
}

function bannerMetric(
  metric: Metric | undefined,
  formatter: (value: number | null | undefined) => string,
): string {
  if (!metric || metric.value === null || !Number.isFinite(metric.value)) {
    return "—";
  }
  return `${formatter(metric.value)} ${basisMark(metric.basis)}`;
}

/**
 * `SessionMeta` carries no `status` or `active` field, so the badge uses its
 * recorded `outcome` first and falls back to the most recent turn status.
 */
function sessionStatus(analysis: Analysis): TurnStatus {
  const outcome = analysis.session?.outcome;
  if (outcome === "succeeded") return "completed";
  if (outcome === "failed") return "error";
  if (outcome === "interrupted") return "interrupted";
  const turns = analysis.turns ?? [];
  const last = turns[turns.length - 1];
  return last?.status ?? "unknown";
}

function Banner(props: {
  analysis: Analysis;
  totals: StatisticsTotals | null;
  palette: Palette;
}) {
  const status = () => statusMark(sessionStatus(props.analysis));
  const sessionID = () => props.analysis.session?.id ?? "unknown session";
  const turnCount = () =>
    props.totals?.turns ?? props.analysis.turns?.length ?? 0;
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <box flexDirection="row" gap={1}>
        <text fg={colorOf(props.palette, "text2")}>Session</text>
        <text fg={colorOf(props.palette, "text")}>{sessionID()}</text>
        <text fg={colorOf(props.palette, status().paletteKey)}>
          {`${status().symbol} ${status().label}`}
        </text>
        <Show when={props.analysis.redacted}>
          <text fg={colorOf(props.palette, "warning")}>redacted</text>
        </Show>
        <text fg={colorOf(props.palette, "muted")}>{`${turnCount()} turns`}</text>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={colorOf(props.palette, "text")}>
          {`Context ${bannerMetric(
            props.totals?.totalContext,
            formatNumber,
          )}`}
        </text>
        <text fg={colorOf(props.palette, "text")}>
          {`Cache hit ${bannerMetric(
            props.totals?.cacheHitRate,
            formatPercent,
          )}`}
        </text>
        <text fg={colorOf(props.palette, "text")}>
          {`Cost ${bannerMetric(props.totals?.cost, formatCost)}`}
        </text>
      </box>
    </box>
  );
}

function StateMessage(props: { state: StatisticsState; palette: Palette }) {
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      justifyContent="center"
      alignItems="center"
    >
      <Show when={props.state.loading()}>
        <text fg={colorOf(props.palette, "muted")}>Loading…</text>
      </Show>
      <Show when={!props.state.loading() && props.state.error()}>
        <text fg={colorOf(props.palette, "critical")}>
          {props.state.error()}
        </text>
        <text fg={colorOf(props.palette, "muted")}>
          Reopen the panel to retry.
        </text>
      </Show>
      <Show when={!props.state.loading() && !props.state.error()}>
        <text fg={colorOf(props.palette, "muted")}>Loading…</text>
      </Show>
    </box>
  );
}

function Table(props: {
  layout: StatisticsLayout;
  turns: readonly Turn[];
  isSelected: (turn: Turn) => boolean;
  expanded: ReadonlySet<string>;
  palette: Palette;
}) {
  return (
    <Show
      when={props.turns.length > 0}
      fallback={
        <text fg={colorOf(props.palette, "muted")}>
          No turns for this session.
        </text>
      }
    >
      <text fg={colorOf(props.palette, "text2")} wrapMode="none">
        {formatHeader(props.layout.columns)}
      </text>
      <scrollbox
        flexGrow={1}
        scrollY={true}
        backgroundColor={backgroundOf(props.palette)}
      >
        <For each={props.turns}>
          {(turn) => {
            const selected = () => props.isSelected(turn);
            const expanded = () => props.expanded.has(turn.id);
            const row = () =>
              formatRow(
                turn,
                props.layout.columns,
                selected(),
                expanded(),
              );
            return (
              <>
                <box flexDirection="row">
                  <text
                    fg={colorOf(
                      props.palette,
                      selected() ? "accent" : "text",
                    )}
                    wrapMode="none"
                  >
                    {row().prefix}
                  </text>
                  <text
                    fg={colorOf(
                      props.palette,
                      statusMark(turn.status).paletteKey,
                    )}
                    wrapMode="none"
                  >
                    {row().status}
                  </text>
                </box>
                <Show when={expanded() && (turn.steps?.length ?? 0) > 0}>
                  <For each={turn.steps ?? []}>
                    {(step) => {
                      const stepRow = () =>
                        formatStepRow(step, props.layout.width);
                      return (
                        <box flexDirection="row">
                          <text
                            fg={colorOf(props.palette, "text2")}
                            wrapMode="none"
                          >
                            {stepRow().prefix}
                          </text>
                          <text
                            fg={colorOf(
                              props.palette,
                              statusMark(step.status).paletteKey,
                            )}
                            wrapMode="none"
                          >
                            {stepRow().status}
                          </text>
                        </box>
                      );
                    }}
                  </For>
                </Show>
              </>
            );
          }}
        </For>
      </scrollbox>
    </Show>
  );
}

function StatisticsPanel(props: {
  sessionID: string;
  width: number;
  keyboard: StatisticsKeyboardBridge;
}) {
  const context = usePlugin();
  const state = createStatisticsState(context.client);
  const palette = createMemo<Palette>(() => themePalette(context) ?? {});
  const currentLayout = createMemo(() => resolveLayout(props.width));

  const keyboardHandlers: StatisticsKeyboardHandlers = {
    moveSelection: (delta) => state.moveSelection(delta),
    toggleExpand: () => {
      const turn = state.turns()[state.selectedIndex()];
      if (turn) state.toggleTurnExpand(turn.id);
    },
  };

  onMount(() => {
    props.keyboard.handlers = keyboardHandlers;
  });

  onCleanup(() => {
    if (props.keyboard.handlers === keyboardHandlers) {
      props.keyboard.handlers = null;
    }
  });

  createEffect(() => {
    const sessionID = props.sessionID;
    void state.fetchAnalysis(sessionID);
  });

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      padding={1}
      backgroundColor={backgroundOf(palette())}
    >
      <Show
        when={state.analysis()}
        fallback={<StateMessage state={state} palette={palette()} />}
      >
        {(analysis: Accessor<Analysis>) => (
          <>
            <Banner
              analysis={analysis()}
              totals={state.totals()}
              palette={palette()}
            />
            <Show when={state.error()}>
              <text fg={colorOf(palette(), "critical")}>{state.error()}</text>
            </Show>
            <Show
              when={state.loading()}
              fallback={
                <Table
                  layout={currentLayout()}
                  turns={state.turns()}
                  isSelected={state.isSelected}
                  expanded={state.expandedTurns()}
                  palette={palette()}
                />
              }
            >
              <text fg={colorOf(palette(), "muted")}>Loading…</text>
            </Show>
          </>
        )}
      </Show>
    </box>
  );
}

export function StatisticsView(props: {
  readonly context: Context;
  readonly sessionID: string;
  readonly width: number;
  readonly keyboard: StatisticsKeyboardBridge;
}) {
  return (
    <PluginContextProvider value={props.context}>
      <StatisticsPanel
        sessionID={props.sessionID}
        width={props.width}
        keyboard={props.keyboard}
      />
    </PluginContextProvider>
  );
}

/**
 * Slot render body. The host renders slot claims outside the plugin's own
 * Solid root, so the plugin context is re-provided here.
 */
export function statisticsPanelElement(
  context: Context,
  input: StatisticsPanelInput,
  keyboard: StatisticsKeyboardBridge,
) {
  return (
    <StatisticsView
      context={context}
      sessionID={input.sessionID}
      width={input.width}
      keyboard={keyboard}
    />
  );
}
