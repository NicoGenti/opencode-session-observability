import type { ObservabilityService } from "../core/service.ts";
import type { EventKind } from "../core/types.ts";
import { GENERATOR, PACKAGE_VERSION } from "../version.ts";

type Input = Record<string, any>;

function strings(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((item): item is string => typeof item === "string");
    return out.length > 0 ? out : undefined;
  }
  if (typeof value === "string" && value.length > 0) return [value];
  return undefined;
}

/**
 * RPC handlers for the OpenCode 2 server part. They are wired to
 * `ctx.rpc.register(Observability, …)` and read through the plugin's client,
 * never through the on-disk database.
 */
export function createRpcHandlers(
  service: ObservabilityService,
  allowReveal: boolean,
) {
  const revealOf = (input: Input): boolean =>
    input.reveal === true && allowReveal;

  return {
    health: async () => {
      const description = service.describe();
      return {
        ok: true,
        version: PACKAGE_VERSION,
        source: description.source,
        revealAllowed: allowReveal,
        readOnly: true,
      };
    },

    sessions: async (input: Input) => ({
      sessions: await service.listSessions({
        query: typeof input.query === "string" ? input.query : undefined,
        limit: typeof input.limit === "number" ? input.limit : undefined,
        reveal: revealOf(input),
      }),
      revealAllowed: allowReveal,
    }),

    session: async (input: Input) => {
      const data = await service.getSession(input.sessionID, {
        reveal: revealOf(input),
      });
      return { ...data, revealAllowed: allowReveal };
    },

    analysis: async (input: Input) => {
      const fromSeq = typeof input.fromSeq === "number" ? input.fromSeq : undefined;
      const toSeq = typeof input.toSeq === "number" ? input.toSeq : undefined;
      const { analysis } = await service.analyze(input.sessionID, {
        fromSeq,
        toSeq,
        reveal: revealOf(input),
        windowed: fromSeq !== undefined || toSeq !== undefined,
      });
      return { analysis, revealAllowed: allowReveal };
    },

    eventPage: async (input: Input) => {
      const page = await service.events({
        sessionID: input.sessionID,
        q: typeof input.q === "string" ? input.q : undefined,
        kinds: strings(input.kinds) as EventKind[] | undefined,
        agents: strings(input.agents),
        models: strings(input.models),
        providers: strings(input.providers),
        tools: strings(input.tools),
        statuses: strings(input.statuses),
        errorsOnly: input.errorsOnly === true,
        retriesOnly: input.retriesOnly === true,
        compactionsOnly: input.compactionsOnly === true,
        subagentsOnly: input.subagentsOnly === true,
        contextOnly: input.contextOnly === true,
        from: typeof input.from === "number" ? input.from : undefined,
        to: typeof input.to === "number" ? input.to : undefined,
        minPromptTokens:
          typeof input.minPromptTokens === "number"
            ? input.minPromptTokens
            : undefined,
        maxPromptTokens:
          typeof input.maxPromptTokens === "number"
            ? input.maxPromptTokens
            : undefined,
        limit: typeof input.limit === "number" ? input.limit : undefined,
        before: typeof input.before === "string" ? input.before : undefined,
        after: typeof input.after === "string" ? input.after : undefined,
        around: typeof input.around === "string" ? input.around : undefined,
        direction:
          input.direction === "forward" || input.direction === "backward"
            ? input.direction
            : undefined,
        reveal: revealOf(input),
      });
      return { ...page, revealAllowed: allowReveal };
    },

    event: async (input: Input) => ({
      event: await service.eventDetail(input.sessionID, input.eventID, {
        reveal: revealOf(input),
      }),
      revealAllowed: allowReveal,
    }),

    export: async (input: Input) =>
      service.export(input.sessionID, {
        format: input.format,
        includeEvents: input.includeEvents !== false,
        reveal: revealOf(input),
        generator: GENERATOR,
      }),
  };
}
