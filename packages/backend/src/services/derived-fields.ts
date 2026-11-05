/**
 * derived-fields — what a read's `select` sends on the wire.
 *
 * A read sends only the columns it named, plus `id` and the `$ref`
 * companion of each ref it named: never a default for a column it left
 * out. It may also name a model's derived field (`static derivedFields`):
 * `select("parts")` takes every kind, `select("parts.text", "parts.step")`
 * only those. The SQL reads the field's `from` columns instead, and each
 * row gets the field after `sanitize()`. Only `select` names a derived
 * field; `where`, `orderBy` and the rest refuse it like any unknown column.
 */

import type { DerivedField, ModelConstructor, QueryStep } from "@parcae/model";
import { ClientError } from "../helpers";

/** A derived field one read picked. */
export interface ResolvedDerived {
  field : string;
  read  : DerivedField["read"];
  kinds : ReadonlySet<string>;
}

/** What a read's rows carry on the wire. */
export interface Selection {
  /** The columns its `select` named, with `id`; null when it named none, so every column goes. */
  columns : ReadonlySet<string> | null;
  derived : readonly ResolvedDerived[];
}

/** A read with no `select`: every column, nothing derived. */
export const WHOLE: Selection = { columns: null, derived: [] };

/** The steps with each picked derived field swapped for its columns, and what the read sends. */
export function pickSelection(
  ModelClass: ModelConstructor,
  steps: readonly QueryStep[],
): { steps: QueryStep[]; selection: Selection } {
  const fields = ModelClass.derivedFields ?? {};
  const picked = new Map<string, Set<string>>();
  let columns: Set<string> | null = null;
  let all = false;
  const swapped = steps.map((step) => {
    if (step.method !== "select") return step;
    let swaps = false;
    const args = (step.args ?? []).flat().flatMap((arg: unknown): unknown[] => {
      if (typeof arg !== "string") return [arg];
      // `*` sends every column, as no `select` does.
      if (arg === "*") all = true;
      columns ??= new Set(["id"]);
      const dot = arg.indexOf(".");
      const field = dot < 0 ? arg : arg.slice(0, dot);
      const kind = dot < 0 ? undefined : arg.slice(dot + 1);
      const derived = Object.prototype.hasOwnProperty.call(fields, field) ? fields[field]! : null;
      if (!derived) {
        columns.add(arg);
        return [arg];
      }
      if (kind !== undefined && !derived.kinds?.includes(kind)) {
        throw new ClientError(`Invalid column "${arg}" on model "${ModelClass.type}"`);
      }
      swaps = true;
      const kinds = picked.get(field) ?? new Set();
      for (const each of kind === undefined ? (derived.kinds ?? []) : [kind]) kinds.add(each);
      picked.set(field, kinds);
      return [...derived.from];
    });
    return swaps ? { ...step, args: [...new Set(args)] } : step;
  });
  const derived = [...picked].map(([field, kinds]) => ({ field, kinds, read: fields[field]!.read }));
  return { steps: swapped, selection: { columns: all ? null : columns, derived } };
}

/** Builds each picked field on a sanitized row, then keeps only what the read selected. */
export function projectSelection(row: Record<string, unknown>, { columns, derived }: Selection): void {
  for (const { field, read, kinds } of derived) row[field] = read(row, kinds);
  if (!columns) return;
  const kept = new Set([...columns, ...derived.map(({ field }) => field)]);
  for (const key of Object.keys(row)) {
    if (!kept.has(key) && !(key.startsWith("$") && columns.has(key.slice(1)))) delete row[key];
  }
}

/** The selection as a cache key beside the SQL, which names it whole unless a derived field reads columns of its own. */
export function selectionKey({ columns, derived }: Selection): string | undefined {
  if (derived.length === 0) return undefined;
  const picks = derived.map(({ field, kinds }) => `${field}.{${[...kinds].sort()}}`).sort();
  return `${picks.join("|")}-{${[...columns ?? []].sort()}}`;
}
