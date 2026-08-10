// Same #270 seam shape spelled via a callable interface (a call signature)
// rather than a type alias or an inline function type. `interface Handler {
// (id: string): Promise<void>; }` is just as callable, and just as inert
// once shadowed by the emitted own `undefined` property.
interface ResolveHandler {
  (id: string): Promise<void>;
}

export class ConflictAdapterViaInterface {
  readonly resolveConflict?: ResolveHandler;

  hasCapability(): boolean {
    return typeof this.resolveConflict === 'function';
  }
}
