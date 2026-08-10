// Negative control for `typeof` resolution: `typeof` on a non-callable
// value (a const string, a plain object) must not be flagged just because
// the type is spelled via a type query. Only `typeof <identifier>` where
// the identifier resolves to a function/arrow/function-expression should
// read as function-typed.
const defaultLabel = 'unresolved';
// Referenced as a value here (not just via `typeof` below) to avoid
// `no-unused-vars` for a symbol used only as a type query.
export const referencedDefaultLabel = defaultLabel;

export class ConflictAdapterWithTypeofData {
  readonly label?: typeof defaultLabel;

  constructor(label?: typeof defaultLabel) {
    if (label) {
      this.label = label;
    }
  }
}
