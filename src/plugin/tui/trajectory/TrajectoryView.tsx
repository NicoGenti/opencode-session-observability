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

import type { Analysis, Turn } from "../../../core/types.ts";
import { bridgeFocus, themePalette } from "../../tui.ts";
import {
  formatHeader,
  formatRow,
  resolveLayout,
  type StatisticsLayout,
} from "../statistics/columns.ts";
import { statusMark } from "../statistics/status.ts";
import { formatStepRow } from "../statistics/stepRows.ts";
import {
  createTrajectoryState,
  type TrajectoryKeyboardBridge,
  type TrajectoryKeyboardHandlers,
  type TrajectoryState,
} from "./state.ts";

type Context = Plugin.Context;
type Palette = Readonly<Record<string, string>>;

const FALLBACK_FOREGROUND = "#ffffff";
const FALLBACK_BACKGROUND = "#000000";

/** Slot input subset the view needs; structurally compatible with `PanelInput`. */
export interface TrajectoryPanelInput {
  readonly sessionID: string;
  readonly width: number;
  /** Host-reported panel focus; `undefined` on hosts that do not publish it. */
  readonly focused?: boolean;
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

function Header(props: {
  analysis: Analysis;
  turns: number;
  palette: Palette;
}) {
  const sessionID = () => props.analysis.session?.id ?? "unknown session";
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <box flexDirection="row" gap={1}>
        <text fg={colorOf(props.palette, "text2")}>Session</text>
        <text fg={colorOf(props.palette, "text")}>{sessionID()}</text>
        <Show when={props.analysis.redacted}>
          <text fg={colorOf(props.palette, "warning")}>redacted</text>
        </Show>
        <text fg={colorOf(props.palette, "muted")}>{`${props.turns} turns`}</text>
      </box>
      <text fg={colorOf(props.palette, "muted")}>
        Turn ledger · expand a turn to see its steps
      </text>
    </box>
  );
}

function StateMessage(props: { state: TrajectoryState; palette: Palette }) {
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
        <text fg={colorOf(props.palette, "muted")}>Preparing…</text>
      </Show>
    </box>
  );
}

/**
 * Turn ledger with the per-turn step accordion. Rows come from the same pure
 * formatters the statistics table uses, so both panels stay aligned.
 */
function TurnLedger(props: {
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

function TrajectoryPanel(props: {
  sessionID: string;
  width: number;
  focused?: boolean;
  keyboard: TrajectoryKeyboardBridge;
}) {
  const context = usePlugin();
  const state = createTrajectoryState(context.client);
  const palette = createMemo<Palette>(() => themePalette(context) ?? {});
  const currentLayout = createMemo(() => resolveLayout(props.width));

  const keyboardHandlers: TrajectoryKeyboardHandlers = {
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
      props.keyboard.focused = null;
    }
  });

  createEffect(() => {
    // F-m3: mirror the slot input's focus flag into the shared bridge. A
    // reported `false` closes the keymap gate; `undefined` leaves the
    // panel-name gate as the floor on hosts that do not publish the field.
    props.keyboard.focused = bridgeFocus(props.focused);
  });

  createEffect(() => {
    // Reacts to the panel input only: `fetchAnalysis` reads no signal in its
    // synchronous window, so its own state writes cannot re-trigger this.
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
            <Header
              analysis={analysis()}
              turns={state.turns().length}
              palette={palette()}
            />
            <Show
              when={state.loading()}
              fallback={
                <TurnLedger
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

export function TrajectoryView(props: {
  readonly context: Context;
  readonly sessionID: string;
  readonly width: number;
  readonly focused?: boolean;
  readonly keyboard: TrajectoryKeyboardBridge;
}) {
  return (
    <PluginContextProvider value={props.context}>
      <TrajectoryPanel
        sessionID={props.sessionID}
        width={props.width}
        focused={props.focused}
        keyboard={props.keyboard}
      />
    </PluginContextProvider>
  );
}

/**
 * Slot render body. The host renders slot claims outside the plugin's own
 * Solid root, so the plugin context is re-provided here.
 */
export function trajectoryPanelElement(
  context: Context,
  input: TrajectoryPanelInput,
  keyboard: TrajectoryKeyboardBridge,
) {
  return (
    <TrajectoryView
      context={context}
      sessionID={input.sessionID}
      width={input.width}
      focused={input.focused}
      keyboard={keyboard}
    />
  );
}
