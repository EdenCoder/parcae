/**
 * Type-level test for hook context typing.
 *
 * Asserts that hook.before/after thread the model class's instance type
 * into the handler so ctx.model carries the runtime-installed $ref string
 * accessors (it is WithRefs<Instance>) WITHOUT any cast, via two forms:
 *  - inline arrow handlers, where the model type is inferred; and
 *  - named handlers annotated `HookContext<Model>` (no explicit WithRefs).
 *
 * Checked by `tsc --noEmit` (the package typecheck includes src) but NOT
 * run by vitest (its include matches only `*.test.ts`), so the uncalled
 * functions below have no runtime effect and never touch the hook registry.
 */

import { Model, type Ref } from "@parcae/model";
import { type HookContext, hook } from "../routing/hook";

class Owner extends Model {
  static type = "owner" as const;
}

class TypingProbe extends Model {
  static type = "typing-probe" as const;
  owner!: Ref<Owner>;
  title = "";
}

// 0 extends 1 & T is only true when T is `any`.
type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;

// A named handler annotated with the bare model type. HookContext applies
// WithRefs internally, so `model.$owner` is typed without spelling WithRefs.
function namedProbe({ model }: HookContext<TypingProbe>): void {
  type ModelNotAny = Assert<IsAny<typeof model> extends true ? false : true>;
  const modelNotAny: ModelNotAny = true;
  const owner: string = model.$owner;
  const title: string = model.title;
  void owner;
  void title;
  void modelNotAny;
}

// Never invoked. Exists purely so tsc validates the inferred ctx types.
export function __hookTypingProbe(): void {
  // A named handler typed `HookContext<TypingProbe>` is accepted by the
  // typed overload.
  hook.after(TypingProbe, "save", namedProbe);

  // Inline handlers infer the model type from the class argument.
  hook.before(TypingProbe, "remove", (ctx) => {
    type ModelNotAny = Assert<
      IsAny<typeof ctx.model> extends true ? false : true
    >;
    const modelNotAny: ModelNotAny = true;
    const owner: string = ctx.model.$owner;
    void owner;
    void modelNotAny;
  });
}
