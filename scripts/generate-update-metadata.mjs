import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const UPDATE_METADATA_SCHEMA_VERSION = 1;

function decodeKey(environment, name) {
  const encoded = environment[name]?.trim();
  if (!encoded) {
    throw new Error(`${name} is required to sign update metadata`);
  }
  const pem = Buffer.from(encoded, 'base64').toString('utf8');
  if (!pem.includes('BEGIN')) {
    throw new Error(`${name} must be a base64-encoded PEM key`);
  }
  return pem;
}

function listFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

function findSingleArtifact(files, description, predicate) {
  const matches = files.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${description}, found ${matches.length}: ${matches.map((file) => path.basename(file)).join(', ') || '(none)'}`,
    );
  }
  return matches[0];
}

function artifactRecord(filePath, repository, tag) {
  const bytes = readFileSync(filePath);
  const fileName = path.basename(filePath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName)) {
    throw new Error(
      `release artifact name is not upload-safe: ${fileName}; normalize it before signing metadata`,
    );
  }
  return {
    fileName,
    url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

function assertMatchingKeys(privateKey, expectedPublicKey) {
  const derived = createPublicKey(privateKey).export({
    type: 'spki',
    format: 'der',
  });
  const expected = createPublicKey(expectedPublicKey).export({
    type: 'spki',
    format: 'der',
  });
  if (!derived.equals(expected)) {
    throw new Error(
      'UPDATE_SIGNING_PRIVATE_KEY_BASE64 does not match PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64',
    );
  }
}

export function verifyUpdateKeyPair(environment) {
  const privateKey = createPrivateKey(
    decodeKey(environment, 'UPDATE_SIGNING_PRIVATE_KEY_BASE64'),
  );
  assertMatchingKeys(
    privateKey,
    decodeKey(environment, 'PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64'),
  );
}

export function createSignedUpdateMetadata({
  artifactsDirectory,
  version,
  tag,
  repository,
  publishedAt,
  environment = process.env,
}) {
  const files = listFiles(artifactsDirectory);
  const windowsInstaller = findSingleArtifact(
    files,
    'Windows Setup.exe artifact',
    (file) => /Setup\.exe$/i.test(file),
  );
  const macUniversalZip = findSingleArtifact(
    files,
    'universal macOS ZIP artifact',
    (file) =>
      file.toLowerCase().endsWith('.zip') &&
      file.toLowerCase().includes('darwin') &&
      file.toLowerCase().includes('universal'),
  );

  const metadata = {
    schemaVersion: UPDATE_METADATA_SCHEMA_VERSION,
    version,
    publishedAt,
    artifacts: {
      'win32-x64': artifactRecord(windowsInstaller, repository, tag),
      'darwin-universal': artifactRecord(macUniversalZip, repository, tag),
    },
  };
  const payload = `${JSON.stringify(metadata, null, 2)}\n`;
  const privateKey = createPrivateKey(
    decodeKey(environment, 'UPDATE_SIGNING_PRIVATE_KEY_BASE64'),
  );
  const publicKey = decodeKey(
    environment,
    'PRINTFARMER_UPDATE_PUBLIC_KEY_BASE64',
  );
  assertMatchingKeys(privateKey, publicKey);
  const signature = sign(null, Buffer.from(payload), privateKey).toString(
    'base64',
  );

  return { payload, signature: `${signature}\n` };
}

function main() {
  const { values } = parseArgs({
    options: {
      artifacts: { type: 'string' },
      version: { type: 'string' },
      tag: { type: 'string' },
      repository: { type: 'string', default: 'OlyForge3D/PrintFarmerDesktop' },
      'published-at': { type: 'string' },
      output: { type: 'string', default: 'dist' },
    },
  });
  for (const required of ['artifacts', 'version', 'tag', 'published-at']) {
    if (!values[required]) {
      throw new Error(`--${required} is required`);
    }
  }

  const { payload, signature } = createSignedUpdateMetadata({
    artifactsDirectory: path.resolve(values.artifacts),
    version: values.version,
    tag: values.tag,
    repository: values.repository,
    publishedAt: values['published-at'],
  });
  const outputDirectory = path.resolve(values.output);
  writeFileSync(path.join(outputDirectory, 'latest.json'), payload, {
    encoding: 'utf8',
    flag: 'wx',
  });
  writeFileSync(path.join(outputDirectory, 'latest.json.sig'), signature, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
