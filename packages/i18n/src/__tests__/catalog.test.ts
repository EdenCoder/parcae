import { describe, expect, it } from "vitest";
import { setupI18n } from "@lingui/core";
import { normalizeCatalog } from "../index";

describe("normalizeCatalog", () => {
  it("flattens nested objects into dotted ids", () => {
    expect(
      normalizeCatalog({ editor: { action: { turnInto: "Turn into" } } }),
    ).toEqual({ "editor.action.turnInto": "Turn into" });
  });

  it("rewrites i18next interpolation to ICU", () => {
    expect(normalizeCatalog({ hello: "Hi {{ name }}, you have {{count}}" })).toEqual(
      { hello: "Hi {name}, you have {count}" },
    );
  });

  it("folds plural siblings into one ICU message under the bare key", () => {
    expect(
      normalizeCatalog({
        showShots_one: "Show {{count}} shot",
        showShots_other: "Show {{count}} shots",
      }),
    ).toEqual({
      showShots: "{count, plural, one {Show {count} shot} other {Show {count} shots}}",
    });
  });

  it("emits CLDR categories in ICU order", () => {
    const { n } = normalizeCatalog({
      n_other: "other",
      n_few: "few",
      n_zero: "zero",
      n_many: "many",
      n_one: "one",
      n_two: "two",
    });
    expect(n).toBe(
      "{count, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}",
    );
  });

  it("keeps a bare sibling over the fold", () => {
    expect(
      normalizeCatalog({ items: "Items", items_one: "Item", items_other: "Items!" }),
    ).toEqual({ items: "Items" });
  });

  it("synthesizes `other` when a malformed catalog omits it", () => {
    expect(normalizeCatalog({ n_one: "one thing" })).toEqual({
      n: "{count, plural, one {one thing} other {one thing}}",
    });
  });

  // Inherent to i18next's convention: the suffix *is* the only signal, so a
  // key that merely ends in a category name folds too. Underscores that
  // aren't CLDR categories are untouched.
  it("folds any CLDR-suffixed key, and only those", () => {
    expect(normalizeCatalog({ make_zero: "x", some_key: "y" })).toEqual({
      make: "{count, plural, zero {x} other {x}}",
      some_key: "y",
    });
  });

  it("does not treat an object as a plural variant", () => {
    expect(normalizeCatalog({ group_one: { nested: "value" } })).toEqual({
      "group_one.nested": "value",
    });
  });

  it("stringifies numbers, booleans and arrays", () => {
    expect(normalizeCatalog({ n: 3, b: true, list: ["a", "b"] })).toEqual({
      n: "3",
      b: "true",
      list: "a, b",
    });
  });

  it("honours prefix, separator and pluralArg", () => {
    expect(
      normalizeCatalog(
        { a: { b_one: "one", b_other: "many" } },
        { prefix: "ns", separator: "/", pluralArg: "n" },
      ),
    ).toEqual({ "ns/a/b": "{n, plural, one {one} other {many}}" });
  });

  it("produces catalogs Lingui resolves for every plural branch", () => {
    const i18n = setupI18n({ missing: (_locale, id) => id });
    i18n.loadAndActivate({
      locale: "en",
      messages: normalizeCatalog({
        showShots_one: "Show {{count}} shot",
        showShots_other: "Show {{count}} shots",
      }),
    });
    expect(i18n._("showShots", { count: 1 })).toBe("Show 1 shot");
    expect(i18n._("showShots", { count: 3 })).toBe("Show 3 shots");
  });

  it("resolves the six-category locales that motivated the fold", () => {
    const i18n = setupI18n({ missing: (_locale, id) => id });
    i18n.loadAndActivate({
      locale: "ar",
      messages: normalizeCatalog({
        blocks_zero: "zero",
        blocks_one: "one",
        blocks_two: "two",
        blocks_few: "few",
        blocks_many: "many",
        blocks_other: "other",
      }),
    });
    expect(i18n._("blocks", { count: 1 })).toBe("one");
    expect(i18n._("blocks", { count: 2 })).toBe("two");
    expect(i18n._("blocks", { count: 3 })).toBe("few");
    expect(i18n._("blocks", { count: 11 })).toBe("many");
    // The bare key is present, so `missing` never fires.
    expect(i18n._("blocks", { count: 100 })).not.toBe("blocks");
  });

  it("keeps apostrophes literal rather than starting an ICU escape", () => {
    const i18n = setupI18n({ missing: (_locale, id) => id });
    i18n.loadAndActivate({
      locale: "fr",
      messages: normalizeCatalog({
        seen_one: "{{count}} ami l'a vu",
        seen_other: "{{count}} amis l'ont vu",
      }),
    });
    expect(i18n._("seen", { count: 1 })).toBe("1 ami l'a vu");
    expect(i18n._("seen", { count: 4 })).toBe("4 amis l'ont vu");
  });
});
