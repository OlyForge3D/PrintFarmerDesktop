import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { assertNoForeignMutationWindow } from './mutationWindowGuard';

// Runs before any suite in this process. A run that is reading another
// process's half-applied mutation is stopped here, where the cause is still
// visible, rather than surfacing later as an unreproducible failure in
// whichever test happened to guard the mutated line.
assertNoForeignMutationWindow();

// The check above cannot see a window that opens *after* this process starts,
// and that gap was measured: one run in seven still failed as a phantom defect
// because the mutation landed mid-run. A mutation window stays open for a whole
// suite run, so re-checking at every test boundary overlaps it and converts the
// phantom into the named cause.
afterEach(assertNoForeignMutationWindow);
