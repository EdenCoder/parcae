/**
 * @parcae/analytics — ActivityEvent base
 *
 * Typed wrapper around `analytics_event` rows. App code subclasses
 * this to project a typed "subject + key + dimensions" tuple onto the
 * raw row, so detectors and meta-analyses can read structured fields
 * without re-parsing JSONB at every call site.
 *
 * Freia subclasses this as `PatientActivityEvent` to attach the
 * patient-shaped key vocabulary (`activity.logged`, `nudge.sent`,
 * `nudge.responded`, etc.) and the dimensions schema for each.
 *
 * The class itself does no I/O — it's a typed view over a row. The
 * `query()` static walks `analytics_event` filtered by the subclass's
 * known keys, returning typed instances.
 */

import type { Knex } from "knex";
import type { AnalyticsEvent, EventSource } from "./event.js";
import { ANALYTICS_EVENT_TABLE } from "./schema.js";

export interface ActivityEventQuery {
  org?: string;
  subject?: string | string[];
  key?: string | string[];
  /** `>= since` */
  since?: Date;
  /** `< until` */
  until?: Date;
  limit?: number;
}

export abstract class ActivityEvent<
  Dimensions extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly id: string;
  readonly org: string;
  readonly subject: string;
  readonly key: string;
  readonly occurredAt: Date;
  readonly source: EventSource;
  readonly dimensions: Dimensions;
  readonly createdAt: Date;

  constructor(row: AnalyticsEvent) {
    this.id = row.id;
    this.org = row.org;
    this.subject = row.subject;
    this.key = row.key;
    this.occurredAt = row.occurredAt;
    this.source = row.source;
    this.dimensions = row.dimensions as Dimensions;
    this.createdAt = row.createdAt;
  }

  /** Closed event vocabulary. Empty means all keys are accepted. */
  static readonly keys: readonly string[] = [];

  /**
   * Walk `analytics_event`, returning instances of the calling
   * subclass. `keys` is applied in SQL before ordering and limiting.
   */
  static async query<E extends ActivityEvent>(
    this: new (row: AnalyticsEvent) => E,
    db: Knex,
    q: ActivityEventQuery = {},
  ): Promise<E[]> {
    let query = db<AnalyticsEvent>(ANALYTICS_EVENT_TABLE).select("*");
    if (q.org) query = query.where("org", q.org);
    if (q.subject) {
      query = Array.isArray(q.subject)
        ? query.whereIn("subject", q.subject)
        : query.where("subject", q.subject);
    }
    if (q.key) {
      query = Array.isArray(q.key)
        ? query.whereIn("key", q.key)
        : query.where("key", q.key);
    }
    const acceptedKeys = (
      this as unknown as { keys?: readonly string[] }
    ).keys;
    if (acceptedKeys?.length) {
      query = query.whereIn("key", acceptedKeys);
    }
    if (q.since) query = query.where("occurredAt", ">=", q.since);
    if (q.until) query = query.where("occurredAt", "<", q.until);
    query = query.orderBy("occurredAt", "desc");
    if (q.limit) query = query.limit(q.limit);

    const rows = await query;
    const ctor = this;
    return rows.map((r) => {
        const dimensions =
          typeof r.dimensions === "string"
            ? JSON.parse(r.dimensions)
            : (r.dimensions ?? {});
        return new ctor({ ...r, dimensions });
      });
  }
}
