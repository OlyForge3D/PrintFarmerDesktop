import { createPublicKey, verify } from 'node:crypto';
import path from 'node:path';

export interface UpdateArtifact {
  fileName: string;
  url: string;
  sha256: string;
  size: number;
}

export interface UpdateMetadata {
  schemaVersion: 1;
  version: string;
  publishedAt: string;
  artifacts: {
    'win32-x64': UpdateArtifact;
    'darwin-universal': UpdateArtifact;
  };
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: Array<number | string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVersion(version: string): ParsedVersion {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match || match[1] === undefined || match[2] === undefined || !match[3]) {
    throw new Error(`invalid update version: ${version}`);
  }
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (core.some((identifier) => !Number.isSafeInteger(identifier))) {
    throw new Error(
      `update version contains an unsafe numeric identifier: ${version}`,
    );
  }
  const prerelease = match[4]
    ? match[4].split('.').map((identifier) => {
        if (/^(0|[1-9]\d*)$/.test(identifier)) {
          const numericIdentifier = Number(identifier);
          if (!Number.isSafeInteger(numericIdentifier)) {
            throw new Error(
              `update version contains an unsafe numeric identifier: ${version}`,
            );
          }
          return numericIdentifier;
        }
        return identifier;
      })
    : [];
  return {
    core: [...core],
    prerelease,
  };
}

export function compareVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const difference = parsedLeft.core[index]! - parsedRight.core[index]!;
    if (difference !== 0) return Math.sign(difference);
  }

  if (parsedLeft.prerelease.length === 0) {
    return parsedRight.prerelease.length === 0 ? 0 : 1;
  }
  if (parsedRight.prerelease.length === 0) return -1;

  const identifiers = Math.max(
    parsedLeft.prerelease.length,
    parsedRight.prerelease.length,
  );
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    if (typeof leftIdentifier === 'number') {
      if (typeof rightIdentifier === 'string') return -1;
      return Math.sign(leftIdentifier - rightIdentifier);
    }
    if (typeof rightIdentifier === 'number') return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function parseArtifact(value: unknown, label: string): UpdateArtifact {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const { fileName, url, sha256, size } = value;
  if (
    typeof fileName !== 'string' ||
    fileName.length === 0 ||
    path.posix.basename(fileName) !== fileName ||
    path.win32.basename(fileName) !== fileName
  ) {
    throw new Error(`${label}.fileName must be a plain file name`);
  }
  if (typeof url !== 'string') throw new Error(`${label}.url must be a string`);
  const parsedUrl = new URL(url);
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'github.com' ||
    !parsedUrl.pathname.startsWith(
      '/OlyForge3D/PrintFarmerDesktop/releases/download/',
    ) ||
    decodeURIComponent(parsedUrl.pathname.split('/').at(-1) ?? '') !== fileName
  ) {
    throw new Error(`${label}.url is not a trusted release asset URL`);
  }
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`${label}.size must be a positive safe integer`);
  }
  return { fileName, url, sha256, size };
}

function parseMetadata(value: unknown): UpdateMetadata {
  if (!isRecord(value)) throw new Error('update metadata must be an object');
  if (value.schemaVersion !== 1) {
    throw new Error(
      `unsupported update metadata schema: ${String(value.schemaVersion)}`,
    );
  }
  if (typeof value.version !== 'string') {
    throw new Error('update metadata version must be a string');
  }
  parseVersion(value.version);
  if (
    typeof value.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.publishedAt))
  ) {
    throw new Error('update metadata publishedAt must be an ISO timestamp');
  }
  if (!isRecord(value.artifacts)) {
    throw new Error('update metadata artifacts must be an object');
  }

  return {
    schemaVersion: 1,
    version: value.version,
    publishedAt: value.publishedAt,
    artifacts: {
      'win32-x64': parseArtifact(
        value.artifacts['win32-x64'],
        'artifacts.win32-x64',
      ),
      'darwin-universal': parseArtifact(
        value.artifacts['darwin-universal'],
        'artifacts.darwin-universal',
      ),
    },
  };
}

export function verifySignedUpdateMetadata(
  payload: string,
  signatureText: string,
  publicKeyPem: string,
): UpdateMetadata {
  const signature = signatureText.trim();
  if (signature.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error('update metadata signature is not valid base64');
  }
  const signatureBytes = Buffer.from(signature, 'base64');
  if (
    signatureBytes.toString('base64').replace(/=+$/, '') !==
    signature.replace(/=+$/, '')
  ) {
    throw new Error('update metadata signature is not canonical base64');
  }
  if (
    !verify(
      null,
      Buffer.from(payload),
      createPublicKey(publicKeyPem),
      signatureBytes,
    )
  ) {
    throw new Error('update metadata signature verification failed');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch (error) {
    throw new Error('signed update metadata is not valid JSON', {
      cause: error,
    });
  }
  return parseMetadata(decoded);
}

export function selectUpdateArtifact(
  metadata: UpdateMetadata,
  platform: NodeJS.Platform,
  arch: string,
): UpdateArtifact {
  if (platform === 'win32' && arch === 'x64') {
    return metadata.artifacts['win32-x64'];
  }
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    return metadata.artifacts['darwin-universal'];
  }
  throw new Error(`updates are not published for ${platform}-${arch}`);
}

export function assertUpdateIsNotRollback(
  candidateVersion: string,
  currentVersion: string,
): void {
  if (compareVersions(candidateVersion, currentVersion) < 0) {
    throw new Error(
      `refusing update rollback from ${currentVersion} to ${candidateVersion}`,
    );
  }
}
