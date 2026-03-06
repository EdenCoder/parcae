/**
 * Model invalidation — tracks which sockets watch which model types.
 *
 * When a socket GETs /v1/projects, it's registered as watching "project".
 * When a project is saved/patched/removed, all watching sockets get
 * an "invalidate" event for that type. The client refetches.
 *
 * No data in the event. No diffs. Just "your cache is stale, refetch."
 */

import type { Server as SocketServer } from "socket.io";

export class InvalidationService {
  // modelType → set of socket IDs
  private watchers = new Map<string, Set<string>>();
  private io: SocketServer;

  constructor(io: SocketServer) {
    this.io = io;
  }

  /** Register a socket as watching a model type. */
  watch(socketId: string, modelType: string): void {
    let set = this.watchers.get(modelType);
    if (!set) {
      set = new Set();
      this.watchers.set(modelType, set);
    }
    set.add(socketId);
  }

  /** Remove a socket from all watch lists (disconnect cleanup). */
  unwatch(socketId: string): void {
    for (const set of this.watchers.values()) {
      set.delete(socketId);
    }
  }

  /** Notify all sockets watching this model type to refetch. */
  invalidate(modelType: string): void {
    const set = this.watchers.get(modelType);
    if (!set || set.size === 0) return;

    for (const socketId of set) {
      this.io.to(socketId).emit(`invalidate:${modelType}`);
    }
  }
}
