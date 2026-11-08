import type { Rpc as RpcSDK } from "@opencode/plugin/rpc";

/**
 * `Rpc.define` only rejects error names that use the reserved `rpc.` prefix
 * and returns its input. Replicating that check keeps the contract identical
 * without importing the SDK at runtime.
 */
export function defineRpc<const D extends RpcSDK.Definition>(definition: D): D {
  const reserved = Object.values(definition.methods)
    .flatMap((method) => Object.keys(method.errors ?? {}))
    .find((name) => name.startsWith("rpc."));
  if (reserved) {
    throw new Error(`RPC error names starting with "rpc." are reserved: ${reserved}`);
  }
  return definition;
}
