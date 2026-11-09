import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface VisualCandidateArchiveEntry {
  platform: 'windows' | 'macos';
  scenarioId: string;
  surfaceId: string;
  stateId: string;
  dimensionsExercised: string[];
  image: Uint8Array;
  metadata: Record<string, unknown>;
}

interface ArchivedCandidateIndex {
  schemaVersion: 1;
  candidates: Array<{
    platform: 'windows' | 'macos';
    scenarioId: string;
    surfaceId: string;
    stateId: string;
    candidateSha256: string;
    environmentSha256: string;
    imagePath: string;
    metadataPath: string;
    dimensionsExercised: string[];
    trigger: string;
    expectedState: string;
    screenshotPolicy: 'temporary-review-evidence';
  }>;
}

type ReadableArchiveIndex = {
  schemaVersion: 1;
  candidates: Array<
    Omit<ArchivedCandidateIndex['candidates'][number], 'screenshotPolicy'>
  >;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArchivedCandidateIndex(
  value: unknown,
): value is ReadableArchiveIndex {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.candidates)
  ) {
    return false;
  }
  return value.candidates.every((candidate: unknown) => {
    if (!isRecord(candidate)) return false;
    return (
      (candidate.platform === 'windows' || candidate.platform === 'macos') &&
      typeof candidate.scenarioId === 'string' &&
      typeof candidate.surfaceId === 'string' &&
      typeof candidate.stateId === 'string' &&
      typeof candidate.candidateSha256 === 'string' &&
      typeof candidate.environmentSha256 === 'string' &&
      typeof candidate.imagePath === 'string' &&
      typeof candidate.metadataPath === 'string' &&
      Array.isArray(candidate.dimensionsExercised) &&
      candidate.dimensionsExercised.every(
        (dimension: unknown) => typeof dimension === 'string',
      ) &&
      typeof candidate.trigger === 'string' &&
      typeof candidate.expectedState === 'string'
    );
  });
}

function atomicWrite(filePath: string, contents: string | Uint8Array): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, filePath);
}

export function archiveVisualCandidate(
  reviewRoot: string,
  entry: VisualCandidateArchiveEntry,
): { imagePath: string; metadataPath: string; indexPath: string } {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(entry.scenarioId)) {
    throw new Error(
      `Invalid visual candidate scenario ID: ${entry.scenarioId}`,
    );
  }
  if (
    !['windows', 'macos'].includes(entry.platform) ||
    !entry.surfaceId ||
    !entry.stateId ||
    entry.dimensionsExercised.length === 0
  ) {
    throw new Error(
      `Incomplete visual candidate archive mapping: ${entry.scenarioId}`,
    );
  }

  const candidateSha256 = createHash('sha256')
    .update(entry.image)
    .digest('hex');
  const environmentSha256 =
    typeof entry.metadata.environmentSha256 === 'string'
      ? entry.metadata.environmentSha256
      : 'unknown-environment';
  const archiveDigest = `${candidateSha256}-${environmentSha256}`;
  const scenarioDirectory = path.join(
    reviewRoot,
    entry.platform,
    entry.scenarioId,
  );
  mkdirSync(scenarioDirectory, { recursive: true });
  const imagePath = path.join(scenarioDirectory, `${archiveDigest}.png`);
  const metadataPath = path.join(scenarioDirectory, `${archiveDigest}.json`);
  const relative = (filePath: string): string =>
    path.relative(reviewRoot, filePath).replaceAll(path.sep, '/');

  if (!existsSync(imagePath)) atomicWrite(imagePath, entry.image);
  const metadata = {
    ...entry.metadata,
    platform: entry.platform,
    scenarioId: entry.scenarioId,
    surfaceId: entry.surfaceId,
    stateId: entry.stateId,
    dimensionsExercised: entry.dimensionsExercised,
    candidateSha256,
    archivedImagePath: relative(imagePath),
    archivedMetadataPath: relative(metadataPath),
    screenshotPolicy: 'temporary-review-evidence',
  };
  atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const indexPath = path.join(reviewRoot, 'index.json');
  const parsedIndex: unknown = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf8'))
    : { schemaVersion: 1, candidates: [] };
  if (!isArchivedCandidateIndex(parsedIndex)) {
    throw new Error(`Invalid visual candidate review index: ${indexPath}`);
  }
  const index: ArchivedCandidateIndex = {
    schemaVersion: 1,
    candidates: parsedIndex.candidates.map((candidate) => ({
      platform: candidate.platform,
      scenarioId: candidate.scenarioId,
      surfaceId: candidate.surfaceId,
      stateId: candidate.stateId,
      candidateSha256: candidate.candidateSha256,
      environmentSha256: candidate.environmentSha256,
      imagePath: candidate.imagePath,
      metadataPath: candidate.metadataPath,
      dimensionsExercised: candidate.dimensionsExercised,
      trigger: candidate.trigger,
      expectedState: candidate.expectedState,
      screenshotPolicy: 'temporary-review-evidence',
    })),
  };
  const trigger =
    typeof entry.metadata.trigger === 'string' ? entry.metadata.trigger : '';
  const expectedState =
    typeof entry.metadata.expectedState === 'string'
      ? entry.metadata.expectedState
      : '';
  const candidate = {
    platform: entry.platform,
    scenarioId: entry.scenarioId,
    surfaceId: entry.surfaceId,
    stateId: entry.stateId,
    candidateSha256,
    environmentSha256,
    imagePath: relative(imagePath),
    metadataPath: relative(metadataPath),
    dimensionsExercised: entry.dimensionsExercised,
    trigger,
    expectedState,
    screenshotPolicy: 'temporary-review-evidence',
  } satisfies ArchivedCandidateIndex['candidates'][number];
  const existingIndex = index.candidates.findIndex(
    (item) =>
      item.platform === entry.platform &&
      item.scenarioId === entry.scenarioId &&
      item.candidateSha256 === candidateSha256 &&
      item.environmentSha256 === environmentSha256,
  );
  if (existingIndex < 0) index.candidates.push(candidate);
  else index.candidates[existingIndex] = candidate;
  index.candidates.sort((left, right) =>
    `${left.platform}/${left.scenarioId}/${left.candidateSha256}`.localeCompare(
      `${right.platform}/${right.scenarioId}/${right.candidateSha256}`,
    ),
  );
  atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  return { imagePath, metadataPath, indexPath };
}
