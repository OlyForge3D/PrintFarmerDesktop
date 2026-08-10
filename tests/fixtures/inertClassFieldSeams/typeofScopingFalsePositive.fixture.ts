// Ripley's review finding on PR #706 (round 3): the earlier name-based
// `typeof` resolution matched an identifier anywhere in the file by text,
// not by lexical scope -- so an out-of-scope callable sharing a name with
// an in-scope non-callable binding could cause a false positive. Here,
// `typeof helper` in the field's type position must resolve to the
// module-level, non-callable `helper` constant in scope at that point, NOT
// the unrelated, differently-scoped, callable `helper` declared inside
// `someMethod` below. A real type checker resolves this correctly because
// it is exactly the scope resolution TypeScript performs for real code; a
// name-based text match across the whole file cannot distinguish the two.
const helper = 'not callable';
export const referencedHelper = helper;

export class ScopingAdapter {
  readonly label?: typeof helper;

  someMethod(): void {
    const helper = (): void => {
      /* a same-named, but lexically distinct, callable binding */
    };
    helper();
  }
}
