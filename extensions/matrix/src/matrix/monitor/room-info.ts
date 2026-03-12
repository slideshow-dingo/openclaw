import type { MatrixClient } from "../sdk.js";

export type MatrixRoomInfo = {
  name?: string;
  canonicalAlias?: string;
  altAliases: string[];
};

const MAX_TRACKED_ROOM_INFO = 1024;
const MAX_TRACKED_MEMBER_DISPLAY_NAMES = 4096;

function rememberBounded<T>(map: Map<string, T>, key: string, value: T, maxEntries: number): void {
  map.set(key, value);
  if (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (typeof oldest === "string") {
      map.delete(oldest);
    }
  }
}

export function createMatrixRoomInfoResolver(client: MatrixClient) {
  const roomInfoCache = new Map<string, MatrixRoomInfo>();
  const memberDisplayNameCache = new Map<string, string>();

  const getRoomInfo = async (roomId: string): Promise<MatrixRoomInfo> => {
    const cached = roomInfoCache.get(roomId);
    if (cached) {
      return cached;
    }
    let name: string | undefined;
    let canonicalAlias: string | undefined;
    let altAliases: string[] = [];
    try {
      const nameState = await client.getRoomStateEvent(roomId, "m.room.name", "").catch(() => null);
      if (nameState && typeof nameState.name === "string") {
        name = nameState.name;
      }
    } catch {
      // ignore
    }
    try {
      const aliasState = await client
        .getRoomStateEvent(roomId, "m.room.canonical_alias", "")
        .catch(() => null);
      if (aliasState && typeof aliasState.alias === "string") {
        canonicalAlias = aliasState.alias;
      }
      const rawAliases = aliasState?.alt_aliases;
      if (Array.isArray(rawAliases)) {
        altAliases = rawAliases.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {
      // ignore
    }
    const info = { name, canonicalAlias, altAliases };
    rememberBounded(roomInfoCache, roomId, info, MAX_TRACKED_ROOM_INFO);
    return info;
  };

  const getMemberDisplayName = async (roomId: string, userId: string): Promise<string> => {
    const cacheKey = `${roomId}:${userId}`;
    const cached = memberDisplayNameCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    try {
      const memberState = await client
        .getRoomStateEvent(roomId, "m.room.member", userId)
        .catch(() => null);
      if (memberState && typeof memberState.displayname === "string") {
        rememberBounded(
          memberDisplayNameCache,
          cacheKey,
          memberState.displayname,
          MAX_TRACKED_MEMBER_DISPLAY_NAMES,
        );
        return memberState.displayname;
      }
      return userId;
    } catch {
      return userId;
    }
  };

  return {
    getRoomInfo,
    getMemberDisplayName,
  };
}
