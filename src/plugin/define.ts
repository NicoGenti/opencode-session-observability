import type { Plugin as ServerSDK } from "@opencode/plugin";
import type { Plugin as TuiSDK } from "@opencode/plugin/tui";

/**
 * `Plugin.define` is an identity helper in the OpenCode 2 SDK. Importing the
 * SDK at runtime also loads its package-install toolchain, which is unrelated
 * to this plugin. These shims keep the typed call sites while leaving the SDK
 * as a type-only development dependency.
 */
export function defineServerPlugin(plugin: ServerSDK.Plugin): ServerSDK.Plugin {
  return plugin;
}

export function defineTuiPlugin(plugin: TuiSDK.Definition): TuiSDK.Definition {
  return plugin;
}
