import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { setDefaultChannelPluginRegistryForTests } from "./channel-test-helpers.js";
import { configMocks, offsetMocks } from "./channels.mock-harness.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();
let channelsAddCommand: typeof import("./channels.js").channelsAddCommand;

describe("channelsAddCommand", () => {
  beforeAll(async () => {
    ({ channelsAddCommand } = await import("./channels.js"));
  });

  beforeEach(async () => {
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    offsetMocks.deleteTelegramUpdateOffset.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    setDefaultChannelPluginRegistryForTests();
  });

  it("clears telegram update offsets when the token changes", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { botToken: "old-token", enabled: true },
        },
      },
    });

    await channelsAddCommand(
      { channel: "telegram", account: "default", token: "new-token" },
      runtime,
      { hasFlags: true },
    );

    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledTimes(1);
    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledWith({ accountId: "default" });
  });

  it("does not clear telegram update offsets when the token is unchanged", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { botToken: "same-token", enabled: true },
        },
      },
    });

    await channelsAddCommand(
      { channel: "telegram", account: "default", token: "same-token" },
      runtime,
      { hasFlags: true },
    );

    expect(offsetMocks.deleteTelegramUpdateOffset).not.toHaveBeenCalled();
  });

  it("runs post-setup hooks after writing config", async () => {
    const afterAccountConfigWritten = vi.fn().mockResolvedValue(undefined);
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "signal",
        label: "Signal",
      }),
      setup: {
        applyAccountConfig: ({ cfg, accountId, input }) => ({
          ...cfg,
          channels: {
            ...cfg.channels,
            signal: {
              enabled: true,
              accounts: {
                [accountId]: {
                  signalNumber: input.signalNumber,
                },
              },
            },
          },
        }),
        afterAccountConfigWritten,
      },
    } as ChannelPlugin;
    setActivePluginRegistry(createTestRegistry([{ pluginId: "signal", plugin, source: "test" }]));
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });

    await channelsAddCommand(
      { channel: "signal", account: "ops", signalNumber: "+15550001" },
      runtime,
      { hasFlags: true },
    );

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(afterAccountConfigWritten).toHaveBeenCalledTimes(1);
    expect(configMocks.writeConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      afterAccountConfigWritten.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(afterAccountConfigWritten).toHaveBeenCalledWith({
      previousCfg: baseConfigSnapshot.config,
      cfg: expect.objectContaining({
        channels: {
          signal: {
            enabled: true,
            accounts: {
              ops: {
                signalNumber: "+15550001",
              },
            },
          },
        },
      }),
      accountId: "ops",
      input: expect.objectContaining({
        signalNumber: "+15550001",
      }),
      runtime,
    });
  });

  it("keeps the saved config when a post-setup hook fails", async () => {
    const afterAccountConfigWritten = vi.fn().mockRejectedValue(new Error("hook failed"));
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "signal",
        label: "Signal",
      }),
      setup: {
        applyAccountConfig: ({ cfg, accountId, input }) => ({
          ...cfg,
          channels: {
            ...cfg.channels,
            signal: {
              enabled: true,
              accounts: {
                [accountId]: {
                  signalNumber: input.signalNumber,
                },
              },
            },
          },
        }),
        afterAccountConfigWritten,
      },
    } as ChannelPlugin;
    setActivePluginRegistry(createTestRegistry([{ pluginId: "signal", plugin, source: "test" }]));
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });

    await channelsAddCommand(
      { channel: "signal", account: "ops", signalNumber: "+15550001" },
      runtime,
      { hasFlags: true },
    );

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      'Channel signal post-setup warning for "ops": hook failed',
    );
  });
});
