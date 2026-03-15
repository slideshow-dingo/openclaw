import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { activateExtensionHostRegistry } from "../extension-host/activation.js";
import {
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  resolvePluginSdkAlias,
  resolvePluginSdkAliasCandidateOrder,
  resolvePluginSdkAliasFile,
  resolvePluginSdkScopedAliasMap,
} from "../extension-host/loader-compat.js";
import { finalizeExtensionHostRegistryLoad } from "../extension-host/loader-finalize.js";
import { processExtensionHostPluginCandidate } from "../extension-host/loader-flow.js";
import {
  buildExtensionHostProvenanceIndex,
  compareExtensionHostDuplicateCandidateOrder,
  pushExtensionHostDiagnostics,
  warnWhenExtensionAllowlistIsOpen,
} from "../extension-host/loader-policy.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { clearPluginCommands } from "./commands.js";
import {
  applyTestPluginDefaults,
  normalizePluginsConfig,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { clearPluginInteractiveHandlers } from "./interactive.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
import { createPluginRuntime, type CreatePluginRuntimeOptions } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import type {
  OpenClawPluginDefinition,
  OpenClawPluginModule,
  PluginDiagnostic,
  PluginBundleFormat,
  PluginFormat,
  PluginLogger,
} from "./types.js";

export type PluginLoadResult = PluginRegistry;

export type PluginLoadOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  // Allows callers to resolve plugin roots and load paths against an explicit env
  // instead of the process-global environment.
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  runtimeOptions?: CreatePluginRuntimeOptions;
  cache?: boolean;
  mode?: "full" | "validate";
};

const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 32;
const registryCache = new Map<string, PluginRegistry>();
const openAllowlistWarningCache = new Set<string>();

export function clearPluginLoaderCache(): void {
  registryCache.clear();
  openAllowlistWarningCache.clear();
}

const defaultLogger = () => createSubsystemLogger("plugins");

type PluginSdkAliasCandidateKind = "dist" | "src";

function resolvePluginSdkAliasCandidateOrder(params: {
  modulePath: string;
  isProduction: boolean;
}): PluginSdkAliasCandidateKind[] {
  const normalizedModulePath = params.modulePath.replace(/\\/g, "/");
  const isDistRuntime = normalizedModulePath.includes("/dist/");
  return isDistRuntime || params.isProduction ? ["dist", "src"] : ["src", "dist"];
}

function listPluginSdkAliasCandidates(params: {
  srcFile: string;
  distFile: string;
  modulePath: string;
}) {
  const orderedKinds = resolvePluginSdkAliasCandidateOrder({
    modulePath: params.modulePath,
    isProduction: process.env.NODE_ENV === "production",
  });
  let cursor = path.dirname(params.modulePath);
  const candidates: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const candidateMap = {
      src: path.join(cursor, "src", "plugin-sdk", params.srcFile),
      dist: path.join(cursor, "dist", "plugin-sdk", params.distFile),
    } as const;
    for (const kind of orderedKinds) {
      candidates.push(candidateMap[kind]);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return candidates;
}

const resolvePluginSdkAliasFile = (params: {
  srcFile: string;
  distFile: string;
  modulePath?: string;
}): string | null => {
  try {
    const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
    for (const candidate of listPluginSdkAliasCandidates({
      srcFile: params.srcFile,
      distFile: params.distFile,
      modulePath,
    })) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // ignore
  }
  return null;
};

const resolvePluginSdkAlias = (): string | null =>
  resolvePluginSdkAliasFile({ srcFile: "root-alias.cjs", distFile: "root-alias.cjs" });

const resolveExtensionApiAlias = (params: { modulePath?: string } = {}): string | null => {
  try {
    const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
    const packageRoot = resolveOpenClawPackageRootSync({
      cwd: path.dirname(modulePath),
    });
    if (!packageRoot) {
      return null;
    }

    const orderedKinds = resolvePluginSdkAliasCandidateOrder({
      modulePath,
      isProduction: process.env.NODE_ENV === "production",
    });
    const candidateMap = {
      src: path.join(packageRoot, "src", "extensionAPI.ts"),
      dist: path.join(packageRoot, "dist", "extensionAPI.js"),
    } as const;
    for (const kind of orderedKinds) {
      const candidate = candidateMap[kind];
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // ignore
  }
  return null;
};

const cachedPluginSdkExportedSubpaths = new Map<string, string[]>();

function listPluginSdkExportedSubpaths(params: { modulePath?: string } = {}): string[] {
  const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
  const packageRoot = resolveOpenClawPackageRootSync({
    cwd: path.dirname(modulePath),
  });
  if (!packageRoot) {
    return [];
  }
  const cached = cachedPluginSdkExportedSubpaths.get(packageRoot);
  if (cached) {
    return cached;
  }
  try {
    const pkgRaw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as {
      exports?: Record<string, unknown>;
    };
    const subpaths = Object.keys(pkg.exports ?? {})
      .filter((key) => key.startsWith("./plugin-sdk/"))
      .map((key) => key.slice("./plugin-sdk/".length))
      .filter((subpath) => Boolean(subpath) && !subpath.includes("/"))
      .toSorted();
    cachedPluginSdkExportedSubpaths.set(packageRoot, subpaths);
    return subpaths;
  } catch {
    return [];
  }
}

const resolvePluginSdkScopedAliasMap = (): Record<string, string> => {
  const aliasMap: Record<string, string> = {};
  for (const subpath of listPluginSdkExportedSubpaths()) {
    const resolved = resolvePluginSdkAliasFile({
      srcFile: `${subpath}.ts`,
      distFile: `${subpath}.js`,
    });
    if (resolved) {
      aliasMap[`openclaw/plugin-sdk/${subpath}`] = resolved;
    }
  }
  return aliasMap;
};

export const __testing = {
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  resolveExtensionApiAlias,
  resolvePluginSdkAliasCandidateOrder,
  resolvePluginSdkAliasFile,
  maxPluginRegistryCacheEntries: MAX_PLUGIN_REGISTRY_CACHE_ENTRIES,
};

function getCachedPluginRegistry(cacheKey: string): PluginRegistry | undefined {
  const cached = registryCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  // Refresh insertion order so frequently reused registries survive eviction.
  registryCache.delete(cacheKey);
  registryCache.set(cacheKey, cached);
  return cached;
}

function setCachedPluginRegistry(cacheKey: string, registry: PluginRegistry): void {
  if (registryCache.has(cacheKey)) {
    registryCache.delete(cacheKey);
  }
  registryCache.set(cacheKey, registry);
  while (registryCache.size > MAX_PLUGIN_REGISTRY_CACHE_ENTRIES) {
    const oldestKey = registryCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    registryCache.delete(oldestKey);
  }
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  installs?: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    loadPaths: params.plugins.loadPaths,
    env: params.env,
  });
  const installs = Object.fromEntries(
    Object.entries(params.installs ?? {}).map(([pluginId, install]) => [
      pluginId,
      {
        ...install,
        installPath:
          typeof install.installPath === "string"
            ? resolveUserPath(install.installPath, params.env)
            : install.installPath,
        sourcePath:
          typeof install.sourcePath === "string"
            ? resolveUserPath(install.sourcePath, params.env)
            : install.sourcePath,
      },
    ]),
  );
  return `${roots.workspace ?? ""}::${roots.global ?? ""}::${roots.stock ?? ""}::${JSON.stringify({
    ...params.plugins,
    installs,
    loadPaths,
  })}`;
}

function validatePluginConfig(params: {
  schema?: Record<string, unknown>;
  cacheKey?: string;
  value?: unknown;
}): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const schema = params.schema;
  if (!schema) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  const cacheKey = params.cacheKey ?? JSON.stringify(schema);
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value: params.value ?? {},
  });
  if (result.ok) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  return { ok: false, errors: result.errors.map((error) => error.text) };
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const resolved =
    moduleExport &&
    typeof moduleExport === "object" &&
    "default" in (moduleExport as Record<string, unknown>)
      ? (moduleExport as { default: unknown }).default
      : moduleExport;
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const def = resolved as OpenClawPluginDefinition;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}

function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  source: string;
  rootDir?: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  enabled: boolean;
  configSchema: boolean;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    format: params.format ?? "openclaw",
    bundleFormat: params.bundleFormat,
    bundleCapabilities: params.bundleCapabilities,
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: params.configSchema,
    configUiHints: undefined,
    configJsonSchema: undefined,
  };
}

function recordPluginError(params: {
  logger: PluginLogger;
  registry: PluginRegistry;
  record: PluginRecord;
  seenIds: Map<string, PluginRecord["origin"]>;
  pluginId: string;
  origin: PluginRecord["origin"];
  error: unknown;
  logPrefix: string;
  diagnosticMessagePrefix: string;
}) {
  const errorText = String(params.error);
  const deprecatedApiHint =
    errorText.includes("api.registerHttpHandler") && errorText.includes("is not a function")
      ? "deprecated api.registerHttpHandler(...) was removed; use api.registerHttpRoute(...) for plugin-owned routes or registerPluginHttpRoute(...) for dynamic lifecycle routes"
      : null;
  const displayError = deprecatedApiHint ? `${deprecatedApiHint} (${errorText})` : errorText;
  params.logger.error(`${params.logPrefix}${displayError}`);
  params.record.status = "error";
  params.record.error = displayError;
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.pluginId, params.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: `${params.diagnosticMessagePrefix}${displayError}`,
  });
}

function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]) {
  diagnostics.push(...append);
}

type PathMatcher = {
  exact: Set<string>;
  dirs: string[];
};

type InstallTrackingRule = {
  trackedWithoutPaths: boolean;
  matcher: PathMatcher;
};

type PluginProvenanceIndex = {
  loadPathMatcher: PathMatcher;
  installRules: Map<string, InstallTrackingRule>;
};

function createPathMatcher(): PathMatcher {
  return { exact: new Set<string>(), dirs: [] };
}

function addPathToMatcher(
  matcher: PathMatcher,
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return;
  }
  const resolved = resolveUserPath(trimmed, env);
  if (!resolved) {
    return;
  }
  if (matcher.exact.has(resolved) || matcher.dirs.includes(resolved)) {
    return;
  }
  const stat = safeStatSync(resolved);
  if (stat?.isDirectory()) {
    matcher.dirs.push(resolved);
    return;
  }
  matcher.exact.add(resolved);
}

function matchesPathMatcher(matcher: PathMatcher, sourcePath: string): boolean {
  if (matcher.exact.has(sourcePath)) {
    return true;
  }
  return matcher.dirs.some((dirPath) => isPathInside(dirPath, sourcePath));
}

function buildProvenanceIndex(params: {
  config: OpenClawConfig;
  normalizedLoadPaths: string[];
  env: NodeJS.ProcessEnv;
}): PluginProvenanceIndex {
  const loadPathMatcher = createPathMatcher();
  for (const loadPath of params.normalizedLoadPaths) {
    addPathToMatcher(loadPathMatcher, loadPath, params.env);
  }

  const installRules = new Map<string, InstallTrackingRule>();
  const installs = params.config.plugins?.installs ?? {};
  for (const [pluginId, install] of Object.entries(installs)) {
    const rule: InstallTrackingRule = {
      trackedWithoutPaths: false,
      matcher: createPathMatcher(),
    };
    const trackedPaths = [install.installPath, install.sourcePath]
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    if (trackedPaths.length === 0) {
      rule.trackedWithoutPaths = true;
    } else {
      for (const trackedPath of trackedPaths) {
        addPathToMatcher(rule.matcher, trackedPath, params.env);
      }
    }
    installRules.set(pluginId, rule);
  }

  return { loadPathMatcher, installRules };
}

function isTrackedByProvenance(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): boolean {
  const sourcePath = resolveUserPath(params.source, params.env);
  const installRule = params.index.installRules.get(params.pluginId);
  if (installRule) {
    if (installRule.trackedWithoutPaths) {
      return true;
    }
    if (matchesPathMatcher(installRule.matcher, sourcePath)) {
      return true;
    }
  }
  return matchesPathMatcher(params.index.loadPathMatcher, sourcePath);
}

function matchesExplicitInstallRule(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): boolean {
  const sourcePath = resolveUserPath(params.source, params.env);
  const installRule = params.index.installRules.get(params.pluginId);
  if (!installRule || installRule.trackedWithoutPaths) {
    return false;
  }
  return matchesPathMatcher(installRule.matcher, sourcePath);
}

function resolveCandidateDuplicateRank(params: {
  candidate: ReturnType<typeof discoverOpenClawPlugins>["candidates"][number];
  manifestByRoot: Map<string, ReturnType<typeof loadPluginManifestRegistry>["plugins"][number]>;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const manifestRecord = params.manifestByRoot.get(params.candidate.rootDir);
  const pluginId = manifestRecord?.id;
  const isExplicitInstall =
    params.candidate.origin === "global" &&
    pluginId !== undefined &&
    matchesExplicitInstallRule({
      pluginId,
      source: params.candidate.source,
      index: params.provenance,
      env: params.env,
    });

  if (params.candidate.origin === "config") {
    return 0;
  }
  if (params.candidate.origin === "global" && isExplicitInstall) {
    return 1;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids stay reserved unless the operator configured an override.
    return 2;
  }
  if (params.candidate.origin === "workspace") {
    return 3;
  }
  return 4;
}

function compareDuplicateCandidateOrder(params: {
  left: ReturnType<typeof discoverOpenClawPlugins>["candidates"][number];
  right: ReturnType<typeof discoverOpenClawPlugins>["candidates"][number];
  manifestByRoot: Map<string, ReturnType<typeof loadPluginManifestRegistry>["plugins"][number]>;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const leftPluginId = params.manifestByRoot.get(params.left.rootDir)?.id;
  const rightPluginId = params.manifestByRoot.get(params.right.rootDir)?.id;
  if (!leftPluginId || leftPluginId !== rightPluginId) {
    return 0;
  }
  return (
    resolveCandidateDuplicateRank({
      candidate: params.left,
      manifestByRoot: params.manifestByRoot,
      provenance: params.provenance,
      env: params.env,
    }) -
    resolveCandidateDuplicateRank({
      candidate: params.right,
      manifestByRoot: params.manifestByRoot,
      provenance: params.provenance,
      env: params.env,
    })
  );
}

function warnWhenAllowlistIsOpen(params: {
  logger: PluginLogger;
  pluginsEnabled: boolean;
  allow: string[];
  warningCacheKey: string;
  discoverablePlugins: Array<{ id: string; source: string; origin: PluginRecord["origin"] }>;
}) {
  if (!params.pluginsEnabled) {
    return;
  }
  if (params.allow.length > 0) {
    return;
  }
  const nonBundled = params.discoverablePlugins.filter((entry) => entry.origin !== "bundled");
  if (nonBundled.length === 0) {
    return;
  }
  if (openAllowlistWarningCache.has(params.warningCacheKey)) {
    return;
  }
  const preview = nonBundled
    .slice(0, 6)
    .map((entry) => `${entry.id} (${entry.source})`)
    .join(", ");
  const extra = nonBundled.length > 6 ? ` (+${nonBundled.length - 6} more)` : "";
  openAllowlistWarningCache.add(params.warningCacheKey);
  params.logger.warn(
    `[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: ${preview}${extra}. Set plugins.allow to explicit trusted ids.`,
  );
}

function warnAboutUntrackedLoadedPlugins(params: {
  registry: PluginRegistry;
  provenance: PluginProvenanceIndex;
  logger: PluginLogger;
  env: NodeJS.ProcessEnv;
}) {
  for (const plugin of params.registry.plugins) {
    if (plugin.status !== "loaded" || plugin.origin === "bundled") {
      continue;
    }
    if (
      isTrackedByProvenance({
        pluginId: plugin.id,
        source: plugin.source,
        index: params.provenance,
        env: params.env,
      })
    ) {
      continue;
    }
    const message =
      "loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records";
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: plugin.id,
      source: plugin.source,
      message,
    });
    params.logger.warn(`[plugins] ${plugin.id}: ${message} (${plugin.source})`);
  }
}

function activatePluginRegistry(registry: PluginRegistry, cacheKey: string): void {
  setActivePluginRegistry(registry, cacheKey);
  initializeGlobalHookRunner(registry);
}

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  const env = options.env ?? process.env;
  // Test env: default-disable plugins unless explicitly configured.
  // This keeps unit/gateway suites fast and avoids loading heavyweight plugin deps by accident.
  const cfg = applyTestPluginDefaults(options.config ?? {}, env);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const normalized = normalizePluginsConfig(cfg.plugins);
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: normalized,
    installs: cfg.plugins?.installs,
    env,
  });
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = getCachedPluginRegistry(cacheKey);
    if (cached) {
      activateExtensionHostRegistry(cached, cacheKey);
      return cached;
    }
  }

  // Clear previously registered plugin commands before reloading
  clearPluginCommands();
  clearPluginInteractiveHandlers();

  // Lazily initialize the runtime so startup paths that discover/skip plugins do
  // not eagerly load every channel runtime dependency.
  let resolvedRuntime: PluginRuntime | null = null;
  const resolveRuntime = (): PluginRuntime => {
    resolvedRuntime ??= createPluginRuntime(options.runtimeOptions);
    return resolvedRuntime;
  };
  const runtime = new Proxy({} as PluginRuntime, {
    get(_target, prop, receiver) {
      return Reflect.get(resolveRuntime(), prop, receiver);
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(resolveRuntime(), prop, value, receiver);
    },
    has(_target, prop) {
      return Reflect.has(resolveRuntime(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(resolveRuntime() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(resolveRuntime() as object, prop);
    },
    defineProperty(_target, prop, attributes) {
      return Reflect.defineProperty(resolveRuntime() as object, prop, attributes);
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(resolveRuntime() as object, prop);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolveRuntime() as object);
    },
  });
  const { registry, createApi } = createPluginRegistry({
    logger,
    runtime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
  });

  const discovery = discoverOpenClawPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
    cache: options.cache,
    env,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    cache: options.cache,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  pushExtensionHostDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
  warnWhenExtensionAllowlistIsOpen({
    logger,
    pluginsEnabled: normalized.enabled,
    allow: normalized.allow,
    warningCacheKey: cacheKey,
    warningCache: openAllowlistWarningCache,
    discoverablePlugins: manifestRegistry.plugins.map((plugin) => ({
      id: plugin.id,
      source: plugin.source,
      origin: plugin.origin,
    })),
  });
  const provenance = buildExtensionHostProvenanceIndex({
    config: cfg,
    normalizedLoadPaths: normalized.loadPaths,
    env,
  });

  // Lazy: avoid creating the Jiti loader when all plugins are disabled (common in unit tests).
  let jitiLoader: ReturnType<typeof createJiti> | null = null;
  const getJiti = () => {
    if (jitiLoader) {
      return jitiLoader;
    }
    const pluginSdkAlias = resolvePluginSdkAlias();
    const extensionApiAlias = resolveExtensionApiAlias();
    const aliasMap = {
      ...(extensionApiAlias ? { "openclaw/extension-api": extensionApiAlias } : {}),
      ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
      ...resolvePluginSdkScopedAliasMap(),
    };
    jitiLoader = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      ...(Object.keys(aliasMap).length > 0
        ? {
            alias: aliasMap,
          }
        : {}),
    });
    return jitiLoader;
  };

  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const orderedCandidates = [...discovery.candidates].toSorted((left, right) => {
    return compareExtensionHostDuplicateCandidateOrder({
      left,
      right,
      manifestByRoot,
      provenance,
      env,
    });
  });

  const seenIds = new Map<string, PluginRecord["origin"]>();
  const memorySlot = normalized.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  let memorySlotMatched = false;

  for (const candidate of orderedCandidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    const pluginId = manifestRecord.id;
    const existingOrigin = seenIds.get(pluginId);
    if (existingOrigin) {
      const record = createExtensionHostPluginRecord({
        id: pluginId,
        name: manifestRecord.name ?? pluginId,
        description: manifestRecord.description,
        version: manifestRecord.version,
        format: manifestRecord.format,
        bundleFormat: manifestRecord.bundleFormat,
        bundleCapabilities: manifestRecord.bundleCapabilities,
        source: candidate.source,
        rootDir: candidate.rootDir,
        origin: candidate.origin,
        workspaceDir: candidate.workspaceDir,
        enabled: false,
        configSchema: Boolean(manifestRecord.configSchema),
      });
      setExtensionHostPluginRecordDisabled(record, `overridden by ${existingOrigin} plugin`);
      appendExtensionHostPluginRecord({ registry, record });
      continue;
    }

    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: candidate.origin,
      config: normalized,
      rootConfig: cfg,
    });
    const entry = normalized.entries[pluginId];
    const record = createExtensionHostPluginRecord({
      id: pluginId,
      name: manifestRecord.name ?? pluginId,
      description: manifestRecord.description,
      version: manifestRecord.version,
      format: manifestRecord.format,
      bundleFormat: manifestRecord.bundleFormat,
      bundleCapabilities: manifestRecord.bundleCapabilities,
      source: candidate.source,
      rootDir: candidate.rootDir,
      origin: candidate.origin,
      workspaceDir: candidate.workspaceDir,
      enabled: enableState.enabled,
      configSchema: Boolean(manifestRecord.configSchema),
    });
    record.kind = manifestRecord.kind;
    record.configUiHints = manifestRecord.configUiHints;
    record.configJsonSchema = manifestRecord.configSchema;
    const pushPluginLoadError = (message: string) => {
      setExtensionHostPluginRecordError(record, message);
      appendExtensionHostPluginRecord({
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
      });
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
    };

    if (!enableState.enabled) {
      setExtensionHostPluginRecordDisabled(record, enableState.reason);
      appendExtensionHostPluginRecord({
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
      });
      continue;
    }

    if (record.format === "bundle") {
      const unsupportedCapabilities = (record.bundleCapabilities ?? []).filter(
        (capability) =>
          capability !== "skills" &&
          capability !== "settings" &&
          !(
            capability === "commands" &&
            (record.bundleFormat === "claude" || record.bundleFormat === "cursor")
          ) &&
          !(capability === "hooks" && record.bundleFormat === "codex"),
      );
      for (const capability of unsupportedCapabilities) {
        registry.diagnostics.push({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `bundle capability detected but not wired into OpenClaw yet: ${capability}`,
        });
      }
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    // Fast-path bundled memory plugins that are guaranteed disabled by slot policy.
    // This avoids opening/importing heavy memory plugin modules that will never register.
    const earlyMemoryDecision = resolveExtensionHostEarlyMemoryDecision({
      origin: candidate.origin,
      manifestKind: manifestRecord.kind,
      recordId: record.id,
      memorySlot,
      selectedMemoryPluginId,
    });
    if (!earlyMemoryDecision.enabled) {
      setExtensionHostPluginRecordDisabled(record, earlyMemoryDecision.reason);
      appendExtensionHostPluginRecord({
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
      });
      continue;
    }

    if (!manifestRecord.configSchema) {
      pushPluginLoadError("missing config schema");
      continue;
    }

    const moduleImport = importExtensionHostPluginModule({
      rootDir: candidate.rootDir,
      source: candidate.source,
      origin: candidate.origin,
      loadModule: (safeSource) => getJiti()(safeSource),
    });
    if (!moduleImport.ok) {
      if (moduleImport.message !== "failed to load plugin") {
        pushPluginLoadError(moduleImport.message);
        continue;
      }
      recordExtensionHostPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        error: moduleImport.error,
        logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
        diagnosticMessagePrefix: "failed to load plugin: ",
      });
      continue;
    }

    const resolved = resolveExtensionHostModuleExport(moduleImport.module as OpenClawPluginModule);
    const definition = resolved.definition;
    const register = resolved.register;

    const loadedPlan = planExtensionHostLoadedPlugin({
      record,
      manifestRecord,
      definition,
      register,
      diagnostics: registry.diagnostics,
      memorySlot,
      selectedMemoryPluginId,
      entryConfig: entry?.config,
      validateOnly,
      logger,
      registry,
      seenIds,
      selectedMemoryPluginId,
      createApi,
      loadModule: (safeSource) => getJiti()(safeSource) as OpenClawPluginModule,
    });
    selectedMemoryPluginId = processed.selectedMemoryPluginId;
    memorySlotMatched ||= processed.memorySlotMatched;
  }

  return finalizeExtensionHostRegistryLoad({
    registry,
    memorySlot,
    memorySlotMatched,
    provenance,
    logger,
    env,
    cacheEnabled,
    cacheKey,
    setCachedRegistry: setCachedPluginRegistry,
    activateRegistry: activateExtensionHostRegistry,
  });
}
