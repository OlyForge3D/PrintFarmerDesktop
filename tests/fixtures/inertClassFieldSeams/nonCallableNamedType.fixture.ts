// Negative control for the callable-interface/type-alias resolution: a named
// type that is NOT callable (an ordinary data interface, and a type alias to
// a plain object shape) must not be flagged just because it is a type
// reference. Only type aliases/interfaces that are themselves callable
// should resolve as function-typed.
interface ConflictOptions {
  timeoutMs: number;
}

type ConflictLabel = string;

export class ConflictAdapterWithDataTypes {
  readonly options?: ConflictOptions;
  readonly label?: ConflictLabel;

  constructor(options?: ConflictOptions) {
    if (options) {
      this.options = options;
    }
  }
}
