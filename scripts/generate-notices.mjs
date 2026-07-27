// Generate the enumerated third-party dependency-licence notice from the SBOM.
//
// Usage: node scripts/generate-notices.mjs [--sbom <path>] [--out <path>]
//
// This is a derived artifact, not a hand-authored one: it enumerates every
// component the SBOM records, so it stays exactly in step with what ships. The
// hand-authored provenance in THIRD_PARTY_NOTICES.md (bundled slicer, printer
// calibration data) is left untouched — that file points at this one for the
// dependency list.
//
// The render is deterministic for the same reasons the SBOM is (see
// `renderThirdPartyNotices`): code-unit ordering, no timestamp, a pure function
// of the component set. CI regenerates and compares rather than trusting a
// committed snapshot that ages silently.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderThirdPartyNotices } from './supply-chain-policy.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const DEFAULT_SBOM = path.join(repoRoot, 'build', 'sbom.cdx.json');
export const DEFAULT_OUTPUT = path.join(
  repoRoot,
  'build',
  'third-party-licenses.md',
);

function parseArgs(argv) {
  const options = { sbom: DEFAULT_SBOM, out: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out requires a path');
      options.out = path.resolve(repoRoot, value);
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  let sbom;
  try {
    sbom = JSON.parse(readFileSync(options.sbom, 'utf8'));
  } catch (error) {
    throw new Error(
      `generate-notices: could not read the SBOM at ${options.sbom} (run \`npm run sbom\` first): ${error.message}`,
    );
  }

  const notices = renderThirdPartyNotices(sbom);
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, notices, 'utf8');
  console.log(
    `[generate-notices] OK: ${sbom.components.length} components -> ${options.out}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
