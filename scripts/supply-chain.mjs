// Supply-chain enumeration for PrintFarmer Desktop.
//
// This module derives *what ships* in each of the two dependency trees. It is
// deliberately a derivation rather than a curated list: every set below is
// computed from a committed lockfile or manifest, so adding a dependency
// changes the output without anyone remembering to update a list.
//
// Two things make the npm derivation sound, and both are enforced rather than
// assumed (see `tests/supplyChain.test.ts`):
//
//   1. The shipped roots are the lockfile's own root `dependencies`, plus any
//      Rollup `external` that resolves to an npm package. Externals are not
//      inlined into the bundles, so they must be supplied at runtime — for this
//      app that is `electron`, which is declared under `devDependencies` and
//      nevertheless ships as the entire Chromium/Node runtime.
//   2. Nothing under `src/` may import a bare specifier outside that set. If it
//      did, Rollup would inline a package the derivation does not list. The
//      guard turns "these are the shipped packages" from a claim into a
//      checkable property.
//
// Deliberately NOT used: `npm sbom --omit=dev`. Measured against the tree at
// `fb1f1c2`, it emitted 2 components (`three`, `zod`) and contained zero
// occurrences of `react`, `react-dom` or `scheduler`, while `npm ls --omit=dev
// --all` resolved 7 packages from the same lockfile and `package.json` declares
// all four of react/react-dom/three/zod as runtime `dependencies`. Two of the
// four declared runtime dependencies were absent from a document that presents
// as a complete production SBOM. `reconcileNpmProduction()` exists to fail on
// exactly that class of disagreement rather than to trust one mechanism.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Bare-specifier imports, keyed by the package they name.
 *
 * The prefix before `from` forbids quote characters so a match cannot run past
 * a string literal into unrelated code. An earlier draft used `[^;]*?`, which
 * matched across a JSX block and reported a fragment of markup as an imported
 * package.
 */
const IMPORT_PATTERNS = [
  /^\s*(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Turn an import specifier into the npm package it belongs to. */
export function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }
  return segments[0];
}

function listSourceFiles(directory, collected = []) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, collected);
    else if (SOURCE_EXTENSIONS.test(entry)) collected.push(full);
  }
  return collected;
}

/**
 * Every bare specifier imported beneath `directory`, mapped to the relative
 * files that import it. Relative paths and `node:` builtins are excluded.
 */
export function scanBareImports(directory) {
  const found = new Map();
  for (const file of listSourceFiles(directory)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
        if (specifier.startsWith('node:')) continue;
        const existing = found.get(specifier) ?? [];
        existing.push(file);
        found.set(specifier, existing);
      }
    }
  }
  return found;
}

/**
 * Resolve `name` as required from the package installed at `fromPath`, using
 * npm's own lookup order: the importer's own `node_modules` first, then each
 * ancestor's, ending at the root.
 */
function resolveLockEntry(lock, fromPath, name) {
  let prefix = fromPath;
  for (;;) {
    const candidate = prefix
      ? `${prefix}/node_modules/${name}`
      : `node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    // The root level is spelled with an empty prefix and has no leading
    // separator, so it must be tried explicitly after the last nested level.
    if (prefix === '') break;
    const cut = prefix.lastIndexOf('/node_modules/');
    prefix = cut === -1 ? '' : prefix.slice(0, cut);
  }
  return null;
}

/**
 * Rollup `external` entries across the Vite configs, restricted to those that
 * name an npm package. An external is not inlined into the bundle, so it has to
 * exist at runtime — which makes it a shipped component regardless of whether
 * the manifest files it under `dependencies` or `devDependencies`.
 */
export function readRollupExternals(repoRoot) {
  const externals = new Set();
  for (const entry of readdirSync(repoRoot)) {
    if (!/^vite\..*\.config\.(?:ts|mts|js|mjs)$/.test(entry)) continue;
    const text = readFileSync(path.join(repoRoot, entry), 'utf8');
    for (const block of text.matchAll(/external\s*:\s*\[([^\]]*)\]/g)) {
      for (const literal of block[1].matchAll(/['"]([^'"]+)['"]/g)) {
        const name = packageNameFromSpecifier(literal[1]);
        if (name) externals.add(name);
      }
    }
  }
  return externals;
}

/**
 * The transitive closure of `roots` over the lockfile's dependency edges.
 *
 * `peerDependencies` are followed because a peer that is present in the tree is
 * loaded at runtime exactly like a normal dependency; `devDependencies` of
 * transitive packages are not recorded in the lockfile and cannot ship.
 */
export function collectNpmClosure(lock, roots) {
  const components = new Map();
  const queue = [];

  for (const name of roots) {
    const entryPath = resolveLockEntry(lock, '', name);
    if (!entryPath) {
      throw new Error(
        `supply-chain: root dependency "${name}" has no package-lock.json entry`,
      );
    }
    queue.push(entryPath);
  }

  while (queue.length > 0) {
    const entryPath = queue.shift();
    if (components.has(entryPath)) continue;
    const entry = lock.packages[entryPath];
    components.set(entryPath, {
      name: entryPath.slice(
        entryPath.lastIndexOf('node_modules/') + 'node_modules/'.length,
      ),
      version: entry.version,
      license: entry.license,
      path: entryPath,
    });

    const edges = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
      ...(entry.peerDependencies ?? {}),
    };
    for (const dependencyName of Object.keys(edges)) {
      const resolved = resolveLockEntry(lock, entryPath, dependencyName);
      if (resolved && !components.has(resolved)) queue.push(resolved);
    }
  }

  return components;
}

/**
 * Path-alias prefixes configured in the Vite configs (for example `@shared`).
 * These resolve to files inside this repository, so they are first-party source
 * rather than third-party components.
 */
export function readViteAliases(repoRoot) {
  const aliases = new Set();
  for (const entry of readdirSync(repoRoot)) {
    if (!/^vite\..*\.config\.(?:ts|mts|js|mjs)$/.test(entry)) continue;
    const text = readFileSync(path.join(repoRoot, entry), 'utf8');
    for (const block of text.matchAll(/alias\s*:\s*\{([\s\S]*?)\}/g)) {
      for (const key of block[1].matchAll(/['"]([^'"]+)['"]\s*:/g)) {
        aliases.add(key[1]);
      }
    }
  }
  return aliases;
}

/** True when `specifier` resolves through a first-party path alias. */
export function isAliasedSpecifier(specifier, aliases) {
  for (const alias of aliases) {
    if (specifier === alias || specifier.startsWith(`${alias}/`)) return true;
  }
  return false;
}

/** The npm packages that reach a released artifact, derived from the lockfile. */
export function deriveShippedNpmComponents(lock, repoRoot) {
  const declared = Object.keys(lock.packages['']?.dependencies ?? {});
  const components = collectNpmClosure(lock, declared);

  // Rollup externals are added as leaf components and their npm dependency
  // edges are deliberately NOT followed. An external is satisfied by the host
  // runtime, not by npm resolution: `electron`'s own dependencies
  // (`@electron/get`, `@types/node`, `fs-extra`, …) exist to download and
  // unpack a prebuilt binary at install time and are absent from the packaged
  // app. Following them would list six build-time packages as shipped, which is
  // the same over-claim as listing feature-gated Rust crates. What the binary
  // itself embeds — Chromium and Node — is covered by `ELECTRON_LICENSE.txt`
  // and `LICENSES.chromium.html`, which `scripts/stage-compliance.mjs` copies
  // out of `node_modules/electron/dist` into `resources/compliance/`.
  const externals = [...readRollupExternals(repoRoot)].sort();
  for (const name of externals) {
    const entryPath = resolveLockEntry(lock, '', name);
    if (!entryPath) {
      throw new Error(
        `supply-chain: Rollup external "${name}" has no package-lock.json entry`,
      );
    }
    if (components.has(entryPath)) continue;
    const entry = lock.packages[entryPath];
    components.set(entryPath, {
      name,
      version: entry.version,
      license: entry.license,
      path: entryPath,
      runtimeProvided: true,
    });
  }

  return {
    declared: [...declared].sort(),
    externals,
    components,
  };
}

/**
 * Cross-check the lockfile-derived production set against a second, independent
 * enumeration (the object printed by `npm ls --omit=dev --all --json`).
 *
 * Returns the symmetric difference. A non-empty result means two mechanisms
 * reading the same lockfile disagree about what is in the product, and the
 * caller must fail rather than pick one.
 */
export function reconcileNpmProduction(lock, npmLsTree) {
  const fromLock = new Set();
  const declared = Object.keys(lock.packages['']?.dependencies ?? {});
  for (const component of collectNpmClosure(lock, declared).values()) {
    fromLock.add(`${component.name}@${component.version}`);
  }

  const fromLs = new Set();
  const walk = (node) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (child.version) fromLs.add(`${name}@${child.version}`);
      walk(child);
    }
  };
  walk(npmLsTree);

  return {
    fromLock,
    fromLs,
    missingFromLs: [...fromLock].filter((id) => !fromLs.has(id)).sort(),
    missingFromLock: [...fromLs].filter((id) => !fromLock.has(id)).sort(),
  };
}

/**
 * The cargo feature set that reaches a release, read from the two places that
 * actually build it rather than restated here.
 *
 * `scripts/stage-sidecar.mjs` builds the sidecar that `electron-forge package`
 * stages, and `.github/workflows/release.yml` builds the one published on a
 * tag. If those two ever disagree, the SBOM would describe a configuration that
 * nothing ships, so the caller compares them instead of picking one.
 */
export function readShippedCargoFeatures(repoRoot) {
  const stageText = readFileSync(
    path.join(repoRoot, 'scripts', 'stage-sidecar.mjs'),
    'utf8',
  );
  const stageMatch = /'--features'\s*,\s*'([^']+)'/.exec(stageText);

  const releaseText = readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  const releaseMatch = /cargo build[^\n]*?--features\s+([A-Za-z0-9_,-]+)/.exec(
    releaseText,
  );

  const split = (value) =>
    value
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .sort()
      : null;

  return {
    fromStagingScript: split(stageMatch?.[1]),
    fromReleaseWorkflow: split(releaseMatch?.[1]),
  };
}

/**
 * The crates that reach the shipped sidecar binary, walked from
 * `cargo metadata`'s feature-resolved graph.
 *
 * Only `normal` dependency edges are followed. `dev` edges are test-only, and
 * `build` edges run on the build machine rather than shipping inside the
 * binary — six crates in this tree are build-only. Optional crates that the
 * shipped feature set does not enable (`truck-*` behind `step`, `lib3mf-ffi`
 * behind `lib3mf`) never appear, which is the point: resolving with
 * `--all-features` would list crates the release binary does not contain.
 *
 * Proc-macro crates ARE included even though their own code runs at compile
 * time, because they generate code that does ship and an advisory against one
 * is worth surfacing. They are flagged so a consumer can tell them apart.
 */
export function deriveShippedCargoComponents(metadata) {
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodesById = new Map(
    metadata.resolve.nodes.map((node) => [node.id, node]),
  );
  const rootId = metadata.resolve.root;
  if (!rootId) {
    throw new Error(
      'supply-chain: cargo metadata has no resolve.root; run it against a package manifest, not the virtual workspace',
    );
  }

  const reached = new Set();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (reached.has(id)) continue;
    reached.add(id);
    for (const dep of nodesById.get(id)?.deps ?? []) {
      const isNormal = dep.dep_kinds.some(
        (entry) => (entry.kind ?? 'normal') === 'normal',
      );
      if (isNormal && !reached.has(dep.pkg)) queue.push(dep.pkg);
    }
  }
  reached.delete(rootId);

  const components = new Map();
  for (const id of reached) {
    const pkg = packagesById.get(id);
    components.set(id, {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      source: pkg.source ?? null,
      links: pkg.links ?? null,
      procMacro: pkg.targets.some((target) =>
        target.kind.includes('proc-macro'),
      ),
    });
  }

  return {
    root: packagesById.get(rootId)?.name ?? null,
    components,
    // Crates declaring `links` compile and embed a native (non-Rust) library,
    // so the artifact contains code that appears in NEITHER package graph as a
    // component of its own. Detected from cargo's own metadata rather than
    // from a maintained list, so a newly introduced `-sys` crate shows up
    // without anyone remembering to add it.
    nativeLibraries: [...components.values()]
      .filter((component) => component.links !== null)
      .sort((a, b) => a.name.localeCompare(b.name)),
    nonRegistrySources: [...components.values()]
      .filter(
        (component) =>
          component.source === null ||
          !component.source.startsWith('registry+'),
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** CycloneDX package URL for an npm component, scope-encoded per the spec. */
export function encodeNpmPurl(name, version) {
  if (name.startsWith('@')) {
    const [scope, bare] = name.split('/');
    return `pkg:npm/${encodeURIComponent(scope)}/${bare}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

/** A CycloneDX licence node: an SPDX id when it is one, else an expression. */
function licenseNode(expression) {
  if (!expression) return undefined;
  return /[\s()/]/.test(expression)
    ? [{ expression }]
    : [{ license: { id: expression } }];
}

/**
 * Assemble the CycloneDX document from both trees plus the native libraries
 * that belong to neither.
 *
 * The document is deterministic by construction: components are sorted by
 * `bom-ref`, there is no wall-clock timestamp, and the serial number is a
 * digest of the component set. Identical inputs therefore produce identical
 * bytes, and any change to what ships changes the serial number.
 */
export function buildSbom({ lock, repoRoot, cargoMetadata, features }) {
  const npm = deriveShippedNpmComponents(lock, repoRoot);
  const cargo = deriveShippedCargoComponents(cargoMetadata);
  const components = [];

  for (const component of npm.components.values()) {
    const purl = encodeNpmPurl(component.name, component.version);
    components.push({
      type: 'library',
      'bom-ref': purl,
      name: component.name,
      version: component.version,
      purl,
      licenses: licenseNode(component.license),
      properties: [
        { name: 'printfarmer:ecosystem', value: 'npm' },
        {
          name: 'printfarmer:delivery',
          value: component.runtimeProvided ? 'runtime-external' : 'bundled',
        },
      ],
    });
  }

  for (const component of cargo.components.values()) {
    const purl = `pkg:cargo/${component.name}@${component.version}`;
    components.push({
      type: 'library',
      'bom-ref': purl,
      name: component.name,
      version: component.version,
      purl,
      licenses: licenseNode(component.license),
      properties: [
        { name: 'printfarmer:ecosystem', value: 'cargo' },
        {
          name: 'printfarmer:delivery',
          value: component.procMacro ? 'compile-time' : 'bundled',
        },
      ],
    });
  }

  // Native libraries compiled into the sidecar by `-sys` crates. These are not
  // packages in either ecosystem, so without an explicit entry the document
  // would omit compiled C that is genuinely present in the shipped binary.
  for (const component of cargo.nativeLibraries) {
    components.push({
      type: 'library',
      'bom-ref': `pkg:generic/${component.links}?vendored-by=${component.name}@${component.version}`,
      name: component.links,
      version: `bundled-by-${component.name}@${component.version}`,
      purl: `pkg:generic/${component.links}`,
      properties: [
        { name: 'printfarmer:ecosystem', value: 'native' },
        { name: 'printfarmer:delivery', value: 'statically-linked' },
        {
          name: 'printfarmer:vendored-by',
          value: `${component.name}@${component.version}`,
        },
      ],
    });
  }

  components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

  const rootManifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const digest = createHash('sha256')
    .update(components.map((component) => component['bom-ref']).join('\n'))
    .digest('hex');
  const serial = [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join('-');

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': encodeNpmPurl(rootManifest.name, rootManifest.version),
        name: rootManifest.name,
        version: rootManifest.version,
        licenses: licenseNode(rootManifest.license),
      },
      properties: [
        {
          name: 'printfarmer:cargo-features',
          value: [...features].sort().join(','),
        },
        {
          name: 'printfarmer:npm-roots',
          value: [...npm.declared, ...npm.externals].sort().join(','),
        },
      ],
    },
    components,
  };
}
