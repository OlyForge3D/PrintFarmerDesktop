import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPROVED_UPSTREAM_PATHS,
  downloadApprovedSnapshot,
  verifyBundleDirectory,
  writeSnapshotBundle,
} from './target-profile-tools.mjs';

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) {
    throw new Error(`required option ${name} is missing`);
  }
  if (process.argv[index + 1].startsWith('--')) {
    throw new Error(`required option ${name} has no value`);
  }
  return process.argv[index + 1];
}

const allowedArguments = new Set(['--ref', '--retrieved-at']);
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--') && !allowedArguments.has(argument)) {
    throw new Error(`unknown option ${argument}`);
  }
}

const ref = readOption('--ref');
const retrievedAt = readOption('--retrieved-at');
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const bundleDirectory = path.join(
  repoRoot,
  'resources',
  'target-profiles',
  'snapmaker-u1',
);

const downloaded = await downloadApprovedSnapshot({
  ref,
  retrievedAt,
  approvedPaths: APPROVED_UPSTREAM_PATHS,
});
await writeSnapshotBundle(bundleDirectory, {
  ref,
  retrievedAt,
  ...downloaded,
});
const manifest = await verifyBundleDirectory(bundleDirectory);
console.log(
  `[update-snapmaker-presets] wrote ${manifest.files.length} verified files from ${ref}`,
);
