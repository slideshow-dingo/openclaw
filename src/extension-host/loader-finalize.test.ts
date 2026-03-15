import { describe, expect, it } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import { finalizeExtensionHostRegistryLoad } from "./loader-finalize.js";

function createRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

describe("extension host loader finalize", () => {
  it("adds missing memory-slot warnings and runs cache plus activation", () => {
    const registry = createRegistry();
    const calls: string[] = [];

    const result = finalizeExtensionHostRegistryLoad({
      registry,
      memorySlot: "memory-a",
      memorySlotMatched: false,
      provenance: {
        loadPathMatcher: {
          exact: new Set(),
          dirs: [],
        },
        installRules: new Map(),
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      env: process.env,
      cacheEnabled: true,
      cacheKey: "cache-key",
      setCachedRegistry: (cacheKey, passedRegistry) => {
        calls.push(`cache:${cacheKey}:${passedRegistry === registry}`);
      },
      activateRegistry: (passedRegistry, cacheKey) => {
        calls.push(`activate:${cacheKey}:${passedRegistry === registry}`);
      },
    });

    expect(result).toBe(registry);
    expect(registry.diagnostics).toContainEqual({
      level: "warn",
      message: "memory slot plugin not found or not marked as memory: memory-a",
    });
    expect(calls).toEqual(["cache:cache-key:true", "activate:cache-key:true"]);
  });

  it("skips cache writes when caching is disabled", () => {
    const registry = createRegistry();
    const calls: string[] = [];

    finalizeExtensionHostRegistryLoad({
      registry,
      memorySlotMatched: true,
      provenance: {
        loadPathMatcher: {
          exact: new Set(),
          dirs: [],
        },
        installRules: new Map(),
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      env: process.env,
      cacheEnabled: false,
      cacheKey: "cache-key",
      setCachedRegistry: () => {
        calls.push("cache");
      },
      activateRegistry: () => {
        calls.push("activate");
      },
    });

    expect(calls).toEqual(["activate"]);
  });
});
