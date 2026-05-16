import { randomUUID } from "node:crypto";
import type { PubSub } from "./pubsub";
import type { QuerySubscriptionManager } from "./subscriptions";

/**
 * Channel name for cross-process model-change broadcasts.
 *
 * Payload shape carried by this channel:
 *   { type: string; originatorId: string }
 *
 * `originatorId` is the per-process UUID of the BackendAdapter that
 * published the event. Each receiving process skips the dispatch when
 * the inbound `originatorId` matches its own bus instance's id. The
 * originating replica already ran the local fast-path in `notify()`
 * and must not re-evaluate when its own emit loops back through Redis.
 */
const MODEL_CHANGE_CHANNEL = "model:change";

export interface ModelChangePayload {
  type: string;
  originatorId: string;
}

/**
 * Per-process bridge between in-process subscription re-evaluation
 * and cross-process model-change broadcasts.
 *
 * Without this bridge, a save on replica A only re-evaluates the
 * cached queries in A's local QuerySubscriptionManager. A `useQuery`
 * socket pinned to replica B never learns about the change. With the
 * bridge, every replica's manager re-runs its own (scope-baked)
 * cached queries against the database whenever any replica writes,
 * and each replica emits ops to its own local sockets.
 */
export class ModelChangeBus {
  readonly originatorId = randomUUID();

  constructor(
    private readonly pubsub: PubSub | null,
    private readonly subscriptions: Pick<
      QuerySubscriptionManager,
      "onModelChange"
    >,
  ) {
    if (pubsub) {
      pubsub.on(MODEL_CHANGE_CHANNEL, (payload: ModelChangePayload) => {
        if (payload.originatorId === this.originatorId) return;
        subscriptions.onModelChange(payload.type);
      });
    }
  }

  /**
   * Called by BackendAdapter on every save/patch/remove. Runs the
   * local fast-path immediately so the originating replica reacts
   * with zero added latency, then broadcasts so other replicas
   * re-evaluate their own subscriptions on the next tick.
   */
  notify(modelType: string): void {
    this.subscriptions.onModelChange(modelType);
    this.pubsub?.emit?.(MODEL_CHANGE_CHANNEL, {
      type: modelType,
      originatorId: this.originatorId,
    });
  }
}
