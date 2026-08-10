// The actual fix shape: `declare` suppresses the emitted own-property, so
// assigning to the prototype from outside the class works as intended.
export class ConflictAdapter {
  declare readonly resolveConflict?: (id: string) => Promise<void>;

  hasCapability(): boolean {
    return typeof this.resolveConflict === 'function';
  }
}
