// A required field must be supplied at construction, so there is no
// "silently absent capability" for useDefineForClassFields to hide.
export class ConflictAdapter {
  readonly resolveConflict: (id: string) => Promise<void>;

  constructor(resolveConflict: (id: string) => Promise<void>) {
    this.resolveConflict = resolveConflict;
  }
}
