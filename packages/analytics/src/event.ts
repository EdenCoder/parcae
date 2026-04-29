/**
 * @parcae/analytics — Event stream
 *
 * `analytics_event` is the append-only fact table that every patient
 * signal lands in. One row per real-world event (a meal logged, a nudge
 * acknowledged, a wearable sync). Snapshots roll these up; detectors
 * scan them; contracts read both.
 *
 * Schema invariants:
 * - `subject` is the patient id for patient-scoped events; otherwise the
 *   user id. Indexed so per-patient slices are cheap.
 * - `dimensions` is structured JSONB but small — never PHI text.
 * - `occurred_at` is the real-world timestamp. The runner's `now` and
 *   the row's `createdAt` (set by Postgres `default now()`) can drift
 *   from it. Always read `occurred_at`, not `createdAt`, in queries.
 *
 * The `@metric.event()` decorator wraps a Parcae after-hook so event
 * capture stays inline with the lifecycle hook that produces it. The
 * call site declares the key + dimension extractor; this module owns
 * insertion.
 */

import type { ModelConstructor } from "@parcae/model";
import { hook, type HookContext } from "@parcae/backend";

export type EventSource = "mobile" | "web" | "wearable" | "system";

export interface AnalyticsEvent {
  id: string;
  org: string;
  subject: string;
  key: string;
  occurredAt: Date;
  source: EventSource;
  dimensions: Record<string, unknown>;
  createdAt: Date;
}

export interface EventCaptureSpec<M = unknown> {
  /** Event key, e.g. `"activity.logged"`. Hierarchical with `.`-separators. */
  key: string;
  /**
   * Pull the org id off the model. Required — analytics_event is org-scoped.
   * Always returns a string; throw if the model is in an unexpected state.
   */
  org: (model: M) => string;
  /**
   * Pull the subject id off the model. Defaults to the patient id when the
   * model has a `patient` ref, otherwise the user id. Override for org-
   * level events (e.g. clinician actions where the subject is the
   * clinician, not the patient they touched).
   */
  subject?: (model: M) => string;
  /** When the event happened. Defaults to `model.createdAt` or now. */
  occurredAt?: (model: M) => Date;
  /** Where the event came from. Default `"system"`. */
  source?: EventSource | ((model: M) => EventSource);
  /**
   * Structured dimension values. Keep this small — never PHI text. The
   * runner enforces a 4KB ceiling at insert time to prevent drift.
   */
  dimensions?: (model: M) => Record<string, unknown>;
  /**
   * Skip emission for some rows. Returns `false` to drop. Useful for
   * "first save only" semantics or filtering recurring template rows.
   */
  when?: (model: M, ctx: HookContext) => boolean | Promise<boolean>;
  /** Which lifecycle action(s) emit. Default `["create"]`. */
  on?: Array<"create" | "save" | "update" | "patch">;
}

const MAX_DIMENSIONS_BYTES = 4 * 1024;

export interface EventEmitter {
  emit(event: Omit<AnalyticsEvent, "id" | "createdAt">): Promise<void>;
}

let activeEmitter: EventEmitter | null = null;

/**
 * Wire the runtime emitter. Called from `createApp()` once Knex is
 * connected. The decorator captures references at registration time, so
 * setting this after-the-fact is fine — hooks fire later.
 */
export function setEventEmitter(emitter: EventEmitter | null): void {
  activeEmitter = emitter;
}

export function getEventEmitter(): EventEmitter | null {
  return activeEmitter;
}

/**
 * Fluent decorator. Registers an after-hook on the model that writes a
 * row into `analytics_event` whenever the configured action fires.
 *
 * @example
 * ```ts
 * import { metric } from "@parcae/analytics";
 *
 * metric.event(Activity, {
 *   key: "activity.logged",
 *   org: (a) => a.org,
 *   subject: (a) => a.$patient,
 *   dimensions: (a) => ({ activityType: a.activityType, quality: a.quality }),
 * });
 * ```
 */
export const metric = {
  event<M>(modelClass: ModelConstructor, spec: EventCaptureSpec<M>): void {
    const actions = spec.on ?? ["create"];
    const handler = async (ctx: HookContext): Promise<void> => {
      const emitter = activeEmitter;
      if (!emitter) return;
      const model = ctx.model as M;
      if (spec.when && !(await spec.when(model, ctx))) return;

      const dimensions = spec.dimensions?.(model) ?? {};
      if (byteLength(dimensions) > MAX_DIMENSIONS_BYTES) {
        throw new Error(
          `analytics_event dimensions exceeded ${MAX_DIMENSIONS_BYTES} bytes for key=${spec.key}`,
        );
      }
      await emitter.emit({
        org: spec.org(model),
        subject: spec.subject?.(model) ?? defaultSubject(model),
        key: spec.key,
        occurredAt:
          spec.occurredAt?.(model) ?? readDate(model, "createdAt") ?? new Date(),
        source:
          typeof spec.source === "function"
            ? spec.source(model)
            : (spec.source ?? "system"),
        dimensions,
      });
    };
    for (const action of actions) {
      hook.after(modelClass, action, handler, { async: true, priority: 200 });
    }
  },
};

function defaultSubject(model: unknown): string {
  const m = model as Record<string, unknown>;
  const patient = m.$patient ?? m.patient;
  if (typeof patient === "string") return patient;
  if (patient && typeof (patient as { id?: unknown }).id === "string") {
    return (patient as { id: string }).id;
  }
  const user = m.$user ?? m.user;
  if (typeof user === "string") return user;
  if (user && typeof (user as { id?: unknown }).id === "string") {
    return (user as { id: string }).id;
  }
  throw new Error(
    "metric.event: cannot resolve subject (no $patient or $user); supply spec.subject explicitly",
  );
}

function readDate(model: unknown, key: string): Date | undefined {
  const v = (model as Record<string, unknown>)[key];
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function byteLength(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj ?? {}), "utf8");
}
