import { Plugin } from "@opencode/plugin";
import { ApiSource } from "../core/adapters/api.ts";
import type { ApiClientLike } from "../core/adapters/api.ts";
import { ObservabilityService } from "../core/service.ts";
import { Observability } from "./rpc.ts";
import { createRpcHandlers } from "./service.ts";

/**
 * OpenCode 2 server part.
 *
 * It registers a read-only RPC namespace over the plugin client. Session data
 * is read through `ctx.session.list/get/context`; the plugin never opens or
 * writes the SQLite store. The browser UI and the TUI commands consume the same
 * projection code either directly or through this RPC.
 */
export default Plugin.define({
  id: "opencode-session-observability",
  async setup(ctx) {
    const allowReveal = ctx.options.allowReveal === true;
    const source = new ApiSource(ctx as unknown as ApiClientLike);
    const service = new ObservabilityService(source);
    const registration = await ctx.rpc.register(
      Observability,
      createRpcHandlers(service, allowReveal) as any,
    );
    return async () => {
      await registration.dispose();
    };
  },
});
