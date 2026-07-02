/**
 * hydrate-expansions — inline ref rows into wire payloads.
 *
 * `.expand("file")` on the client records a `QueryStep` that the
 * route handler peels off `__query` before replaying SQL steps.
 * After the LIST query returns its sanitized rows, this module
 * walks the recorded projections and mutates each row in place so
 * the `file` field becomes an embedded object instead of a raw id:
 *
 *     // before — every row carries a raw id, client useFile()-s it
 *     { id: "pa_abc", file: "f_xyz", ... }
 *
 *     // after `.expand("file")`
 *     { id: "pa_abc", file: { type: "file", id: "f_xyz", url: "...", ... },
 *       $file: "f_xyz", ... }
 *
 * Batching is delegated to the request-scoped `RefLoader`
 * (`services/ref-loader.ts`) — one `WHERE id IN (...)` per ref-type
 * regardless of how many rows or how many distinct ref fields are
 * being expanded.
 *
 * Projection: `.expand("file.url")` instead of `.expand("file")`
 * trims the embedded object to `{ id, type, url }`. Mixing a bare
 * `"file"` with `"file.url"` promotes to whole-row (bare wins).
 *
 * The raw id is preserved on the wire as `$file` alongside the
 * embedded object so the frontend lazy-ref-proxy contract stays
 * intact — the accessor pair `(file, $file)` is the same shape the
 * client has used, regardless of whether the row was
 * expanded.
 *
 * Errors:
 *   - Unknown spec syntax → `ClientError` (400). Triggers the route
 *     handler's standard error responder.
 *   - Unknown ref field   → `ClientError` (400).
 *   - Non-ref field       → `ClientError` (400).
 *   - Unknown projected field on the target → `ClientError` (400).
 *   - Schema-less target  → silently skipped (defensive — should not
 *     happen with the schema resolver, but we don't want a runtime
 *     crash to take down a hot LIST endpoint).
 *
 * Subscription emit path uses the same helper — see
 * `services/subscriptions.ts`. Realtime invalidation is **naive** in
 * v1: any change to a linked-row column wakes every subscriber that
 * expanded the parent ref, regardless of which fields they
 * projected (field-aware invalidation is a follow-up).
 */

import type {
  ModelConstructor,
  SchemaDefinition,
} from "@parcae/model";
import { ClientError } from "../helpers";
import type { RefLoader } from "./ref-loader";

// ─── Spec parsing ────────────────────────────────────────────────────────────

/**
 * Parsed projection for a single ref field. `whole: true` means
 * "emit the full sanitize() output"; otherwise emit only `fields`
 * (always including `id` + `type`, which `sanitize()` already
 * stamps).
 */
export interface ExpandFieldSpec {
  whole: boolean;
  fields: Set<string>;
}

export type ExpandSpec = Map<string, ExpandFieldSpec>;

/**
 * Parse a flat list of expand specs into a Map keyed by the ref
 * field name. Recognises:
 *   - `"file"`           — whole-row.
 *   - `"file.url"`       — projection of one field.
 *   - `"file.url, file.mime"` — comma-separated multi-field; the
 *      tokens are still split per element of the input array, this
 *      is what happens when a single string contains commas.
 *
 * Bare-ref takes precedence over per-field projections on the
 * same ref: `.expand("file", "file.url")` → whole row.
 *
 * Exported for the subscription manager hash builder — it needs a
 * canonical, deterministic representation to derive a hash that
 * doesn't drift when the same client repeats the same expand in a
 * different order.
 */
export function parseExpandSpecs(
  specs: readonly string[],
): ExpandSpec {
  const out: ExpandSpec = new Map();
  for (const rawSpec of specs) {
    // Tolerate "file.url, file.mime" as a single arg — split on
    // commas, then process each segment. Frontend typically passes
    // separate args, but a stray comma shouldn't 400 the request.
    const tokens =
      rawSpec.indexOf(",") >= 0
        ? rawSpec.split(",").map((t) => t.trim()).filter(Boolean)
        : [rawSpec.trim()];
    for (const token of tokens) {
      if (!token) continue;
      const dotIdx = token.indexOf(".");
      if (dotIdx < 0) {
        // Bare ref → whole-row, even if a prior token had projections.
        out.set(token, { whole: true, fields: new Set() });
        continue;
      }
      const refField = token.slice(0, dotIdx).trim();
      const refColumn = token.slice(dotIdx + 1).trim();
      if (!refField || !refColumn) {
        throw new ClientError(`Invalid expand spec "${token}"`);
      }
      if (refColumn.includes(".")) {
        // v1 supports one hop only: `expand("file.url")` works,
        // `expand("project.user.email")` doesn't — chained ref
        // resolution requires schema-walking the target. Deferred
        // until a real call site needs it.
        throw new ClientError(
          `Nested expand not supported in v1: "${token}". Use one hop only.`,
        );
      }
      const existing = out.get(refField);
      if (existing?.whole) continue; // bare ref already won
      if (existing) {
        existing.fields.add(refColumn);
      } else {
        out.set(refField, { whole: false, fields: new Set([refColumn]) });
      }
    }
  }
  return out;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * One validated expand directive: which field on the parent model,
 * which target model class to batch-load via `RefLoader`, which
 * fields to project (empty Set ⇒ whole row).
 */
export interface ResolvedExpand {
  refField: string;
  targetType: string;
  targetClass: ModelConstructor;
  projection: ReadonlySet<string> | null; // null ⇒ whole-row
}

/**
 * Validate every parsed spec against the model schema and resolve
 * the target model class for each ref. Throws `ClientError` on the
 * first bad spec so the route handler can map to a 400 via its
 * standard error responder.
 *
 * `models` is the adapter's `_models` registry (type → constructor).
 * We accept it as a `Map` rather than coupling to BackendAdapter so
 * tests can build a minimal stub without spinning up an adapter.
 */
export function validateExpandSpecs(
  specs: ExpandSpec,
  modelClass: ModelConstructor,
  models: ReadonlyMap<string, ModelConstructor>,
): ResolvedExpand[] {
  if (specs.size === 0) return [];
  const schema =
    (modelClass.__schema as SchemaDefinition | undefined) ?? {};
  const resolved: ResolvedExpand[] = [];
  for (const [refField, field] of specs) {
    const col = schema[refField];
    if (
      !col ||
      typeof col === "string" ||
      col.kind !== "ref" ||
      !col.target
    ) {
      throw new ClientError(
        `Cannot expand "${refField}": not a ref field on ${modelClass.type}`,
      );
    }
    const targetType = col.target.type;
    if (!targetType) {
      throw new ClientError(
        `Cannot expand "${refField}": ref target on ${modelClass.type} has no type discriminator`,
      );
    }
    // Prefer the live registry constructor (carries the real
    // sanitize, the resolved `__schema`, etc.) over the ts-morph
    // resolver's stub which only has `{ type }`. Falls back to the
    // stub if the registry lookup misses — defensive only.
    const targetClass = models.get(targetType) ?? col.target;
    if (!field.whole) {
      const targetSchema =
        (targetClass.__schema as SchemaDefinition | undefined) ?? null;
      if (targetSchema) {
        const validTargetCols = new Set<string>([
          "id",
          "type",
          "createdAt",
          "updatedAt",
          ...Object.keys(targetSchema),
        ]);
        for (const proj of field.fields) {
          if (!validTargetCols.has(proj)) {
            throw new ClientError(
              `Cannot expand "${refField}.${proj}": "${proj}" is not a column on ${targetType}`,
            );
          }
        }
      }
    }
    resolved.push({
      refField,
      targetType,
      targetClass,
      projection: field.whole ? null : new Set(field.fields),
    });
  }
  return resolved;
}

// ─── Wire mutation ───────────────────────────────────────────────────────────

/**
 * Sanitized wire row shape. The caller hands us the output of
 * `projectForWire` (or the subscription-emit equivalent), and we
 * mutate it in place to embed the linked rows.
 */
type WireRow = Record<string, any>;

/**
 * Source of truth used by `hydrateExpansions` to find the ref id
 * for each row. We don't assume `row[refField]` is a string — by
 * the time we run, the sanitize path may already have started
 * mutating, and a row whose `file` field has been replaced with an
 * object should still resolve via the row's `$file` accessor or
 * its original id.
 */
function rowRefId(row: WireRow, refField: string): string | null {
  const dollar = row[`$${refField}`];
  if (typeof dollar === "string" && dollar.length > 0) return dollar;
  const direct = row[refField];
  if (typeof direct === "string" && direct.length > 0) return direct;
  if (
    direct &&
    typeof direct === "object" &&
    typeof direct.id === "string"
  ) {
    return direct.id;
  }
  return null;
}

/**
 * Project a sanitized linked row down to the requested field set.
 * `id` and `type` are always included so the frontend ref-proxy
 * can hydrate a stable identity even from a heavily-projected
 * payload.
 */
function projectFields(
  sanitized: Record<string, any>,
  projection: ReadonlySet<string>,
): Record<string, any> {
  const out: Record<string, any> = {};
  // id + type are non-negotiable identity columns. Without them
  // the frontend's pre-hydration path in Model.hydrate has nothing
  // to anchor the ref-proxy to.
  if (sanitized.id !== undefined) out.id = sanitized.id;
  if (sanitized.type !== undefined) out.type = sanitized.type;
  for (const field of projection) {
    if (field === "id" || field === "type") continue;
    if (field in sanitized) out[field] = sanitized[field];
  }
  return out;
}

/**
 * Mutate `items` in place so every requested ref field is inlined
 * as the linked sanitized row (or its projection). The raw id is
 * preserved at `$<refField>` so the frontend's `(file, $file)`
 * accessor pair still works regardless of expansion.
 *
 * Loading goes through the request-scoped `RefLoader`: every
 * `loader.load(targetType, id)` call lands in the same microtask
 * batch and resolves through one `WHERE id IN (...)` per target
 * type. With N=100 rows expanding `file`, this is 1 query, not N.
 *
 * `sanitizeUser` is the request's user (for honouring `privateFields`
 * / self-vs-other projections on the target's `sanitize()`). The
 * route handler already has it.
 */
export async function hydrateExpansions(
  items: WireRow[],
  resolved: readonly ResolvedExpand[],
  loader: RefLoader,
  sanitizeUser: { id: string } | null | undefined,
): Promise<void> {
  if (items.length === 0 || resolved.length === 0) return;

  // Step 1: enqueue every (type, id) we need. RefLoader coalesces
  // the per-type batches into one query each — the awaits below
  // join the same scheduled microtask.
  const perFieldPromises = new Map<string, Promise<unknown>[]>();
  const idsPerField = new Map<string, (string | null)[]>();
  for (const exp of resolved) {
    const idList: (string | null)[] = [];
    const promises: Promise<unknown>[] = [];
    for (const row of items) {
      const id = rowRefId(row, exp.refField);
      idList.push(id);
      promises.push(loader.load(exp.targetType, id));
    }
    perFieldPromises.set(exp.refField, promises);
    idsPerField.set(exp.refField, idList);
  }

  // Step 2: settle the batches in parallel.
  await Promise.all(
    Array.from(perFieldPromises.values()).flat(),
  );

  // Step 3: write the embedded objects back. We re-await the
  // already-settled promises (sync at this point) so per-row
  // failures inside one expansion don't poison sibling expansions.
  for (const exp of resolved) {
    const promises = perFieldPromises.get(exp.refField)!;
    const idList = idsPerField.get(exp.refField)!;
    for (let i = 0; i < items.length; i++) {
      const row = items[i]!;
      const refId = idList[i];

      // Always stamp $<refField> with the raw id so frontend code
      // that reads `row.$file` (the accessor pair) keeps working
      // regardless of expansion. The bare `<refField>` slot then
      // holds the embedded object.
      row[`$${exp.refField}`] = refId ?? null;

      if (!refId) {
        row[exp.refField] = null;
        continue;
      }
      const loaded = (await promises[i]) as
        | { sanitize?: (user?: { id: string }) => Promise<Record<string, any>>; __data?: Record<string, any> }
        | null;
      if (!loaded) {
        row[exp.refField] = null;
        continue;
      }
      const sanitized: Record<string, any> =
        typeof loaded.sanitize === "function"
          ? await loaded.sanitize(sanitizeUser ?? undefined)
          : (loaded.__data ?? (loaded as unknown as Record<string, any>));
      row[exp.refField] = exp.projection
        ? projectFields(sanitized, exp.projection)
        : sanitized;
    }
  }
}

// ─── Hash key for subscription deduplication ─────────────────────────────────

/**
 * Stable, order-independent canonical key for an expand list. Used
 * by the subscription manager so subscriptions for the same query
 * with the same projections collapse onto a single cached entry —
 * but subscriptions with different projections stay distinct so the
 * emit path can ship the right shape per consumer.
 *
 * Whole-row trumps projections: `"file"` ⇒ `"file"`, regardless of
 * any sibling `"file.url"`. Field projections are sorted within a
 * ref so `("file.url", "file.mime")` and `("file.mime", "file.url")`
 * collapse to the same key.
 */
export function expandHashKey(specs: ExpandSpec): string {
  if (specs.size === 0) return "";
  const refKeys = Array.from(specs.keys()).sort();
  const parts: string[] = [];
  for (const refKey of refKeys) {
    const field = specs.get(refKey)!;
    if (field.whole) {
      parts.push(refKey);
      continue;
    }
    const fields = Array.from(field.fields).sort();
    parts.push(`${refKey}.{${fields.join(",")}}`);
  }
  return parts.join("|");
}
