// CI check: known vulnerability advisories affecting SHIPPED dependencies.
//
// This is a LIVE-DATABASE gate (docs/security/THREAT_MODEL.md T4.2). Unlike the
// licence gate it consults data fetched at run time, so an advisory published
// today could fail a pull request that changed nothing. That is why the CI job
// wiring is non-required and this runs in "report" mode by default: it SURFACES
// findings (GitHub `::warning::` annotations) without failing the merge.
//
// The gate is still a real gate, not decoration:
//   * `--mode block` exits non-zero on any blocking advisory. The evaluator that
//     decides "blocking" is unit-tested from both sides of the threshold in
//     tests/supplyChainPolicy.test.ts, so the gate is proven able to fail.
//   * An inability to audit — tool missing, unparseable output, registry
//     unreachable — is NEVER a silent pass. It exits non-zero in BOTH modes, so
//     "could not check" reads as a red job, not a green one. Converting a loud
//     failure into a quiet one is the exact anti-pattern this repo has ruled out.
//
// Advisories are SCOPED to the shipped SBOM closure by package NAME: `cargo
// audit` reads the whole workspace lock, which contains crates (truck-*,
// lib3mf-ffi) the shipped feature set never compiles in.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  advisoryEnforcement,
  evaluateCargoSbomCoverage,
  evaluateAdvisories,
  evaluateNpmSbomCoverage,
  normalizeCargoAudit,
  normalizeNpmAudit,
  scopeToShippedClosure,
  validateSupplyChainPolicy,
} from './supply-chain-policy.mjs';
import {
  readCargoMetadata,
  readNpmProductionTree,
  resolveShippedFeatures,
} from './generate-sbom.mjs';
import { readImportedNpmComponents } from './supply-chain.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const DEFAULT_SBOM = path.join(repoRoot, 'build', 'sbom.cdx.json');
const cargoLock = path.join(repoRoot, 'native', 'Cargo.lock');
export const NPM_AUDIT_ARGS = Object.freeze(['audit', '--json']);

function parseArgs(argv) {
  const options = { mode: null, sbom: DEFAULT_SBOM };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--mode') {
      const value = argv[index + 1];
      if (value !== 'block' && value !== 'report') {
        throw new Error('--mode must be "block" or "report"');
      }
      options.mode = value;
      index += 1;
    } else if (argv[index] === '--sbom') {
      const value = argv[index + 1];
      if (!value) throw new Error('--sbom requires a path');
      options.sbom = path.resolve(repoRoot, value);
      index += 1;
    }
  }
  return options;
}

/**
 * Run an audit tool and return its stdout even when it exits non-zero — both
 * `npm audit` and `cargo audit` exit non-zero merely because findings exist, so
 * the exit status cannot be read as failure. A truly failed run is detected by
 * the absence of a parseable report, never by the exit code.
 *
 * On Windows npm is invoked through `cmd.exe /c` because Node's `execFile`
 * refuses to execute `npm.cmd` directly since the CVE-2024-27980 fix. The
 * command string is a fixed literal; cargo resolves directly as `cargo.exe`.
 */
function capture(command, args, cwd) {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '' };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { missing: true, message: `${command} is not installed` };
    }
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

export function requireCargoSbomCoverage(sbom, cargoMetadata) {
  const coverage = evaluateCargoSbomCoverage(sbom, cargoMetadata);
  if (!coverage.complete) throw new Error(coverage.diagnostic);
  return coverage;
}

export function requireNpmSbomCoverage(
  sbom,
  npmProductionTree,
  importedComponents,
) {
  const coverage = evaluateNpmSbomCoverage(
    sbom,
    npmProductionTree,
    importedComponents,
  );
  if (!coverage.complete) throw new Error(coverage.diagnostic);
  return coverage;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  let policyDocument;
  try {
    policyDocument = JSON.parse(
      readFileSync(
        path.join(repoRoot, 'scripts', 'supply-chain-policy.json'),
        'utf8',
      ),
    );
  } catch (error) {
    console.error(
      `[audit-advisories] FAILED: policy unreadable: ${error.message}`,
    );
    process.exit(1);
  }

  let policy;
  let mode;
  try {
    policy = validateSupplyChainPolicy(policyDocument).advisories;
    mode = options.mode ?? advisoryEnforcement(policy);
  } catch (error) {
    console.error(`[audit-advisories] FAILED: ${error.message}`);
    process.exit(1);
  }

  // Shipped closure, by ecosystem, from the SBOM. Without it the gate cannot
  // scope, so a missing SBOM fails closed rather than auditing the whole lock.
  let sbom;
  try {
    sbom = JSON.parse(readFileSync(options.sbom, 'utf8'));
  } catch {
    console.error(
      `[audit-advisories] FAILED: no SBOM at ${options.sbom}; run \`npm run sbom\` first so advisories can be scoped to what ships`,
    );
    process.exit(1);
  }
  const shipped = { npm: new Set(), cargo: new Set() };
  for (const component of sbom.components ?? []) {
    const ecosystem = component.properties?.find(
      (property) => property.name === 'printfarmer:ecosystem',
    )?.value;
    if (ecosystem === 'npm') shipped.npm.add(component.name);
    else if (ecosystem === 'cargo') shipped.cargo.add(component.name);
  }

  // The advisory scope is only meaningful if the SBOM is complete. Re-resolve
  // both shipped graphs independently and compare exact identities before
  // consulting either advisory database.
  let npmCoverage;
  try {
    npmCoverage = requireNpmSbomCoverage(
      sbom,
      readNpmProductionTree(repoRoot),
      readImportedNpmComponents(repoRoot),
    );
  } catch (error) {
    console.error(`[audit-advisories] FAILED: ${error.message}`);
    process.exit(1);
  }
  console.log(
    `[audit-advisories] OK: npm SBOM completeness check matched ${npmCoverage.expectedCount} shipped component(s)`,
  );

  let cargoMetadata;
  try {
    const features = resolveShippedFeatures(repoRoot);
    cargoMetadata = readCargoMetadata(features, repoRoot);
  } catch (error) {
    console.error(
      `[audit-advisories] FAILED: cargo SBOM completeness check could not resolve the shipped graph: ${error.message}`,
    );
    process.exit(1);
  }

  let cargoCoverage;
  try {
    cargoCoverage = requireCargoSbomCoverage(sbom, cargoMetadata);
  } catch (error) {
    console.error(`[audit-advisories] FAILED: ${error.message}`);
    process.exit(1);
  }
  console.log(
    `[audit-advisories] OK: cargo SBOM completeness check matched ${cargoCoverage.expectedCount} feature-resolved shipped component(s)`,
  );

  const advisories = [];
  const couldNotRun = [];

  // --- npm ---
  // Audit the installed graph without a manifest-section filter. Electron is a
  // devDependency but ships as the runtime; the SBOM closure below, not
  // `--omit=dev`, removes unshipped tooling findings.
  const npmCommand =
    process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const npmArgs =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm audit --json']
      : NPM_AUDIT_ARGS;
  const npm = capture(npmCommand, npmArgs, repoRoot);
  if (npm.missing) {
    couldNotRun.push(npm.message);
  } else {
    const report = tryParse(npm.stdout);
    if (!report || typeof report.vulnerabilities !== 'object') {
      couldNotRun.push(
        `npm audit did not return a parseable report${trailer(npm.stderr)}`,
      );
    } else {
      advisories.push(
        ...scopeToShippedClosure(normalizeNpmAudit(report), shipped.npm),
      );
    }
  }

  // --- cargo ---
  const cargo = capture(
    'cargo',
    ['audit', '--json', '-f', cargoLock],
    repoRoot,
  );
  if (cargo.missing) {
    couldNotRun.push(cargo.message);
  } else {
    const report = tryParse(cargo.stdout);
    if (!report || !Array.isArray(report.vulnerabilities?.list)) {
      couldNotRun.push(
        `cargo audit did not return a parseable report${trailer(cargo.stderr)}`,
      );
    } else {
      advisories.push(
        ...scopeToShippedClosure(normalizeCargoAudit(report), shipped.cargo),
      );
    }
  }

  const result = evaluateAdvisories({ advisories, couldNotRun }, policy);

  // Report every partition so the run is legible whether or not it fails.
  for (const advisory of result.belowThreshold) {
    console.log(
      `[audit-advisories]   below threshold: ${advisory.id} (${advisory.severity}) ${advisory.package} [${advisory.ecosystem}]`,
    );
  }
  for (const advisory of result.waived) {
    console.log(
      `[audit-advisories]   waived: ${advisory.id} ${advisory.package} — ${advisory.waiver.reason}`,
    );
  }
  for (const advisory of result.blocking) {
    const line = `${advisory.id} (${advisory.severity}) ${advisory.package} [${advisory.ecosystem}]${advisory.fixAvailable ? ' — fix available' : ''}`;
    console.error(`[audit-advisories]   BLOCKING: ${line}`);
    if (mode === 'report') console.log(`::warning::advisory ${line}`);
  }
  for (const reason of result.couldNotRun) {
    console.error(`[audit-advisories]   COULD NOT RUN: ${reason}`);
    console.log(`::warning::advisory audit could not run: ${reason}`);
  }

  // An inability to run is loud in BOTH modes: a check that cannot check must
  // not report success.
  if (result.couldNotRun.length > 0) {
    console.error(
      `[audit-advisories] FAILED: ${result.couldNotRun.length} audit(s) could not run; treating as a failure rather than a silent pass`,
    );
    process.exit(1);
  }

  if (result.blocking.length > 0 && mode === 'block') {
    console.error(
      `[audit-advisories] FAILED: ${result.blocking.length} advisory(ies) at or above the threshold with no waiver`,
    );
    process.exit(1);
  }

  const summary = `${result.blocking.length} at/above threshold, ${result.waived.length} waived, ${result.belowThreshold.length} below`;
  console.log(
    `[audit-advisories] OK (${mode} mode): ${summary}; scoped to ${shipped.npm.size} npm + ${shipped.cargo.size} cargo shipped package(s)`,
  );
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function trailer(stderr) {
  const trimmed = (stderr ?? '').trim();
  if (!trimmed) return '';
  const firstLine = trimmed.split('\n')[0];
  return `: ${firstLine.slice(0, 200)}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
