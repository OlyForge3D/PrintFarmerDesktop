import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { archiveVisualCandidate } from '../e2e/visualCandidateArchive';

function parseArchiveIndex(content: string): { candidates: unknown[] } {
  const parsed: unknown = JSON.parse(content);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('candidates' in parsed) ||
    !Array.isArray(parsed.candidates)
  ) {
    throw new Error('Invalid visual candidate test index.');
  }
  return parsed as { candidates: unknown[] };
}

describe('visual candidate review archive', () => {
  let reviewRoot: string | null = null;

  afterEach(() => {
    if (reviewRoot !== null)
      rmSync(reviewRoot, { recursive: true, force: true });
    reviewRoot = null;
  });

  it('preserves image and metadata by image/environment digest with an explicit mapping', () => {
    reviewRoot = mkdtempSync(path.join(tmpdir(), 'pf-visual-review-'));
    const entry = {
      platform: 'windows' as const,
      scenarioId: 'library.grid.selection',
      surfaceId: 'library.grid-cards',
      stateId: 'selection',
      dimensionsExercised: [
        'The populated card pressed state follows selection.',
      ],
      image: Buffer.from('candidate image one'),
      metadata: {
        candidateSha256: 'untrusted-input-is-not-used-for-paths',
        environmentSha256: 'environment-one',
        trigger: 'Select the synthetic model card.',
        expectedState: 'The card reports selected.',
      },
    };

    const first = archiveVisualCandidate(reviewRoot, entry);
    const firstIndex = parseArchiveIndex(readFileSync(first.indexPath, 'utf8'));
    expect(firstIndex.candidates).toHaveLength(1);
    expect(firstIndex.candidates[0]).toMatchObject({
      scenarioId: entry.scenarioId,
      surfaceId: entry.surfaceId,
      stateId: entry.stateId,
      dimensionsExercised: entry.dimensionsExercised,
      trigger: entry.metadata.trigger,
      expectedState: entry.metadata.expectedState,
      screenshotPolicy: 'temporary-review-evidence',
    });
    expect(readFileSync(first.imagePath)).toEqual(entry.image);
    const firstMetadata: unknown = JSON.parse(
      readFileSync(first.metadataPath, 'utf8'),
    );
    expect(firstMetadata).toMatchObject({
      dimensionsExercised: entry.dimensionsExercised,
      screenshotPolicy: 'temporary-review-evidence',
    });
    const archivedImagePath =
      typeof firstMetadata === 'object' &&
      firstMetadata !== null &&
      'archivedImagePath' in firstMetadata &&
      typeof firstMetadata.archivedImagePath === 'string'
        ? firstMetadata.archivedImagePath
        : null;
    expect(archivedImagePath).toMatch(/\.png$/);

    archiveVisualCandidate(reviewRoot, entry);
    const second = archiveVisualCandidate(reviewRoot, {
      ...entry,
      image: Buffer.from('candidate image two'),
    });
    const finalIndex = parseArchiveIndex(
      readFileSync(second.indexPath, 'utf8'),
    );
    expect(finalIndex.candidates).toHaveLength(2);
    expect(readdirSync(path.dirname(first.imagePath))).toHaveLength(4);
    expect(readFileSync(first.imagePath)).toEqual(
      Buffer.from('candidate image one'),
    );
    expect(readFileSync(second.imagePath)).toEqual(
      Buffer.from('candidate image two'),
    );
    expect(JSON.stringify(finalIndex)).not.toContain('humanApprovalRequired');
    expect(JSON.stringify(finalIndex)).not.toContain('visualStatus');
    expect(JSON.stringify(firstMetadata)).not.toContain('expectedBaselinePath');
  });

  it('rejects unsafe IDs and incomplete state mappings', () => {
    reviewRoot = mkdtempSync(path.join(tmpdir(), 'pf-visual-review-'));
    const entry = {
      platform: 'windows' as const,
      scenarioId: '../outside',
      surfaceId: 'library.grid-cards',
      stateId: 'selection',
      dimensionsExercised: ['selected'],
      image: Buffer.from('candidate'),
      metadata: {},
    };
    expect(() => archiveVisualCandidate(reviewRoot!, entry)).toThrow(
      'Invalid visual candidate scenario ID',
    );
    expect(() =>
      archiveVisualCandidate(reviewRoot!, {
        ...entry,
        scenarioId: 'library.grid.selection',
        dimensionsExercised: [],
      }),
    ).toThrow('Incomplete visual candidate archive mapping');
  });

  it('keeps companion metadata and index consistent when the same image is recaptured', () => {
    reviewRoot = mkdtempSync(path.join(tmpdir(), 'pf-visual-review-'));
    const entry = {
      platform: 'windows' as const,
      scenarioId: 'library.grid.selection',
      surfaceId: 'library.grid-cards',
      stateId: 'selection',
      dimensionsExercised: ['selected'],
      image: Buffer.from('same image'),
      metadata: {
        environmentSha256: 'same-environment',
        expectedState: 'Original assertion scope.',
      },
    };
    const first = archiveVisualCandidate(reviewRoot, entry);
    const updated = {
      ...entry,
      dimensionsExercised: ['selected', 'keyboard focus'],
      metadata: {
        ...entry.metadata,
        expectedState: 'Selected card retains keyboard focus.',
      },
    };
    const second = archiveVisualCandidate(reviewRoot, updated);
    expect(second.metadataPath).toBe(first.metadataPath);
    const index = parseArchiveIndex(readFileSync(second.indexPath, 'utf8'));
    expect(index.candidates).toHaveLength(1);
    expect(index.candidates[0]).toMatchObject({
      dimensionsExercised: updated.dimensionsExercised,
      expectedState: updated.metadata.expectedState,
    });
    const metadata: unknown = JSON.parse(
      readFileSync(second.metadataPath, 'utf8'),
    );
    expect(metadata).toMatchObject({
      dimensionsExercised: updated.dimensionsExercised,
      expectedState: updated.metadata.expectedState,
    });
    expect(readFileSync(first.imagePath)).toEqual(entry.image);
  });

  it('retains older captured images while normalizing legacy index approval fields', () => {
    reviewRoot = mkdtempSync(path.join(tmpdir(), 'pf-visual-review-'));
    const entry = {
      platform: 'windows' as const,
      scenarioId: 'library.grid.selection',
      surfaceId: 'library.grid-cards',
      stateId: 'selection',
      dimensionsExercised: ['selected'],
      image: Buffer.from('historical image'),
      metadata: { environmentSha256: 'environment' },
    };
    const first = archiveVisualCandidate(reviewRoot, entry);
    const index = parseArchiveIndex(readFileSync(first.indexPath, 'utf8'));
    const legacy = index.candidates[0];
    if (typeof legacy !== 'object' || legacy === null) {
      throw new Error('Expected archived candidate record.');
    }
    Reflect.deleteProperty(legacy, 'screenshotPolicy');
    Reflect.set(legacy, 'visualStatus', 'pending');
    Reflect.set(legacy, 'humanApprovalRequired', true);
    writeFileSync(first.indexPath, JSON.stringify(index));
    const historicalMetadata = readFileSync(first.metadataPath);

    const next = archiveVisualCandidate(reviewRoot, {
      ...entry,
      image: Buffer.from('current image'),
    });
    const normalized = parseArchiveIndex(readFileSync(next.indexPath, 'utf8'));
    expect(normalized.candidates).toHaveLength(2);
    expect(normalized.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          screenshotPolicy: 'temporary-review-evidence',
        }),
      ]),
    );
    expect(JSON.stringify(normalized)).not.toContain('humanApprovalRequired');
    expect(JSON.stringify(normalized)).not.toContain('visualStatus');
    expect(readFileSync(first.imagePath)).toEqual(entry.image);
    expect(readFileSync(first.metadataPath)).toEqual(historicalMetadata);
  });
});
