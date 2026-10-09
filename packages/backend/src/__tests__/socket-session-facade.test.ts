import { describe, expect, it, vi } from "vitest";

import {
  createSessionFencedEmitter,
  createSessionFencedSocket,
  SocketSessionRoomManager,
} from "../socket-session-facade";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function emitter(): any {
  const target: any = {
    emit: vi.fn(() => true),
    to: vi.fn(() => emitter()),
    in: vi.fn(() => emitter()),
    except: vi.fn(() => emitter()),
    timeout: vi.fn(() => emitter()),
  };
  Object.defineProperty(target, "volatile", {
    get: () => emitter(),
  });
  return target;
}

function rawSocket() {
  const raw: any = Object.assign(emitter(), {
    id: "socket-1",
    handshake: {
      headers: {
        authorization: "Bearer sentinel-authorization",
        cookie: "session=sentinel-cookie",
        "proxy-authorization": "Basic sentinel-proxy-secret",
      },
      auth: { token: "sentinel-auth-token" },
      query: { token: "sentinel-query-token", tenant: "tenant-1" },
      secure: true,
      issued: 123,
    },
    rooms: new Set(["socket-1"]),
    broadcast: emitter(),
    join: vi.fn((rooms: string | string[]) => {
      for (const room of Array.isArray(rooms) ? rooms : [rooms]) {
        raw.rooms.add(room);
      }
      return raw;
    }),
    leave: vi.fn((room: string) => {
      raw.rooms.delete(room);
      return raw;
    }),
    disconnect: vi.fn(() => raw),
  });
  return raw;
}

describe("session-fenced Socket.IO facades", () => {
  it("preserves common socket/room APIs while the captured session is current", async () => {
    const raw = rawSocket();
    const rooms = new SocketSessionRoomManager(raw);
    const socket = createSessionFencedSocket(raw, () => true, rooms);

    expect(socket.id).toBe("socket-1");
    socket.emit("clinical:result", { owner: "user-1" });
    socket.to("care-team").emit("clinical:result", { owner: "user-1" });
    socket.broadcast.emit("clinical:result", { owner: "user-1" });
    await socket.join("care-team");

    expect(raw.emit).toHaveBeenCalledOnce();
    expect(raw.to).toHaveBeenCalledWith("care-team");
    expect(raw.broadcast.emit).toHaveBeenCalledOnce();
    expect(raw.join).toHaveBeenCalledWith("care-team");
  });

  it("drops direct, room, broadcast, and server output after a session change", async () => {
    let sessionCurrent = true;
    const raw = rawSocket();
    const rooms = new SocketSessionRoomManager(raw);
    const rawServer = emitter();
    const socket = createSessionFencedSocket(raw, () => sessionCurrent, rooms);
    const server = createSessionFencedEmitter(
      rawServer,
      () => sessionCurrent,
      rooms,
    );

    sessionCurrent = false;
    expect(socket.emit("clinical:result", { owner: "user-1" })).toBe(false);
    socket.to("care-team").emit("clinical:result", { owner: "user-1" });
    socket.broadcast.emit("clinical:result", { owner: "user-1" });
    server.to("care-team").emit("clinical:result", { owner: "user-1" });
    await socket.join("care-team");
    socket.disconnect();

    expect(raw.emit).not.toHaveBeenCalled();
    expect(raw.broadcast.emit).not.toHaveBeenCalled();
    expect(rawServer.emit).not.toHaveBeenCalled();
    expect(raw.join).not.toHaveBeenCalled();
    expect(raw.disconnect).not.toHaveBeenCalled();
  });

  it("releases a late acknowledgement closure at the auth boundary", async () => {
    let sessionCurrent = true;
    const raw = rawSocket();
    const rooms = new SocketSessionRoomManager(raw);
    const safe = createSessionFencedEmitter(raw, () => sessionCurrent, rooms);
    const acknowledgement = vi.fn();

    safe.emit("clinical:request", { owner: "user-1" }, acknowledgement);
    const guardedAcknowledgement = raw.emit.mock.calls[0]?.at(-1);
    expect((rooms as any).acknowledgements.size).toBe(1);
    sessionCurrent = false;
    await rooms.clearForBoundary();
    expect((rooms as any).acknowledgements.size).toBe(0);
    guardedAcknowledgement({ result: "old-owner-phi" });

    expect(acknowledgement).not.toHaveBeenCalled();
  });

  it("releases acknowledgement closures synchronously on disconnect invalidation", () => {
    const raw = rawSocket();
    const rooms = new SocketSessionRoomManager(raw);
    const acknowledgement = vi.fn();
    const safe = createSessionFencedEmitter(raw, () => false, rooms);

    // Register while the handler's session is current, then keep the facade
    // alive to model a custom route that remains pending after disconnect.
    const currentSafe = createSessionFencedEmitter(raw, () => true, rooms);
    currentSafe.emit("clinical:request", { owner: "user-1" }, acknowledgement);
    const guardedAcknowledgement = raw.emit.mock.calls[0]?.at(-1);
    expect((rooms as any).acknowledgements.size).toBe(1);

    rooms.invalidateSessionOutputs();
    expect((rooms as any).acknowledgements.size).toBe(0);
    guardedAcknowledgement({ result: "old-owner-phi" });
    safe.emit("clinical:request", { owner: "user-1" }, acknowledgement);

    expect(acknowledgement).not.toHaveBeenCalled();
    expect(raw.emit).toHaveBeenCalledOnce();
  });

  it("exposes only sanitized handshake metadata and a runtime-readonly room view", async () => {
    const raw = rawSocket();
    const rooms = new SocketSessionRoomManager(raw);
    const socket = createSessionFencedSocket(raw, () => true, rooms);

    expect(socket.handshake).toEqual({ secure: true, issued: 123 });
    expect(JSON.stringify(socket.handshake)).not.toContain("sentinel-");
    expect(() => (socket.rooms as Set<string>).add("snapshot-only")).toThrow();
    expect([...socket.rooms]).toEqual(["socket-1"]);
    await expect(socket.join("care-team")).resolves.toBeUndefined();
    expect(socket.rooms.has("care-team")).toBe(true);
    await expect(socket.leave("care-team")).resolves.toBeUndefined();
    expect(socket.disconnect()).toBeUndefined();
  });

  it("makes a retained room view empty as soon as its session is stale", () => {
    let sessionCurrent = true;
    const raw = rawSocket();
    raw.rooms.add("patient-user-1");
    const manager = new SocketSessionRoomManager(raw);
    const socket = createSessionFencedSocket(
      raw,
      () => sessionCurrent,
      manager,
    );
    const retainedRooms = socket.rooms;
    const retainedIterator = retainedRooms.values();
    expect(retainedRooms.has("patient-user-1")).toBe(true);

    sessionCurrent = false;

    expect(retainedRooms.size).toBe(0);
    expect(retainedRooms.has("patient-user-1")).toBe(false);
    expect([...retainedRooms]).toEqual([]);
    expect(retainedIterator.next().done).toBe(true);
  });

  it("waits for a prior async join and then removes its room", async () => {
    const raw = rawSocket();
    const pendingJoin = deferred<void>();
    raw.join = vi.fn(async (room: string) => {
      await pendingJoin.promise;
      raw.rooms.add(room);
      return raw;
    });
    const rooms = new SocketSessionRoomManager(raw);

    const joining = rooms.join("patient-user-1");
    const cleanup = rooms.clearForBoundary();
    let cleaned = false;
    void cleanup.then(() => {
      cleaned = true;
    });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    expect(raw.leave).not.toHaveBeenCalled();

    pendingJoin.resolve(undefined);
    await joining;
    await cleanup;

    expect(raw.leave).toHaveBeenCalledWith("patient-user-1");
    expect(raw.rooms).toEqual(new Set(["socket-1"]));
  });

  it("removes a custom room added by an async join that settles after disconnect", async () => {
    const raw = rawSocket();
    const pendingJoin = deferred<void>();
    raw.join = vi.fn(async (room: string) => {
      await pendingJoin.promise;
      raw.rooms.add(room);
    });
    const rooms = new SocketSessionRoomManager(raw);

    const joining = rooms.join("patient-user-1");
    rooms.invalidateSessionOutputs();
    const disconnectCleanup = rooms.clearForBoundary();
    pendingJoin.resolve(undefined);

    await joining;
    await disconnectCleanup;
    expect(raw.leave).toHaveBeenCalledWith("patient-user-1");
    expect(raw.rooms).toEqual(new Set(["socket-1"]));
  });

  it("does not complete a boundary until async room leaves settle", async () => {
    const raw = rawSocket();
    raw.rooms.add("patient-user-1");
    const pendingLeave = deferred<void>();
    raw.leave = vi.fn(async (room: string) => {
      await pendingLeave.promise;
      raw.rooms.delete(room);
    });
    const rooms = new SocketSessionRoomManager(raw);

    const cleanup = rooms.clearForBoundary();
    let cleaned = false;
    void cleanup.then(() => {
      cleaned = true;
    });
    await Promise.resolve();
    expect(cleaned).toBe(false);

    pendingLeave.resolve(undefined);
    await cleanup;
    expect(raw.rooms).toEqual(new Set(["socket-1"]));
  });

  it("rejects an auth boundary when the adapter cannot leave a prior room", async () => {
    const raw = rawSocket();
    raw.rooms.add("patient-user-1");
    raw.leave = vi.fn(async () => {
      throw new Error("cluster adapter unavailable");
    });
    const rooms = new SocketSessionRoomManager(raw);

    const cleanup = rooms.clearForBoundary().catch((error) => error);
    const error = await cleanup;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Socket room cleanup failed (1 operation)");
    expect(error.message).not.toContain("cluster adapter unavailable");
    expect(error.cause).toBeUndefined();
  });
});
