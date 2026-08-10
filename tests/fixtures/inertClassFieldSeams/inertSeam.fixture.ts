// Reproduces calibrationService.ts's original #270 shape: an optional,
// function-typed field meant to be patched onto the prototype later, never
// assigned by the class itself, and not `declare`d.
export class ConflictAdapter {
  readonly resolveConflict?: (id: string) => Promise<void>;

  hasCapability(): boolean {
    return typeof this.resolveConflict === 'function';
  }
}
