#!/usr/bin/env node

import Ajv from 'ajv';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const approvedPin = Object.freeze({
  id: 'calibration-source-v1.3.2',
  canonicalRepository:
    'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard',
  tag: 'v1.3.2',
  tagUrl:
    'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/tree/v1.3.2',
  releaseUrl:
    'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/releases/tag/v1.3.2',
  commit: '057d6117b9ab31747ede3a5684a009cb6079ad11',
  commitUrl:
    'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/commit/057d6117b9ab31747ede3a5684a009cb6079ad11',
  tree: '4197589b91376c485e57a28ca6281d54a2358f7b',
  archiveUrl:
    'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/archive/057d6117b9ab31747ede3a5684a009cb6079ad11.tar.gz',
  archiveSha256:
    'a7f985d44d4188d600ead0b916eec98a14bfba9f53079aea659cbaaa8adc5047',
  archiveBytes: 1581075,
  licenseSpdx: 'AGPL-3.0-only',
  licensePath: 'License',
  licenseBlob: 'be3f7b28e564e7dd05eaf59d64adba1a4065ac0e',
  licenseUrl:
    'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/blob/057d6117b9ab31747ede3a5684a009cb6079ad11/License',
  packagePath: 'package.json',
  packageBlob: '61c87aad217483c34b8ca4d40560d02edd4cfff6',
  packageUrl:
    'https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/blob/057d6117b9ab31747ede3a5684a009cb6079ad11/package.json',
  packageVersion: '1.3.2',
  packageLicense: 'AGPL-3.0-only',
  eligibilityStatus: 'first-eligible-source',
  eligibilityAuthority:
    'https://github.com/OlyForge3D/PrintFarmerDesktop/issues/51',
  eligibilityRecordedAt: '2026-07-24',
});

const reviewedSourceFiles = Object.freeze({
  'Printer_Database/Printer_Database.xlsx': {
    blob: 'b57e704b1712449f2414f9d2135262bfa70da01a',
    decision: 'exclude',
  },
  'app-icon.png': {
    blob: 'e20d80a63c6e5bdbb261829ae093658898458001',
    decision: 'exclude',
  },
  'public/models/manifest.json': {
    blob: '0ed7f8a95766ef6142474d47bbd65d2545d65f4b',
    decision: 'exclude',
  },
  'scripts/generate-printer-database.mjs': {
    blob: '3b5b1f25e739c5d095803430262ad20fff10ddee',
    decision: 'exclude',
  },
  'src/data/calibrations.ts': {
    blob: 'e7b6452c163de67d734b70b6218f5caec34a6121',
    decision: 'exclude',
  },
  'src/data/glossary.ts': {
    blob: '968e68645db7dfe0e1fc735f7ce1dac9d986734b',
    decision: 'rewrite-only',
  },
  'src/data/materials.ts': {
    blob: '7c87078d3b46c27ef7de5eecb2ff2ef46030d793',
    decision: 'exclude',
  },
  'src/data/models.ts': {
    blob: 'bccd30728ef023a9f73d9646d6b15cd5af11c2f1',
    decision: 'exclude',
  },
  'src/data/printerDatabase.ts': {
    blob: '922a3688e6c09f0e53a62e5290a346a2dfd3e26f',
    decision: 'exclude',
  },
  'src/data/printers.json': {
    blob: 'dc915ff760c3558e22ccda71af37fbe8dd4e0c37',
    decision: 'exclude',
  },
  'src/data/slicers.ts': {
    blob: 'e488cb809ff1b9228ec621c5ac06ddb205a5862e',
    decision: 'exclude',
  },
  'src/export/backup.ts': {
    blob: '4b71dd289c30f01fe5fd93fbbd59f2eb2bbf15db',
    decision: 'eligible-for-review',
  },
  'src/logic/formulas.ts': {
    blob: '5d1ac9edd84bde6bb5993204efcf1f33b001eecb',
    decision: 'eligible-for-review',
  },
  'src/logic/ranges.ts': {
    blob: '98b79bc9ea416fc926fa2f7bfdae6f836cb054d7',
    decision: 'eligible-for-review',
  },
  'src/logic/validation.ts': {
    blob: '8b80a9650779d588a6c9f69243d34e50497cd6a9',
    decision: 'eligible-for-review',
  },
  'src/slicerIntegration/adapters/bambu.ts': {
    blob: 'd2dbf4d226db75a65867980bb11d2f9e0ee926e5',
    decision: 'exclude',
  },
  'src/slicerIntegration/adapters/elegooSlicer.ts': {
    blob: '64b195dee85318fd70db985acfc237a02267c852',
    decision: 'exclude',
  },
  'src/slicerIntegration/adapters/flashStudio.ts': {
    blob: '3b3af680fd6f1f4072d01497f71d174cb99d5fb8',
    decision: 'exclude',
  },
  'src/slicerIntegration/adapters/orca.ts': {
    blob: 'abbbf5e0190c54c3416b8606a887726eedeadcdc',
    decision: 'eligible-for-review',
  },
  'src/slicerIntegration/adapters/snapmakerOrca.ts': {
    blob: '28d5ccfcdca3596a1685fc4eece6c9f57ffa70a7',
    decision: 'exclude',
  },
  'src/slicerIntegration/generator.ts': {
    blob: 'a1e046cbe6681cc8e5518042b5823b548858367a',
    decision: 'eligible-for-review',
  },
  'src/slicerIntegration/orcaFamily.ts': {
    blob: '50760deec7757c789f2d040d92e349e3396ca1d1',
    decision: 'eligible-for-review',
  },
  'src/slicerIntegration/validation.ts': {
    blob: '6aa236a702074315b6fd1d043fa2ba9496c0a630',
    decision: 'eligible-for-review',
  },
  'tests/formulas.test.ts': {
    blob: '913e0a8d89668344e63ec9fa97d3ac5d6532eb0f',
    decision: 'eligible-for-review',
  },
  'tests/importExport.test.ts': {
    blob: '366edd734a8d2b40e5b08d4184088bdb482e1075',
    decision: 'eligible-for-review',
  },
  'tests/slicerIntegration/generator.test.ts': {
    blob: 'a499dd306da11075d06ac0f0c42f3eb34087bd71',
    decision: 'eligible-for-review',
  },
  'tests/slicerIntegration/validation.test.ts': {
    blob: '6d46a8732bee20141e7cd94ef92e878ab9fa6b02',
    decision: 'eligible-for-review',
  },
});

const approvedDerivedRoots = Object.freeze([
  'native/model-core/src/calibration/derived',
  'native/model-core/tests/calibration/derived',
  'src/calibration/derived',
  'tests/calibration/derived',
]);

const marker = `${['PFD', 'SOURCE', 'DERIVED'].join('-')}: printer-calibration`;
const markerExtensions = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.js',
  '.jsx',
  '.mjs',
  '.rs',
  '.ts',
  '.tsx',
]);
const fallbackIgnoredRoots = [
  '.git',
  '.vite',
  'coverage',
  'dist',
  'node_modules',
  'native/target',
  'out',
];
const approvedLicenseReview = Object.freeze({
  approvedBy: '@jpapiez',
  approvedAt: '2026-07-24',
  decisionReference:
    'https://github.com/OlyForge3D/PrintFarmerDesktop/issues/51#issuecomment-5075723583',
});

function parseArguments(argv) {
  let root = process.cwd();
  let manifest;
  let schema;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!['--root', '--manifest', '--schema'].includes(argument) || !value) {
      throw new Error(
        `Usage: check-calibration-provenance.mjs [--root <path>] [--manifest <path>] [--schema <path>]`,
      );
    }
    if (argument === '--root') root = value;
    if (argument === '--manifest') manifest = value;
    if (argument === '--schema') schema = value;
    index += 1;
  }

  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    manifestPath: path.resolve(
      manifest ??
        path.join(
          resolvedRoot,
          'compliance',
          'printer-calibration-provenance.json',
        ),
    ),
    schemaPath: path.resolve(
      schema ??
        path.join(
          resolvedRoot,
          'compliance',
          'printer-calibration-provenance.schema.json',
        ),
    ),
  };
}

function readJson(filePath, label) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot parse ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function toRepositoryPath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isPathInside(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function validateRepositoryPath(value, label, errors) {
  const normalized = toRepositoryPath(value);
  if (
    normalized !== value ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').includes('..')
  ) {
    errors.push(`${label} must be a normalized repository-relative path`);
    return false;
  }
  return true;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function listFiles(directory, errors) {
  if (!existsSync(directory)) return [];
  const rootInfo = lstatSync(directory);
  if (rootInfo.isSymbolicLink()) {
    errors.push(`Derived root may not be a symbolic link: ${directory}`);
    return [];
  }
  if (!rootInfo.isDirectory()) {
    errors.push(`Derived root is not a directory: ${directory}`);
    return [];
  }

  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(
          `Symbolic links are not allowed in derived roots: ${entryPath}`,
        );
      } else if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  };
  visit(directory);
  return files;
}

function listProvenanceScanFiles(root) {
  const gitFiles = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (gitFiles.status === 0) {
    return gitFiles.stdout.split('\0').filter(Boolean).map(toRepositoryPath);
  }

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const repositoryPath = toRepositoryPath(path.relative(root, entryPath));
      if (
        entry.isDirectory() &&
        fallbackIgnoredRoots.some((ignoredRoot) =>
          isPathInside(repositoryPath, ignoredRoot),
        )
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(repositoryPath);
      }
    }
  };
  visit(root);
  return files;
}

function collectMarkedFiles(root, errors) {
  const marked = [];
  for (const repositoryPath of listProvenanceScanFiles(root)) {
    if (!markerExtensions.has(path.extname(repositoryPath).toLowerCase())) {
      continue;
    }
    const filePath = path.join(root, ...repositoryPath.split('/'));
    if (!existsSync(filePath)) continue;
    const fileInfo = lstatSync(filePath);
    if (fileInfo.isSymbolicLink()) {
      errors.push(`Cannot provenance-scan source symlink: ${repositoryPath}`);
      continue;
    }
    if (!fileInfo.isFile()) continue;

    let contents;
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch (error) {
      errors.push(
        `Cannot inspect ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (contents.includes(marker)) {
      marked.push(repositoryPath);
    }
  }
  return marked;
}

function readLeadingCommentNotices(contents) {
  const notices = new Set();
  let started = false;
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    const comment = line.match(/^\s*\/\/\s?(.*)$/);
    if (!comment) break;
    started = true;
    notices.add(comment[1].trim());
  }
  return started ? notices : new Set();
}

function comparePin(manifest, errors) {
  const checks = [
    ['approvedSource.id', manifest.approvedSource.id, approvedPin.id],
    [
      'approvedSource.canonicalRepository',
      manifest.approvedSource.canonicalRepository,
      approvedPin.canonicalRepository,
    ],
    ['approvedSource.tag', manifest.approvedSource.tag, approvedPin.tag],
    [
      'approvedSource.tagUrl',
      manifest.approvedSource.tagUrl,
      approvedPin.tagUrl,
    ],
    [
      'approvedSource.releaseUrl',
      manifest.approvedSource.releaseUrl,
      approvedPin.releaseUrl,
    ],
    [
      'approvedSource.commit',
      manifest.approvedSource.commit,
      approvedPin.commit,
    ],
    [
      'approvedSource.commitUrl',
      manifest.approvedSource.commitUrl,
      approvedPin.commitUrl,
    ],
    ['approvedSource.tree', manifest.approvedSource.tree, approvedPin.tree],
    [
      'approvedSource.archive.url',
      manifest.approvedSource.archive.url,
      approvedPin.archiveUrl,
    ],
    [
      'approvedSource.archive.sha256',
      manifest.approvedSource.archive.sha256,
      approvedPin.archiveSha256,
    ],
    [
      'approvedSource.archive.bytes',
      manifest.approvedSource.archive.bytes,
      approvedPin.archiveBytes,
    ],
    [
      'approvedSource.license.spdx',
      manifest.approvedSource.license.spdx,
      approvedPin.licenseSpdx,
    ],
    [
      'approvedSource.license.path',
      manifest.approvedSource.license.path,
      approvedPin.licensePath,
    ],
    [
      'approvedSource.license.blob',
      manifest.approvedSource.license.blob,
      approvedPin.licenseBlob,
    ],
    [
      'approvedSource.license.url',
      manifest.approvedSource.license.url,
      approvedPin.licenseUrl,
    ],
    [
      'approvedSource.packageMetadata.path',
      manifest.approvedSource.packageMetadata.path,
      approvedPin.packagePath,
    ],
    [
      'approvedSource.packageMetadata.blob',
      manifest.approvedSource.packageMetadata.blob,
      approvedPin.packageBlob,
    ],
    [
      'approvedSource.packageMetadata.url',
      manifest.approvedSource.packageMetadata.url,
      approvedPin.packageUrl,
    ],
    [
      'approvedSource.packageMetadata.declaredVersion',
      manifest.approvedSource.packageMetadata.declaredVersion,
      approvedPin.packageVersion,
    ],
    [
      'approvedSource.packageMetadata.declaredLicense',
      manifest.approvedSource.packageMetadata.declaredLicense,
      approvedPin.packageLicense,
    ],
    [
      'approvedSource.eligibilityDecision.status',
      manifest.approvedSource.eligibilityDecision.status,
      approvedPin.eligibilityStatus,
    ],
    [
      'approvedSource.eligibilityDecision.authority',
      manifest.approvedSource.eligibilityDecision.authority,
      approvedPin.eligibilityAuthority,
    ],
    [
      'approvedSource.eligibilityDecision.recordedAt',
      manifest.approvedSource.eligibilityDecision.recordedAt,
      approvedPin.eligibilityRecordedAt,
    ],
  ];

  for (const [label, actual, expected] of checks) {
    if (actual !== expected) {
      errors.push(
        `${label} is not an approved source value (expected ${String(expected)}, received ${String(actual)})`,
      );
    }
  }
}

function validateLicenseReview(manifest, errors) {
  const review = manifest.repository.licenseReview;
  if (review.issue !== approvedPin.eligibilityAuthority) {
    errors.push(
      `repository.licenseReview.issue must be ${approvedPin.eligibilityAuthority}`,
    );
  }
  if (review.status === 'approved') {
    if (!review.approvedBy || !review.approvedAt || !review.decisionReference) {
      errors.push(
        'Approved repository licensing requires approvedBy, approvedAt, and decisionReference',
      );
    }
    if (review.approvedBy !== approvedLicenseReview.approvedBy) {
      errors.push(
        `Repository licensing approval must name ${approvedLicenseReview.approvedBy}`,
      );
    }
    if (review.approvedAt !== approvedLicenseReview.approvedAt) {
      errors.push(
        `Repository licensing approval date must be ${approvedLicenseReview.approvedAt}`,
      );
    }
    if (review.decisionReference !== approvedLicenseReview.decisionReference) {
      errors.push(
        `Repository licensing approval must reference ${approvedLicenseReview.decisionReference}`,
      );
    }
  } else if (
    review.approvedBy !== null ||
    review.approvedAt !== null ||
    review.decisionReference !== null
  ) {
    errors.push(
      'A non-approved repository licensing review may not carry approval metadata',
    );
  }

  if (review.status !== 'approved' && manifest.derivedFiles.length > 0) {
    errors.push(
      `Source-derived files are forbidden while repository licensing is ${review.status}`,
    );
  }
}

function validateDerivedFiles(manifest, root, errors) {
  const roots = [...manifest.derivedRoots].sort();
  if (
    roots.length !== approvedDerivedRoots.length ||
    roots.some((entry, index) => entry !== approvedDerivedRoots[index])
  ) {
    errors.push(
      `derivedRoots must exactly match the approved roots: ${approvedDerivedRoots.join(', ')}`,
    );
  }

  const sourceDecisions = new Map();
  for (const decision of manifest.sourceDecisions) {
    validateRepositoryPath(
      decision.sourcePath,
      `sourceDecisions.${decision.sourcePath}.sourcePath`,
      errors,
    );
    const key = `${decision.sourcePath}\0${decision.sourceBlob}`;
    if (sourceDecisions.has(key)) {
      errors.push(
        `Duplicate source decision for ${decision.sourcePath} at ${decision.sourceBlob}`,
      );
    }
    sourceDecisions.set(key, decision);

    const reviewed = reviewedSourceFiles[decision.sourcePath];
    if (!reviewed) {
      errors.push(
        `Source decision is not in the reviewed file allowlist: ${decision.sourcePath}`,
      );
    } else {
      if (decision.sourceBlob !== reviewed.blob) {
        errors.push(
          `${decision.sourcePath} must use reviewed blob ${reviewed.blob}`,
        );
      }
      if (decision.decision !== reviewed.decision) {
        errors.push(
          `${decision.sourcePath} must retain decision ${reviewed.decision}`,
        );
      }
    }
  }

  for (const reviewedPath of Object.keys(reviewedSourceFiles)) {
    if (
      !manifest.sourceDecisions.some(
        (decision) => decision.sourcePath === reviewedPath,
      )
    ) {
      errors.push(`Missing reviewed source decision: ${reviewedPath}`);
    }
  }

  const destinations = new Map();
  const ids = new Set();
  for (const entry of manifest.derivedFiles) {
    if (ids.has(entry.id)) {
      errors.push(`Duplicate derived file ID: ${entry.id}`);
    }
    ids.add(entry.id);
    if (
      !validateRepositoryPath(
        entry.destinationPath,
        `derivedFiles.${entry.id}.destinationPath`,
        errors,
      )
    ) {
      continue;
    }
    if (
      !manifest.derivedRoots.some((derivedRoot) =>
        isPathInside(entry.destinationPath, derivedRoot),
      )
    ) {
      errors.push(
        `${entry.destinationPath} is outside the controlled derived roots`,
      );
    }
    if (destinations.has(entry.destinationPath)) {
      errors.push(`Duplicate derived destination: ${entry.destinationPath}`);
    }
    destinations.set(entry.destinationPath, entry);

    const decision = sourceDecisions.get(
      `${entry.sourcePath}\0${entry.sourceBlob}`,
    );
    if (!decision || decision.decision !== 'eligible-for-review') {
      errors.push(
        `${entry.sourcePath} at ${entry.sourceBlob} is not eligible for adaptation`,
      );
    }

    const destination = path.join(root, ...entry.destinationPath.split('/'));
    if (!existsSync(destination)) {
      errors.push(
        `Derived destination does not exist: ${entry.destinationPath}`,
      );
      continue;
    }
    const destinationInfo = lstatSync(destination);
    if (destinationInfo.isSymbolicLink()) {
      errors.push(
        `Derived destination may not be a symbolic link: ${entry.destinationPath}`,
      );
      continue;
    }
    if (!destinationInfo.isFile()) {
      errors.push(
        `Derived destination is not a file: ${entry.destinationPath}`,
      );
      continue;
    }

    const actualHash = sha256(destination);
    if (actualHash !== entry.destinationSha256) {
      errors.push(
        `${entry.destinationPath} SHA-256 mismatch (expected ${entry.destinationSha256}, received ${actualHash})`,
      );
    }

    const contents = readFileSync(destination, 'utf8');
    const leadingNotices = readLeadingCommentNotices(contents);
    const requiredNotices = [
      marker,
      `Source-Commit: ${approvedPin.commit}`,
      `Source-Path: ${entry.sourcePath}`,
      `Source-Blob: ${entry.sourceBlob}`,
      'SPDX-License-Identifier: AGPL-3.0-only',
      `PFD-Modified-At: ${entry.modifiedAt}`,
      `PFD-Modifications: ${entry.modifications}`,
    ];
    for (const originalNotice of entry.originalNotices) {
      requiredNotices.push(`PFD-Original-Notice: ${originalNotice}`);
    }
    for (const notice of requiredNotices) {
      if (!leadingNotices.has(notice)) {
        errors.push(
          `${entry.destinationPath} is missing leading notice: ${notice}`,
        );
      }
    }
  }

  for (const derivedRoot of manifest.derivedRoots) {
    const absoluteRoot = path.join(root, ...derivedRoot.split('/'));
    for (const file of listFiles(absoluteRoot, errors)) {
      const repositoryPath = toRepositoryPath(path.relative(root, file));
      if (!destinations.has(repositoryPath)) {
        errors.push(
          `File in controlled derived root lacks a manifest record: ${repositoryPath}`,
        );
      }
    }
  }

  for (const markedPath of collectMarkedFiles(root, errors)) {
    if (!destinations.has(markedPath)) {
      errors.push(
        `Source-derived marker lacks a manifest record: ${markedPath}`,
      );
    }
  }
}

function validateManifest({ root, manifestPath, schemaPath }) {
  const manifest = readJson(manifestPath, 'provenance manifest');
  const schema = readJson(schemaPath, 'provenance schema');
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(manifest)) {
    return (validate.errors ?? []).map(
      (error) =>
        `schema ${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    );
  }

  const errors = [];
  comparePin(manifest, errors);
  validateLicenseReview(manifest, errors);
  validateDerivedFiles(manifest, root, errors);
  return errors;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const errors = validateManifest(options);
  if (errors.length > 0) {
    console.error('Calibration provenance check failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  const manifest = readJson(options.manifestPath, 'provenance manifest');
  console.log(
    `Calibration provenance check passed: ${manifest.derivedFiles.length} derived file(s), source ${approvedPin.tag} (${approvedPin.commit}).`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `Calibration provenance check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

export { approvedPin, validateManifest };
