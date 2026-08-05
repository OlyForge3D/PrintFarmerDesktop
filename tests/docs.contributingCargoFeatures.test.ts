import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Guards the Rust command table in `docs/CONTRIBUTING.md`.
 *
 * The table used to say `cargo test` -> "Run sidecar tests". It does not: the
 * sidecar's optional modules are declared behind feature flags in
 * `native/model-core/src/lib.rs`, so a bare `cargo test` never compiles them and
 * never compiles their tests. Measured on model-core: 265 tests by default, 339
 * with `--features sqlite`. The 74 that vanish include every calibration
 * conflict-resolution test, and the runner reports `0 filtered out` for all of
 * them -- it cannot report tests it did not compile, so the incomplete run is
 * indistinguishable from a complete one by reading the output.
 *
 * Both arms below have to prove they found something before they assert
 * anything, because the failure this file exists to catch is an extractor that
 * silently matches nothing:
 *
 *   - the source arm greps lib.rs for the feature gates. If it matches nothing
 *     it fails on the non-empty assertion, not by quietly agreeing.
 *   - the doc arm greps the command table. Same.
 *
 * The two arms are deliberately NOT compared to each other. A symmetric
 * comparison passes when both sides go empty. Each side is asserted against a
 * literal instead.
 *
 * This test is about the *gating*, not the counts. Counts move every time
 * someone adds a test, so a count assertion here would be noise; the durable
 * fact is that the modules are optional and the doc says so. If someone ungates
 * a module, this goes red -- and the correct fix is to update the warning in the
 * doc, not to delete this test.
 */

const REPO_ROOT = resolve(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('docs/CONTRIBUTING.md describes what cargo test actually runs', () => {
  it('still has the feature gates the warning is about', () => {
    const libSource = read('native/model-core/src/lib.rs');

    const gated = [...libSource.matchAll(/#\[cfg\(feature = "(\w+)"\)\]/g)].map(
      (match) => match[1],
    );

    // Proves the extractor matched something before anything is concluded from
    // it. A regex that silently matched nothing would otherwise let every
    // assertion below pass by vacuity.
    expect(
      gated.length,
      'no #[cfg(feature = "...")] gate was found in lib.rs, so this extractor is broken rather than the source having changed',
    ).toBeGreaterThan(0);

    expect(
      gated,
      'sqlite is no longer feature-gated in lib.rs; if that is intended, the cargo test warning in docs/CONTRIBUTING.md is now wrong and should be updated',
    ).toContain('sqlite');
    expect(gated).toContain('step');
  });

  it('does not claim the bare command runs the sidecar suite', () => {
    const doc = read('docs/CONTRIBUTING.md');

    const bareRow = /\|\s*`cargo test`\s*\|([^|]*)\|/.exec(doc);

    expect(
      bareRow,
      'no `cargo test` row was found in docs/CONTRIBUTING.md, so this extractor is broken rather than the row having a bad description',
    ).not.toBeNull();
    if (bareRow === null) return;

    const purpose = bareRow[1]?.trim() ?? '';

    expect(purpose.length).toBeGreaterThan(0);
    expect(
      purpose.toLowerCase(),
      `the cargo test row describes itself as "${purpose}", which reads as the whole sidecar suite; it compiles out every feature-gated module`,
    ).not.toBe('run sidecar tests');
    expect(purpose.toLowerCase()).toContain('default');
  });

  it('documents the feature-gated invocations a contributor has to run instead', () => {
    const doc = read('docs/CONTRIBUTING.md');

    for (const feature of ['sqlite', 'step']) {
      expect(
        doc,
        `docs/CONTRIBUTING.md does not show how to run the ${feature} tests, so a contributor following it would never run them`,
      ).toContain(`cargo test --features ${feature}`);
    }
  });
});
