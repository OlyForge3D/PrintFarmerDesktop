// A field with an initializer already has an own property with a real
// value, not `undefined` -- assigning to the prototype afterward would never
// have worked regardless of useDefineForClassFields, so this is a different
// (and already-visible) bug shape, not the silent one #270 names.
export class ConflictAdapter {
  readonly resolveConflict?: (id: string) => Promise<void> = async () => {
    /* default no-op */
  };
}
