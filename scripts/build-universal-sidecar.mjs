import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const nativeDir = path.join(repoRoot, 'native');

export const UNIVERSAL_MAC_TARGETS = Object.freeze([
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
]);
export const UNIVERSAL_SIDECAR_PATH = path.join(
  nativeDir,
  'target',
  'universal-apple-darwin',
  'release',
  'model-core',
);

export function verifyArchArgs(sidecarPath = UNIVERSAL_SIDECAR_PATH) {
  return [sidecarPath, '-verify_arch', 'x86_64', 'arm64'];
}

function run(command, args, description) {
  const result = spawnSync(command, args, {
    cwd: nativeDir,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `${description} failed with exit code ${result.status ?? 'unknown'}`,
    );
  }
}

function main() {
  if (process.platform !== 'darwin') {
    throw new Error('universal macOS sidecars can only be built on macOS');
  }

  for (const target of UNIVERSAL_MAC_TARGETS) {
    run(
      'cargo',
      [
        'build',
        '--locked',
        '--release',
        '-p',
        'model-core',
        '--features',
        'sqlite',
        '--target',
        target,
      ],
      `building the ${target} sidecar`,
    );
  }

  mkdirSync(path.dirname(UNIVERSAL_SIDECAR_PATH), { recursive: true });
  run(
    'lipo',
    [
      '-create',
      ...UNIVERSAL_MAC_TARGETS.map((target) =>
        path.join(nativeDir, 'target', target, 'release', 'model-core'),
      ),
      '-output',
      UNIVERSAL_SIDECAR_PATH,
    ],
    'combining the universal sidecar',
  );
  run(
    'lipo',
    verifyArchArgs(),
    'verifying universal sidecar architectures',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
