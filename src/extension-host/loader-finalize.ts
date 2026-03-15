import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginLogger } from "../plugins/types.js";
import type { ExtensionHostProvenanceIndex } from "./loader-policy.js";
import { warnAboutUntrackedLoadedExtensions } from "./loader-policy.js";

export function finalizeExtensionHostRegistryLoad(params: {
  registry: PluginRegistry;
  memorySlot?: string | null;
  memorySlotMatched: boolean;
  provenance: ExtensionHostProvenanceIndex;
  logger: PluginLogger;
  env: NodeJS.ProcessEnv;
  cacheEnabled: boolean;
  cacheKey: string;
  setCachedRegistry: (cacheKey: string, registry: PluginRegistry) => void;
  activateRegistry: (registry: PluginRegistry, cacheKey: string) => void;
}): PluginRegistry {
  if (typeof params.memorySlot === "string" && !params.memorySlotMatched) {
    params.registry.diagnostics.push({
      level: "warn",
      message: `memory slot plugin not found or not marked as memory: ${params.memorySlot}`,
    });
  }

  warnAboutUntrackedLoadedExtensions({
    registry: params.registry,
    provenance: params.provenance,
    logger: params.logger,
    env: params.env,
  });

  if (params.cacheEnabled) {
    params.setCachedRegistry(params.cacheKey, params.registry);
  }
  params.activateRegistry(params.registry, params.cacheKey);
  return params.registry;
}
