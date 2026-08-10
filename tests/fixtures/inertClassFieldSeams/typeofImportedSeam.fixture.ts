// Vasquez's review finding on PR #706 (round 3): `typeof` resolution must
// also work through an import, not just a same-file identifier. `field?:
// typeof importedSeam;` where `importedSeam` is imported from another module
// is exactly as callable, and exactly as inert once shadowed, as a same-file
// `typeof` reference -- the real type checker resolves this correctly
// because module/import resolution is exactly what it is built to do.
import { importedSeam } from './typeofImportedSeam.helper.fixture';

export class ImportedSeamAdapter {
  readonly resolveConflict?: typeof importedSeam;

  hasCapability(): boolean {
    return typeof this.resolveConflict === 'function';
  }
}
