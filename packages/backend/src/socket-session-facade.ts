import type {
  SocketContextEmitter,
  SocketContextSocket,
} from "./routing/route";

type RawEmitter = {
  emit(event: string, ...args: any[]): unknown;
  to(room: string | string[]): RawEmitter;
  in(room: string | string[]): RawEmitter;
  except(room: string | string[]): RawEmitter;
  timeout(ms: number): RawEmitter;
  volatile: RawEmitter;
};

type RawSocket = RawEmitter & {
  id: string;
  handshake: Record<string, any>;
  rooms: Set<string>;
  broadcast: RawEmitter;
  join(room: string | string[]): unknown;
  leave(room: string): unknown;
  disconnect(close?: boolean): unknown;
};

function sanitizedHandshake(
  handshake: Record<string, any>,
): Readonly<Record<string, unknown>> {
  const safe: Record<string, unknown> = {};
  if (typeof handshake.secure === "boolean") safe.secure = handshake.secure;
  if (typeof handshake.xdomain === "boolean") safe.xdomain = handshake.xdomain;
  if (typeof handshake.issued === "number") safe.issued = handshake.issued;
  return Object.freeze(safe);
}

function sessionRoomsView(
  rooms: Set<string>,
  isSessionCurrent: () => boolean,
): ReadonlySet<string> {
  const iterator = <T>(source: () => Iterator<T>): IterableIterator<T> => {
    const active = source();
    return {
      next(): IteratorResult<T> {
        if (!isSessionCurrent()) return { done: true, value: undefined };
        const result = active.next();
        if (!isSessionCurrent()) return { done: true, value: undefined };
        return result;
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  };

  const view = {
    get size() {
      return isSessionCurrent() ? rooms.size : 0;
    },
    has(value: string) {
      return isSessionCurrent() && rooms.has(value);
    },
    forEach(
      callback: (
        value: string,
        value2: string,
        set: ReadonlySet<string>,
      ) => void,
      thisArg?: any,
    ) {
      for (const value of view) {
        callback.call(thisArg, value, value, view);
      }
    },
    entries: () => iterator(() => rooms.entries()),
    keys: () => iterator(() => rooms.keys()),
    values: () => iterator(() => rooms.values()),
    [Symbol.iterator]: () => iterator(() => rooms.values()),
  } as unknown as ReadonlySet<string>;
  return Object.freeze(view);
}

function toVoidPromise(result: unknown): Promise<void> {
  return Promise.resolve(result).then(() => undefined);
}

/**
 * Track every adapter-backed room mutation for one physical socket. An auth
 * boundary waits for prior mutations and room removals before the next session
 * can be published. This matters for cluster adapters, whose join/leave
 * operations can be asynchronous.
 */
export class SocketSessionRoomManager {
  private readonly pending = new Set<Promise<void>>();
  private failureCount = 0;
  private readonly acknowledgements = new Map<
    symbol,
    (...args: any[]) => void
  >();
  private boundaryQueue: Promise<void> = Promise.resolve();

  constructor(private readonly socket: RawSocket) {}

  join(room: string | string[]): Promise<void> {
    return this.track(() => this.socket.join(room));
  }

  leave(room: string): Promise<void> {
    return this.track(() => this.socket.leave(room));
  }

  private track(action: () => unknown): Promise<void> {
    let operation: Promise<void>;
    try {
      operation = toVoidPromise(action());
    } catch (error) {
      operation = Promise.reject(error);
    }

    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => {
        this.pending.delete(operation);
        this.failureCount++;
      },
    );
    return operation;
  }

  registerAcknowledgement(
    acknowledgement: (...args: any[]) => void,
    isSessionCurrent: () => boolean,
  ): { callback: (...args: any[]) => void; release: () => void } {
    const id = Symbol("socket-session-ack");
    this.acknowledgements.set(id, acknowledgement);
    return {
      callback: (...args) => {
        const active = this.acknowledgements.get(id);
        this.acknowledgements.delete(id);
        if (active && isSessionCurrent()) active(...args);
      },
      release: () => {
        this.acknowledgements.delete(id);
      },
    };
  }

  /** Release handler closures retained by outstanding outbound acknowledgements. */
  invalidateSessionOutputs(): void {
    this.acknowledgements.clear();
  }

  /**
   * Serialize auth-boundary cleanup. The caller must invalidate the logical
   * session before invoking this method and must fail closed if it rejects.
   */
  clearForBoundary(): Promise<void> {
    // Socket.IO may retain outbound acknowledgement wrappers until the peer
    // answers. Release the original handler closures synchronously so they
    // cannot retain prior-session data across the boundary.
    this.invalidateSessionOutputs();

    const clear = async () => {
      let failureCount = 0;

      while (this.pending.size > 0) {
        await Promise.allSettled([...this.pending]);
      }
      failureCount += this.failureCount;
      this.failureCount = 0;

      const rooms = [...this.socket.rooms].filter(
        (room) => room !== this.socket.id,
      );
      const results = await Promise.allSettled(
        rooms.map((room) => {
          try {
            return toVoidPromise(this.socket.leave(room));
          } catch (error) {
            return Promise.reject(error);
          }
        }),
      );
      for (const result of results) {
        if (result.status === "rejected") failureCount++;
      }

      if (failureCount > 0) {
        throw new Error(
          `Socket room cleanup failed (${failureCount} operation${
            failureCount === 1 ? "" : "s"
          })`,
        );
      }
    };

    const cleanup = this.boundaryQueue.then(clear, clear);
    this.boundaryQueue = cleanup.catch(() => undefined);
    return cleanup;
  }
}

/**
 * Restrict a Socket.IO emitter to the session that created the handler
 * context. Chained room/broadcast emitters retain the same guard.
 */
export function createSessionFencedEmitter(
  emitter: RawEmitter,
  isSessionCurrent: () => boolean,
  boundary: SocketSessionRoomManager,
): SocketContextEmitter {
  const wrap = (next: RawEmitter) =>
    createSessionFencedEmitter(next, isSessionCurrent, boundary);

  return {
    emit(event, ...args) {
      if (!isSessionCurrent()) return false;
      const guardedArgs = [...args];
      const acknowledgement = guardedArgs.at(-1);
      let registered:
        | { callback: (...args: any[]) => void; release: () => void }
        | undefined;
      if (typeof acknowledgement === "function") {
        registered = boundary.registerAcknowledgement(
          acknowledgement,
          isSessionCurrent,
        );
        guardedArgs[guardedArgs.length - 1] = registered.callback;
      }
      try {
        const emitted = Boolean(emitter.emit(event, ...guardedArgs));
        if (!emitted) registered?.release();
        return emitted;
      } catch (error) {
        registered?.release();
        throw error;
      }
    },
    to: (room) => wrap(emitter.to(room)),
    in: (room) => wrap(emitter.in(room)),
    except: (room) => wrap(emitter.except(room)),
    timeout: (ms) => wrap(emitter.timeout(ms)),
    get volatile() {
      return wrap(emitter.volatile);
    },
  };
}

/**
 * Session-fenced compatibility facade for route.on() handlers. It preserves
 * common Socket.IO emit/room operations without exposing raw transport handles
 * that could bypass the authorization boundary.
 */
export function createSessionFencedSocket(
  socket: RawSocket,
  isSessionCurrent: () => boolean,
  roomManager: SocketSessionRoomManager,
): SocketContextSocket {
  const emitter = createSessionFencedEmitter(
    socket,
    isSessionCurrent,
    roomManager,
  );
  const handshake = sanitizedHandshake(socket.handshake);
  const rooms = sessionRoomsView(socket.rooms, isSessionCurrent);

  return {
    ...emitter,
    id: socket.id,
    handshake,
    rooms,
    get broadcast() {
      return createSessionFencedEmitter(
        socket.broadcast,
        isSessionCurrent,
        roomManager,
      );
    },
    join: async (room) => {
      if (!isSessionCurrent()) return;
      await roomManager.join(room);
    },
    leave: async (room) => {
      if (!isSessionCurrent()) return;
      await roomManager.leave(room);
    },
    disconnect: (close) => {
      if (isSessionCurrent()) socket.disconnect(close);
    },
  };
}
