// The #270 seam shape can also be spelled via `typeof <identifier>`, where
// `<identifier>` resolves to an in-scope function -- `field?: typeof
// someFunction;` borrows the callable's type exactly as an inline function
// type or a named callable type alias/interface would, and is exactly as
// inert once shadowed by the emitted own `undefined` property.
function resolveConflict(id: string): Promise<void> {
  return Promise.resolve(id).then(() => undefined);
}
// Referenced as a value here (not just via `typeof` in the class below) so
// this fixture doesn't trip `no-unused-vars` for a symbol used only as a
// type query -- this reference lives outside the class and is unrelated to
// the self-assignment detection, which only looks inside the class body.
export const referencedResolveConflict = resolveConflict;

export class ConflictAdapterViaTypeof {
  readonly resolveConflict?: typeof resolveConflict;

  hasCapability(): boolean {
    return typeof this.resolveConflict === 'function';
  }
}
