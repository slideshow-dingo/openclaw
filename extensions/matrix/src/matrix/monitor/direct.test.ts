import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { createDirectRoomTracker } from "./direct.js";

function createMockClient(params: {
  isDm?: boolean;
  senderDirect?: boolean;
  selfDirect?: boolean;
  members?: string[];
}) {
  let members = params.members ?? ["@alice:example.org", "@bot:example.org"];
  return {
    dms: {
      update: vi.fn().mockResolvedValue(undefined),
      isDm: vi.fn().mockReturnValue(params.isDm === true),
    },
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    getJoinedRoomMembers: vi.fn().mockImplementation(async () => members),
    getRoomStateEvent: vi
      .fn()
      .mockImplementation(async (_roomId: string, eventType: string, stateKey: string) => {
        if (stateKey === "@alice:example.org") {
          return { is_direct: params.senderDirect === true };
        }
        if (stateKey === "@bot:example.org") {
          return { is_direct: params.selfDirect === true };
        }
        return {};
      }),
    __setMembers(next: string[]) {
      members = next;
    },
  } as unknown as MatrixClient;
}

describe("createDirectRoomTracker", () => {
  it("treats m.direct rooms as DMs", async () => {
    const tracker = createDirectRoomTracker(createMockClient({ isDm: true }));
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
  });

  it("does not trust stale m.direct classifications for shared rooms", async () => {
    const tracker = createDirectRoomTracker(
      createMockClient({
        isDm: true,
        members: ["@alice:example.org", "@bot:example.org", "@extra:example.org"],
      }),
    );
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("classifies 2-member rooms as DMs when direct metadata is missing", async () => {
    const client = createMockClient({ isDm: false });
    const tracker = createDirectRoomTracker(client);
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not classify rooms with extra members as DMs", async () => {
    const tracker = createDirectRoomTracker(
      createMockClient({
        isDm: false,
        members: ["@alice:example.org", "@bot:example.org", "@observer:example.org"],
      }),
    );
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("does not classify 2-member rooms whose sender is not a joined member as DMs", async () => {
    const tracker = createDirectRoomTracker(
      createMockClient({
        isDm: false,
        members: ["@mallory:example.org", "@bot:example.org"],
      }),
    );
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("re-checks room membership after invalidation when a DM gains extra members", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    (client as MatrixClient & { __setMembers: (members: string[]) => void }).__setMembers([
      "@alice:example.org",
      "@bot:example.org",
      "@mallory:example.org",
    ]);

    tracker.invalidateRoom("!room:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("still recognizes exact 2-member rooms when member state also claims is_direct", async () => {
    const tracker = createDirectRoomTracker(createMockClient({ senderDirect: true }));
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);
  });

  it("ignores member-state is_direct when the room is not a strict DM", async () => {
    const tracker = createDirectRoomTracker(
      createMockClient({
        senderDirect: true,
        members: ["@alice:example.org", "@bot:example.org", "@observer:example.org"],
      }),
    );
    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("bounds joined-room membership cache size", async () => {
    const client = createMockClient({ isDm: false });
    const tracker = createDirectRoomTracker(client);

    for (let i = 0; i <= 1024; i += 1) {
      await tracker.isDirectMessage({
        roomId: `!room-${i}:example.org`,
        senderId: "@alice:example.org",
      });
    }

    await tracker.isDirectMessage({
      roomId: "!room-0:example.org",
      senderId: "@alice:example.org",
    });

    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(1026);
  });
});
