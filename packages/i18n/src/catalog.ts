/**
 * Catalog normalization — i18next-shaped JSON in, ICU message source out.
 *
 * Translation vendors and most hand-authored catalogs speak i18next: nested
 * objects, `{{name}}` interpolation, and plural variants split across sibling
 * `key_one` / `key_other` entries. Lingui speaks ICU: one flat message per
 * key, `{name}` interpolation, and plurals expressed *inside* the message as
 * `{count, plural, ...}`.
 *
 * The sibling-key difference is the one that fails silently. Loading such a
 * catalog verbatim leaves no entry under the bare key call sites ask for
 * (`i18n._("action.showShots", { count })`), so Lingui's `missing` handler
 * runs and the key id itself is what renders.
 *
 * The output is ICU *source*, not a compiled catalog — `i18n.load()` accepts
 * it directly, and callers that precompile can map their own
 * `compileMessage` over the result without this package depending on
 * Lingui's compiler.
 */

/** CLDR plural categories, in the order ICU expects them. */
const pluralCategories = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
] as const;

type PluralCategory = (typeof pluralCategories)[number];

const pluralSuffix = /_(zero|one|two|few|many|other)$/;

const interpolation = /\{\{\s*([\w.]+)\s*\}\}/g;

export interface NormalizeCatalogOptions {
  /** Joins nested keys into a flat id. Default: `"."`. */
  separator?: string;
  /** Argument name folded plurals select on. Default: `"count"`. */
  pluralArg?: string;
  /**
   * Prefix for every id — typically the namespace when catalogs are split
   * per file. Default: none.
   */
  prefix?: string;
}

/**
 * Flatten an i18next-shaped catalog into ICU message source keyed by dotted
 * id.
 *
 * - nested objects collapse to `a.b.c`
 * - `{{name}}` becomes `{name}`
 * - `key_one` / `key_other` siblings fold into one `{count, plural, ...}`
 *   message under `key`
 * - numbers and booleans stringify; arrays join with `", "`
 */
export function normalizeCatalog(
  catalog: unknown,
  options: NormalizeCatalogOptions = {},
): Record<string, string> {
  const messages: Record<string, string> = {};
  visit(messages, options.prefix ?? "", catalog, options);
  return messages;
}

function visit(
  messages: Record<string, string>,
  prefix: string,
  value: unknown,
  options: NormalizeCatalogOptions,
): void {
  if (typeof value === "string") {
    if (prefix) messages[prefix] = toIcuMessage(value);
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    if (prefix) messages[prefix] = String(value);
    return;
  }

  if (Array.isArray(value)) {
    if (prefix) messages[prefix] = toIcuMessage(value.map(String).join(", "));
    return;
  }

  if (!value || typeof value !== "object") return;

  const separator = options.separator ?? ".";
  // Sibling plural variants are gathered rather than emitted, so the fold
  // below can see every category before writing the bare key.
  const plurals = new Map<string, Map<PluralCategory, string>>();

  for (const [key, child] of Object.entries(value)) {
    const match = typeof child === "string" ? pluralSuffix.exec(key) : null;
    if (match) {
      const base = key.slice(0, match.index);
      let variants = plurals.get(base);
      if (!variants) {
        variants = new Map();
        plurals.set(base, variants);
      }
      variants.set(match[1] as PluralCategory, child as string);
      continue;
    }
    visit(messages, prefix ? `${prefix}${separator}${key}` : key, child, options);
  }

  for (const [base, variants] of plurals) {
    const id = prefix ? `${prefix}${separator}${base}` : base;
    // A bare sibling of the same name is authored intent — it wins over the
    // fold rather than being silently clobbered.
    if (id in messages) continue;
    messages[id] = pluralMessage(variants, options.pluralArg ?? "count");
  }
}

function pluralMessage(
  variants: Map<PluralCategory, string>,
  pluralArg: string,
): string {
  const present = pluralCategories.filter((category) => variants.has(category));
  const branches = present.map(
    (category) => `${category} {${toIcuMessage(variants.get(category) ?? "")}}`,
  );
  // ICU rejects a plural without `other`. A catalog missing it is malformed,
  // but degrading to the last variant present beats throwing at load time
  // and blanking every string in the locale.
  if (!variants.has("other")) {
    const last = present[present.length - 1];
    branches.push(`other {${last ? toIcuMessage(variants.get(last) ?? "") : ""}}`);
  }
  return `{${pluralArg}, plural, ${branches.join(" ")}}`;
}

/** i18next `{{name}}` → ICU `{name}`. */
function toIcuMessage(message: string): string {
  return message.replace(interpolation, "{$1}");
}
