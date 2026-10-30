/**
 * derived-fields — a model's named shapes (`static derivedFields`) on the wire.
 *
 * A read names one in `select`: `select("parts")` takes every kind,
 * `select("parts.text", "parts.step")` only those. The SQL reads the
 * field's `from` columns instead, and each row gets the field after
 * `sanitize()`. A `from` column the read didn't select itself is read
 * for the field and never sent. Only `select` names a derived field;
 * `where`, `orderBy` and the rest refuse it like any unknown column.
 */

import type { DerivedField, ModelConstructor, QueryStep } from "@parcae/model";
import { ClientError } from "../helpers";

/** A derived field one read picked. */
export interface ResolvedDerived {
  field : string;
  read  : DerivedField["read"];
  kinds : ReadonlySet<string>;
  /** Its `from` columns the read didn't select itself. */
  drop  : readonly string[];
}

/** The steps with each picked derived field swapped for its columns, and what was picked. */
export function pickDerived(
  ModelClass: ModelConstructor,
  steps: readonly QueryStep[],
): { steps: QueryStep[]; derived: ResolvedDerived[] } {
  const fields = ModelClass.derivedFields ?? {};
  const picked = new Map<string, Set<string>>();
  const selected = new Set<string>();
  const swapped = steps.map((step) => {
    if (step.method !== "select") return step;
    let swaps = false;
    const args = (step.args ?? []).flat().flatMap((arg: unknown): unknown[] => {
      if (typeof arg !== "string") return [arg];
      const dot = arg.indexOf(".");
      const field = dot < 0 ? arg : arg.slice(0, dot);
      const kind = dot < 0 ? undefined : arg.slice(dot + 1);
      const derived = Object.prototype.hasOwnProperty.call(fields, field) ? fields[field]! : null;
      if (!derived) {
        selected.add(arg);
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
  const derived = [...picked].map(([field, kinds]) => ({
    field,
    kinds,
    read : fields[field]!.read,
    drop : fields[field]!.from.filter((column) => !selected.has(column)),
  }));
  return { steps: swapped, derived };
}

/** Builds each picked field on a sanitized row, then drops the columns only it asked for. */
export function projectDerived(
  row: Record<string, unknown>,
  derived: readonly ResolvedDerived[],
): void {
  for (const { field, read, kinds } of derived) row[field] = read(row, kinds);
  for (const { drop } of derived) for (const column of drop) delete row[column];
}

/** The picks as a cache key: order-free, so the same read in another order shares a hash. */
export function derivedKey(derived: readonly ResolvedDerived[]): string {
  return derived
    .map(({ field, kinds, drop }) => `${field}.{${[...kinds].sort()}}-{${[...drop].sort()}}`)
    .sort()
    .join("|");
}
