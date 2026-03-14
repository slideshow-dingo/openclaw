import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const setupChannelsMock = vi.hoisted(() => vi.fn());
const ensureWorkspaceAndSessionsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const wizardMocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
}));

vi.mock("./onboard-channels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-channels.js")>()),
  setupChannels: setupChannelsMock,
}));

vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  ensureWorkspaceAndSessions: ensureWorkspaceAndSessionsMock,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { agentsAddCommand } from "./agents.js";

const runtime = createTestRuntime();

describe("agents add command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    setupChannelsMock.mockReset();
    ensureWorkspaceAndSessionsMock.mockClear();
    wizardMocks.createClackPrompter.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("requires --workspace when flags are present", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work" }, runtime, { hasFlags: true });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--workspace"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("requires --workspace in non-interactive mode", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work", nonInteractive: true }, runtime, {
      hasFlags: false,
    });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--workspace"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("exits with code 1 when the interactive wizard is cancelled", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn().mockRejectedValue(new WizardCancelledError()),
      text: vi.fn(),
      confirm: vi.fn(),
      note: vi.fn(),
      outro: vi.fn(),
    });

    await agentsAddCommand({}, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("runs collected channel post-write hooks after saving the agent config", async () => {
    const hookRun = vi.fn().mockResolvedValue(undefined);
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    setupChannelsMock.mockImplementation(async (cfg, _runtime, _prompter, options) => {
      options?.onPostWriteHook?.({
        channel: "telegram",
        accountId: "acct-1",
        run: hookRun,
      });
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          telegram: {
            botToken: "new-token",
          },
        },
      };
    });
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn().mockResolvedValue(undefined),
      text: vi.fn().mockResolvedValue("/tmp/work"),
      confirm: vi.fn().mockResolvedValue(false),
      note: vi.fn().mockResolvedValue(undefined),
      outro: vi.fn().mockResolvedValue(undefined),
    });

    await agentsAddCommand({ name: "Work" }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          list: expect.arrayContaining([
            expect.objectContaining({
              id: "work",
              name: "Work",
              workspace: "/tmp/work",
            }),
          ]),
        }),
      }),
    );
    expect(hookRun).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        channels: {
          telegram: {
            botToken: "new-token",
          },
        },
      }),
      runtime,
    });
    expect(writeConfigFileMock.mock.invocationCallOrder[0]).toBeLessThan(
      hookRun.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
