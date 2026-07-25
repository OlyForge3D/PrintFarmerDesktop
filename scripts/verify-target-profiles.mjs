import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundleDirectory } from './target-profile-tools.mjs';

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
const manifest = await verifyBundleDirectory(bundleDirectory);
console.log(
  `[verify-target-profiles] OK: ${manifest.bundleId} contains ${manifest.files.length} files pinned to ${manifest.upstream.commit}`,
);
