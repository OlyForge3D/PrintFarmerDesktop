// @vitest-environment node

// Supply-chain enumeration gates.
//
// These tests are about ONE property: the set of components this project
// claims to ship is the set it actually ships. Two facts about this repository
// make that non-obvious, and they pull in opposite directions — so a check that
// only guards one of them would leave a document that still reads as complete:
//
//   * `electron` is declared under `devDependencies` and ships as the entire
//     Chromium/Node runtime. Filtering by manifest section UNDER-claims.
//   * `truck-*` and `lib3mf-ffi` are ordinary cargo dependencies that the
//     shipped feature set never enables. Resolving `--all-features`
//     OVER-claims.
//
// Names below state the axis each test varies, not the risk it has in mind.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSbom,
  compareByCodeUnit,
  deriveShippedCargoComponents,
  deriveShippedNpmComponents,
  isAliasedSpecifier,
  packageNameFromSpecifier,
  readShippedCargoFeatures,
  readViteAliases,
  reconcileNpmProduction,
  scanBareImports,
} from '../scripts/supply-chain.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readLock(): unknown {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
  );
}

function shippedNpmNames(): Set<string> {
  const { components } = deriveShippedNpmComponents(readLock(), repoRoot);
  return new Set([...components.values()].map((component) => component.name));
}

/**
 * A minimal `cargo metadata` document. Hand-built so the cargo derivation can
 * be driven through cases this repository does not currently contain (a
 * build-only edge, an unlisted `links` crate) without needing a Rust toolchain
 * in the Desktop CI job. `scripts/verify-sbom.mjs` exercises the same code
 * against real `cargo metadata` output in the Package smoke job, so the
 * derivation is never validated only against a fixture.
 */
function cargoMetadataFixture(
  options: { reachOptional?: boolean } = {},
): unknown {
  const pkg = (
    name: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: `${name} 1.0.0`,
    name,
    version: '1.0.0',
    license: 'MIT',
    source: 'registry+https://github.com/rust-lang/crates.io-index',
    targets: [{ kind: ['lib'], name }],
    ...extra,
  });

  // `optional-dep` models a crate whose feature is off: cargo still lists it in
  // `packages` and in `resolve.nodes` because it is in the lockfile, but at this
  // feature set no edge reaches it. `reachOptional` turns the feature on by
  // adding the only thing that differs — the inbound edge.
  const rootDeps: Record<string, unknown>[] = [
    { pkg: 'normal-dep 1.0.0', dep_kinds: [{ kind: null }] },
    { pkg: 'dev-dep 1.0.0', dep_kinds: [{ kind: 'dev' }] },
    { pkg: 'build-dep 1.0.0', dep_kinds: [{ kind: 'build' }] },
    { pkg: 'macro-dep 1.0.0', dep_kinds: [{ kind: null }] },
    { pkg: 'sys-dep 1.0.0', dep_kinds: [{ kind: null }] },
    { pkg: 'git-dep 1.0.0', dep_kinds: [{ kind: null }] },
  ];
  if (options.reachOptional) {
    rootDeps.push({ pkg: 'optional-dep 1.0.0', dep_kinds: [{ kind: null }] });
  }

  return {
    packages: [
      pkg('root', { id: 'root 1.0.0', source: null }),
      pkg('normal-dep'),
      pkg('transitive-dep'),
      pkg('dev-dep'),
      pkg('build-dep'),
      pkg('macro-dep', {
        targets: [{ kind: ['proc-macro'], name: 'macro-dep' }],
      }),
      pkg('sys-dep', { links: 'nativelib' }),
      pkg('git-dep', { source: 'git+https://example.invalid/x?rev=abc#abc' }),
      pkg('optional-dep'),
    ],
    resolve: {
      root: 'root 1.0.0',
      nodes: [
        { id: 'root 1.0.0', deps: rootDeps },
        {
          id: 'normal-dep 1.0.0',
          deps: [{ pkg: 'transitive-dep 1.0.0', dep_kinds: [{ kind: null }] }],
        },
        { id: 'transitive-dep 1.0.0', deps: [] },
        { id: 'dev-dep 1.0.0', deps: [] },
        { id: 'build-dep 1.0.0', deps: [] },
        { id: 'macro-dep 1.0.0', deps: [] },
        { id: 'sys-dep 1.0.0', deps: [] },
        { id: 'git-dep 1.0.0', deps: [] },
        { id: 'optional-dep 1.0.0', deps: [] },
      ],
    },
  };
}

describe('the shipped npm set is derived from the lockfile, not the manifest split', () => {
  it('includes a Rollup external that is declared under devDependencies', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, string> };

    // The premise: were this to move to `dependencies`, the test would still
    // pass but would stop proving anything, so it is asserted rather than
    // assumed.
    expect(Object.keys(manifest.devDependencies ?? {})).toContain('electron');
    expect(shippedNpmNames()).toContain('electron');
  });

  it('excludes devDependencies that no shipped module imports', () => {
    const shipped = shippedNpmNames();
    for (const name of [
      'vitest',
      'eslint',
      'typescript',
      'prettier',
      'jsdom',
    ]) {
      expect(shipped).not.toContain(name);
    }
  });

  it('excludes the install-time dependencies of a runtime-provided external', () => {
    // `electron`'s own npm dependencies exist to download and unpack a prebuilt
    // binary. Following them would list six build-time packages as shipped —
    // the same over-claim as resolving cargo with `--all-features`.
    const shipped = shippedNpmNames();
    expect(shipped).toContain('electron');
    for (const name of ['@electron/get', '@types/node', 'fs-extra']) {
      expect(shipped).not.toContain(name);
    }
  });

  it('resolves transitive packages that no manifest names directly', () => {
    // react -> loose-envify -> js-tokens. An enumeration that stopped at the
    // declared roots would report 4 packages and read as complete.
    const shipped = shippedNpmNames();
    for (const name of ['loose-envify', 'js-tokens', 'scheduler']) {
      expect(shipped).toContain(name);
    }
  });
});

describe('the derivation is sound because nothing outside the set is imported', () => {
  it('resolves every bare specifier under src/ to a shipped package, a first-party alias, or a node builtin', () => {
    const shipped = shippedNpmNames();
    const aliases = readViteAliases(repoRoot);
    const offenders: string[] = [];

    for (const [specifier, files] of scanBareImports(
      path.join(repoRoot, 'src'),
    )) {
      if (isAliasedSpecifier(specifier, aliases)) continue;
      const packageName = packageNameFromSpecifier(specifier);
      if (packageName !== null && shipped.has(packageName)) continue;
      offenders.push(
        `${specifier} (imported by ${files.length} file(s), e.g. ${path.relative(repoRoot, files[0] ?? '')})`,
      );
    }

    // A failure here means Rollup inlines a package the SBOM does not list.
    expect(offenders).toEqual([]);
  });

  it('finds the imports it is scanning for, so an empty offender list is not an empty scan', () => {
    // Guards the previous assertion against passing because the scan returned
    // nothing at all. A zero must be able to produce a counterexample.
    const imports = scanBareImports(path.join(repoRoot, 'src'));
    expect(imports.size).toBeGreaterThan(0);
    expect([...imports.keys()]).toContain('electron');
    expect([...imports.keys()]).toContain('zod');
  });

  it('treats a configured path alias as first-party source rather than a package', () => {
    const aliases = readViteAliases(repoRoot);
    expect(aliases).toContain('@shared');
    expect(isAliasedSpecifier('@shared/ipc', aliases)).toBe(true);
    expect(isAliasedSpecifier('@sharedother/ipc', aliases)).toBe(false);
    expect(isAliasedSpecifier('react', aliases)).toBe(false);
  });
});

describe('two independent enumerations of the production tree agree', () => {
  it('resolves the same package set from the lockfile as npm ls reports from the installed tree', () => {
    // npm's own `npm sbom --omit=dev` disagreed with both of these on this
    // tree: it emitted 2 components and omitted react and react-dom, which
    // package.json declares as runtime dependencies. A single mechanism cannot
    // notice that; this comparison is what would.
    // `npm ls` exits non-zero whenever it has anything to report (an extraneous
    // package, an unmet peer), while still printing a complete JSON tree. Using
    // the exit code here would make the comparison fail for reasons unrelated to
    // the thing being compared, so stdout is used and its absence — not its exit
    // status — is the failure. `execSync` puts stdout on the error it throws.
    let stdout: string;
    try {
      stdout = execSync('npm ls --omit=dev --all --json', {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      stdout = String((error as { stdout?: string }).stdout ?? '');
    }
    expect(stdout, 'npm ls produced no output to reconcile against').not.toBe(
      '',
    );
    const tree: unknown = JSON.parse(stdout);

    const reconciliation = reconcileNpmProduction(readLock(), tree);
    expect(reconciliation.fromLock.size).toBeGreaterThan(0);
    expect(reconciliation.missingFromLs).toEqual([]);
    expect(reconciliation.missingFromLock).toEqual([]);
  });
});

describe('the cargo set is bound to the feature set that actually ships', () => {
  it('builds the same cargo features when packaging as when releasing', () => {
    const { fromStagingScript, fromReleaseWorkflow } =
      readShippedCargoFeatures(repoRoot);
    expect(fromStagingScript).not.toBeNull();
    expect(fromReleaseWorkflow).not.toBeNull();
    expect(fromStagingScript).toEqual(fromReleaseWorkflow);
  });

  it('follows normal edges while excluding dev-only and build-only ones', () => {
    const { components } = deriveShippedCargoComponents(cargoMetadataFixture());
    const names = new Set([...components.values()].map((c) => c.name));

    expect(names).toContain('normal-dep');
    expect(names).toContain('transitive-dep');
    expect(names).not.toContain('dev-dep');
    expect(names).not.toContain('build-dep');
    expect(names).not.toContain('root');
  });

  // The dev/build exclusions above are also satisfied by walking `packages` and
  // filtering on edge kind, which would list every crate in the lockfile
  // regardless of feature. These two pin reachability instead: the pair differs
  // in exactly one inbound edge, so absence below is caused by the feature
  // being off rather than by optional crates being dropped wholesale.
  it('omits a crate that is in the lockfile but unreachable at this feature set', () => {
    const { components } = deriveShippedCargoComponents(cargoMetadataFixture());
    const listed = (cargoMetadataFixture() as { packages: { name: string }[] })
      .packages;

    // Asserted, not assumed: absence from the closure only means anything if
    // cargo did report the crate.
    expect(listed.map((p) => p.name)).toContain('optional-dep');
    expect([...components.values()].map((c) => c.name)).not.toContain(
      'optional-dep',
    );
  });

  it('includes that same crate once an edge reaches it, so the feature set is a live variable', () => {
    const { components } = deriveShippedCargoComponents(
      cargoMetadataFixture({ reachOptional: true }),
    );
    expect([...components.values()].map((c) => c.name)).toContain(
      'optional-dep',
    );
  });

  it('reports a crate that links a native library so a non-package component cannot be dropped', () => {
    const derived = deriveShippedCargoComponents(cargoMetadataFixture());
    expect(derived.nativeLibraries.map((c) => c.name)).toEqual(['sys-dep']);
    expect(derived.nativeLibraries[0]?.links).toBe('nativelib');
  });

  it('reports a dependency resolved from outside the crates.io registry', () => {
    const derived = deriveShippedCargoComponents(cargoMetadataFixture());
    expect(derived.nonRegistrySources.map((c) => c.name)).toEqual(['git-dep']);
  });

  it('marks proc-macro crates as compile-time rather than dropping them', () => {
    const derived = deriveShippedCargoComponents(cargoMetadataFixture());
    const macro = [...derived.components.values()].find(
      (c) => c.name === 'macro-dep',
    );
    expect(macro?.procMacro).toBe(true);
  });
});

describe('the SBOM document covers both ecosystems in one file', () => {
  const sbom = () =>
    buildSbom({
      lock: readLock(),
      repoRoot,
      cargoMetadata: cargoMetadataFixture(),
      features: ['sqlite'],
    });

  it('carries npm, cargo and native components rather than a single ecosystem', () => {
    const ecosystems = new Set(
      sbom().components.map(
        (component) =>
          component.properties.find(
            (property) => property.name === 'printfarmer:ecosystem',
          )?.value,
      ),
    );
    expect([...ecosystems].sort()).toEqual(['cargo', 'native', 'npm']);
  });

  it('produces byte-identical output for identical inputs', () => {
    expect(JSON.stringify(sbom())).toBe(JSON.stringify(sbom()));
  });

  it('changes the serial number when a component is added', () => {
    const baseline = sbom();
    const metadata = cargoMetadataFixture() as {
      packages: Record<string, unknown>[];
      resolve: { nodes: { id: string; deps: unknown[] }[] };
    };
    metadata.packages.push({
      id: 'added-dep 1.0.0',
      name: 'added-dep',
      version: '1.0.0',
      license: 'MIT',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
      targets: [{ kind: ['lib'], name: 'added-dep' }],
    });
    metadata.resolve.nodes[0]?.deps.push({
      pkg: 'added-dep 1.0.0',
      dep_kinds: [{ kind: null }],
    });
    metadata.resolve.nodes.push({ id: 'added-dep 1.0.0', deps: [] });

    const mutated = buildSbom({
      lock: readLock(),
      repoRoot,
      cargoMetadata: metadata,
      features: ['sqlite'],
    });

    expect(mutated.components.length).toBe(baseline.components.length + 1);
    expect(mutated.serialNumber).not.toBe(baseline.serialNumber);
  });

  it('records the outbound licence of the application itself', () => {
    expect(JSON.stringify(sbom().metadata.component.licenses)).toContain(
      'AGPL-3.0-only',
    );
  });
});

describe('component ordering is locale-independent, so the document is byte-reproducible across runners', () => {
  // The SBOM's entire verification model is byte-identical regeneration: the CI
  // gate regenerates the document and fails unless it matches the staged file
  // exactly. `localeCompare` breaks that silently — its result depends on the
  // runner's ICU version and default locale, so two machines can sort identical
  // inputs into two byte-different, semantically-identical SBOMs. verify-sbom
  // regenerates and compares inside ONE job, so the single check that would
  // notice the drift is the one check that structurally cannot. These pin the
  // ordering to UTF-16 code units, which the language defines identically on
  // every platform.
  const byCodeUnitInline = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;

  it('orders non-ASCII identifiers by UTF-16 code unit, not by host locale collation', () => {
    // Scrambled input. The expected result is Unicode code-unit order — the same
    // on every platform. `\u00C4` (196) and `\u00FC` (252) sort AFTER every
    // ASCII letter by code unit, and uppercase `Z` (90) sorts before lowercase
    // `a` (97); en-US collation instead folds case and diacritics, producing a
    // different order (asserted distinct below so the expectation is not
    // vacuous).
    const scrambled = [
      '\u00C4ht\u00E4ri', // Ähtäri
      'banana',
      'Zephyr',
      'apple',
      'Z\u00FCrich', // Zürich
    ];

    const byCodeUnit = [...scrambled].sort(compareByCodeUnit);
    expect(byCodeUnit).toEqual([
      'Zephyr',
      'Z\u00FCrich',
      'apple',
      'banana',
      '\u00C4ht\u00E4ri',
    ]);

    // The teeth: en-US collation orders the same list differently, so reverting
    // the comparator to `localeCompare` would produce THIS and fail the
    // assertion above. Confirmed distinct here rather than assumed.
    const byLocale = [...scrambled].sort((a, b) => a.localeCompare(b));
    expect(byLocale).not.toEqual(byCodeUnit);
  });

  it('emits SBOM components in code-unit order when a crate name diverges under locale collation', () => {
    // A crate whose name begins with U+00C4 sorts LAST among these three by code
    // unit but FIRST under en-US collation (which folds it to 'a'). The emitted
    // order must be the former; otherwise two runners with different ICU builds
    // regenerate byte-different documents that verify-sbom cannot distinguish.
    const crate = (name: string) => ({
      id: `${name} 1.0.0`,
      name,
      version: '1.0.0',
      license: 'MIT',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
      targets: [{ kind: ['lib'], name }],
    });
    const metadata = {
      packages: [
        {
          id: 'root 1.0.0',
          name: 'root',
          version: '1.0.0',
          license: 'MIT',
          source: null,
          targets: [{ kind: ['lib'], name: 'root' }],
        },
        crate('Zephyr'),
        crate('apple'),
        crate('\u00C4ht\u00E4ri'),
      ],
      resolve: {
        root: 'root 1.0.0',
        nodes: [
          {
            id: 'root 1.0.0',
            deps: [
              { pkg: 'Zephyr 1.0.0', dep_kinds: [{ kind: null }] },
              { pkg: 'apple 1.0.0', dep_kinds: [{ kind: null }] },
              { pkg: '\u00C4ht\u00E4ri 1.0.0', dep_kinds: [{ kind: null }] },
            ],
          },
          { id: 'Zephyr 1.0.0', deps: [] },
          { id: 'apple 1.0.0', deps: [] },
          { id: '\u00C4ht\u00E4ri 1.0.0', deps: [] },
        ],
      },
    };

    const built = buildSbom({
      lock: readLock(),
      repoRoot,
      cargoMetadata: metadata,
      features: ['sqlite'],
    });
    const refs = built.components.map((component) => component['bom-ref']);

    // The whole document is in code-unit order. The expectation is computed with
    // an independent inline comparator so it does not lean on the code under
    // test to define correctness.
    expect(refs).toEqual([...refs].sort(byCodeUnitInline));

    // And the diverging cargo names specifically land in code-unit order rather
    // than the locale order, which would put the U+00C4 crate first.
    const cargoRefs = refs.filter((ref) => ref.startsWith('pkg:cargo/'));
    expect(cargoRefs).toEqual([
      'pkg:cargo/Zephyr@1.0.0',
      'pkg:cargo/apple@1.0.0',
      'pkg:cargo/\u00C4ht\u00E4ri@1.0.0',
    ]);
  });
});
