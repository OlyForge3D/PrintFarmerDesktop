// The #270 seam shape can also be spelled through a named callable type
// instead of an inline function-type literal. A field typed `Handler`
// (a type alias for a function type) is exactly as inert under
// `useDefineForClassFields` as `(id: string) => Promise<void>` written
// inline -- assigning a callable to the prototype is shadowed by the same
// own `undefined` property either way.
type ResolveHandler = (id: string) => Promise<void>;

export class ConflictAdapterViaAlias {
  readonly resolveConflict?: ResolveHandler;

  hasCapability(): boolean {
    return typeof this.resolveConflict === 'function';
  }
}
