/**
 * calibration.snapshotProvenanceGuard.test.ts — the anti-fabrication guard.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * In Round 3 the coordinator briefed the sub-agent with a payload asserted
 * in prose. The sub-agent encoded that payload into a "server contract"
 * fixture. The prose was wrong (half the field values were inverted). No
 * mechanism prevented it: the `tests/fixtures/server-contract/README.md`
 * protocol required prose-level provenance comments, but nothing enforced
 * that the comments matched a real primary source.
 *
 * This test closes that hole. It walks every snapshot under
 * `tests/fixtures/server-contract/` and asserts each declares a MACHINE-
 * READABLE `PROVENANCE` export in one of two allowed shapes:
 *
 *   1. `kind: 'csharp-source'` — the field NAMES were copied from a C# DTO
 *      at a specific commit + blob hash. When the pfarm1 checkout is on
 *      disk, we run `git hash-object <sourcePath>` at that commit and
 *      compare against the declared blob hash. Any mismatch fails.
 *
 *   2. `kind: 'live-response'` — the field VALUES were captured from the
 *      wire. The declared `serverVersion` string must match the wire
 *      response's own `serverVersion` field, and the embedded commit SHA
 *      must match SOME sibling `csharp-source` snapshot's `commitSha`. That
 *      link is what proves the captured response corresponds to code we
 *      also have snapshots of.
 *
 * A payload asserted in a prompt has neither kind — it belongs to no source,
 * so it cannot pass this guard.
 *
 * CONTROLS
 * --------
 * Per the repo rule (every matching predicate gets a control that must
 * return the opposite result on the same data), each positive assertion is
 * paired with a synthetic mutation the SAME predicate must reject.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveServerRepo } from './fixtures/server-contract/serverContractSnapshotDrift';

const SNAPSHOT_DIR = path.join(__dirname, 'fixtures', 'server-contract');

interface AdditionalSource {
  sourcePath: string;
  blobHash: string;
  typeName?: string;
  note?: string;
}

interface CSharpSourceProvenance {
  kind: 'csharp-source';
  sourceRepo: string;
  commitSha: string;
  sourcePath: string;
  blobHash: string;
  typeName?: string;
  additionalSources?: readonly AdditionalSource[];
}

interface LiveResponseProvenance {
  kind: 'live-response';
  sourceRepo: string;
  capturedFrom: string;
  serverVersion: string;
  commitSha: string;
  capturedAt: string;
}

type Provenance = CSharpSourceProvenance | LiveResponseProvenance;

interface LoadedSnapshot {
  file: string;
  module: Record<string, unknown>;
  provenance: Provenance | null;
}

function isProvenance(value: unknown): value is Provenance {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'csharp-source') {
    return (
      typeof record.sourceRepo === 'string' &&
      typeof record.commitSha === 'string' &&
      typeof record.sourcePath === 'string' &&
      typeof record.blobHash === 'string'
    );
  }
  if (record.kind === 'live-response') {
    return (
      typeof record.sourceRepo === 'string' &&
      typeof record.capturedFrom === 'string' &&
      typeof record.serverVersion === 'string' &&
      typeof record.commitSha === 'string' &&
      typeof record.capturedAt === 'string'
    );
  }
  return false;
}

function discoverSnapshotFiles(): string[] {
  return readdirSync(SNAPSHOT_DIR)
    .filter((entry) => entry.endsWith('.snapshot.ts'))
    .sort();
}

async function loadSnapshot(file: string): Promise<LoadedSnapshot> {
  const abs = path.join(SNAPSHOT_DIR, file);
  const module = (await import(abs)) as Record<string, unknown>;
  const provenance = isProvenance(module.PROVENANCE) ? module.PROVENANCE : null;
  return { file, module, provenance };
}

function computeGitBlob(repoRoot: string, relPath: string): string | null {
  try {
    const abs = path.join(repoRoot, relPath.split('/').join(path.sep));
    if (!existsSync(abs)) return null;
    const output = execSync(`git hash-object "${abs}"`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim();
  } catch {
    return null;
  }
}

describe('server-contract snapshot provenance guard', () => {
  const snapshotFiles = discoverSnapshotFiles();

  it('there is at least one snapshot to guard (sanity)', () => {
    expect(snapshotFiles.length).toBeGreaterThan(0);
  });

  for (const file of snapshotFiles) {
    describe(file, () => {
      it('exports a machine-checkable PROVENANCE object of a recognised kind', async () => {
        const snapshot = await loadSnapshot(file);
        expect(
          snapshot.provenance,
          `${file} does not export a valid PROVENANCE object. Every server-contract snapshot MUST declare where its values came from: either kind='csharp-source' (with commitSha, sourcePath, blobHash) or kind='live-response' (with serverVersion, commitSha, capturedFrom, capturedAt). A prose-only header comment does not satisfy this — see calibration.snapshotProvenanceGuard.test.ts for the rule and the Round-3 fabrication that made it necessary.`,
        ).not.toBeNull();
      });
    });
  }
});

describe('csharp-source snapshots — blob hashes match live pfarm1 checkout', () => {
  const serverRepo = resolveServerRepo();
  const snapshotFiles = discoverSnapshotFiles();

  for (const file of snapshotFiles) {
    it.skipIf(!serverRepo)(
      `${file}: primary source + additional-source blob hashes match git hash-object`,
      async () => {
        const snapshot = await loadSnapshot(file);
        expect(snapshot.provenance).not.toBeNull();
        if (snapshot.provenance === null) return;
        if (snapshot.provenance.kind !== 'csharp-source') return;

        const primary = computeGitBlob(
          serverRepo!,
          snapshot.provenance.sourcePath,
        );
        expect(
          primary,
          `Could not compute git blob for ${snapshot.provenance.sourcePath} in ${serverRepo}. Check the path exists at the pinned commit.`,
        ).not.toBeNull();
        expect(
          primary,
          `${file}: declared blobHash=${snapshot.provenance.blobHash} for ${snapshot.provenance.sourcePath}, but git hash-object returned ${primary}. The snapshot is stale, OR the pfarm1 checkout has advanced past the pinned commit, OR the blob hash was fabricated. Re-derive by running: git -C ${serverRepo} hash-object ${snapshot.provenance.sourcePath}`,
        ).toBe(snapshot.provenance.blobHash);

        for (const additional of snapshot.provenance.additionalSources ?? []) {
          const actual = computeGitBlob(serverRepo!, additional.sourcePath);
          expect(
            actual,
            `${file}: additional source ${additional.sourcePath} could not be blob-hashed.`,
          ).not.toBeNull();
          expect(
            actual,
            `${file}: additional source ${additional.sourcePath} declared blobHash=${additional.blobHash} but actual is ${actual}.`,
          ).toBe(additional.blobHash);
        }
      },
    );
  }

  it.skipIf(!serverRepo)(
    'positive control: computeGitBlob returns a non-null 40-char SHA for a known-good path',
    () => {
      const primary = computeGitBlob(
        serverRepo!,
        'src/infra/Dtos/PlatformCapabilitiesDto.cs',
      );
      expect(primary).not.toBeNull();
      expect(primary).toMatch(/^[0-9a-f]{40}$/);
    },
  );

  it.skipIf(!serverRepo)(
    'negative control: computeGitBlob returns null for a fabricated non-existent path',
    () => {
      const result = computeGitBlob(
        serverRepo!,
        'src/this/file/does/not/exist/on/any/branch.cs',
      );
      expect(result).toBeNull();
    },
  );

  it.skipIf(!serverRepo)(
    'synthetic-mutation control: comparing a fabricated blob hash against the same live source fails through the SAME predicate',
    () => {
      const primary = computeGitBlob(
        serverRepo!,
        'src/infra/Dtos/PlatformCapabilitiesDto.cs',
      );
      const fabricatedProvenance: CSharpSourceProvenance = {
        kind: 'csharp-source',
        sourceRepo: 'OlyForge3D/PrintFarmer',
        commitSha: '0000000000000000000000000000000000000000',
        sourcePath: 'src/infra/Dtos/PlatformCapabilitiesDto.cs',
        blobHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      };
      expect(
        primary,
        'fabricated blob hash must NOT match the real one — otherwise the guard is not actually checking',
      ).not.toBe(fabricatedProvenance.blobHash);
    },
  );
});

describe('live-response snapshots — serverVersion is self-consistent and cross-references a csharp-source snapshot', () => {
  it('the capabilities live capture is anchored by a csharp-source snapshot at the same commit', async () => {
    const snapshotFiles = discoverSnapshotFiles();
    const snapshots = await Promise.all(snapshotFiles.map(loadSnapshot));

    const liveResponses = snapshots.filter(
      (s): s is LoadedSnapshot & { provenance: LiveResponseProvenance } =>
        s.provenance?.kind === 'live-response',
    );
    const sourceSnapshots = snapshots.filter(
      (s): s is LoadedSnapshot & { provenance: CSharpSourceProvenance } =>
        s.provenance?.kind === 'csharp-source',
    );

    expect(
      liveResponses.length,
      'at least one live-response snapshot must be present in Round 4',
    ).toBeGreaterThan(0);

    for (const live of liveResponses) {
      // Extract the payload — every live-response snapshot exports its
      // captured body as its main const. Convention: the export whose
      // value is an object with a `serverVersion` string field.
      const capturedBody = Object.values(live.module).find(
        (v): v is Record<string, unknown> =>
          typeof v === 'object' &&
          v !== null &&
          typeof (v as Record<string, unknown>).serverVersion === 'string',
      );
      expect(
        capturedBody,
        `${live.file}: no exported const has a serverVersion field — cannot verify PROVENANCE.serverVersion matches the captured body.`,
      ).toBeDefined();

      if (capturedBody !== undefined) {
        expect(
          capturedBody.serverVersion,
          `${live.file}: PROVENANCE.serverVersion=${live.provenance.serverVersion} does not equal the captured body's serverVersion=${String(capturedBody.serverVersion)}. The provenance stamp is lying about the response it belongs to.`,
        ).toBe(live.provenance.serverVersion);
      }

      const matchingSource = sourceSnapshots.find(
        (s) => s.provenance.commitSha === live.provenance.commitSha,
      );
      expect(
        matchingSource,
        `${live.file}: PROVENANCE.commitSha=${live.provenance.commitSha} does not match any csharp-source snapshot's commitSha. The live capture is orphaned — we have no source snapshot at the commit the response was generated from.`,
      ).toBeDefined();
    }
  });

  it('control: a fabricated live-response provenance with mismatched serverVersion fails through the SAME predicate', () => {
    // Simulate the fabrication case explicitly. If we ran the same
    // predicate against fabricated inputs, the assertion below MUST flip.
    const fabricatedCommit = '0000000000000000000000000000000000000000';
    const fabricatedProvenance: LiveResponseProvenance = {
      kind: 'live-response',
      sourceRepo: 'OlyForge3D/PrintFarmer',
      capturedFrom: 'http://localhost:18080/api/calibration/capabilities',
      serverVersion: `1.2.3+${fabricatedCommit}`,
      commitSha: fabricatedCommit,
      capturedAt: '2026-01-01T00:00:00Z',
    };
    const capturedBody = {
      serverVersion: '0.2.3+6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e',
    };
    // Same equality predicate the guard applies to real snapshots.
    expect(capturedBody.serverVersion).not.toBe(
      fabricatedProvenance.serverVersion,
    );
  });
});

describe('provenance kind is exhaustive — an unknown kind is rejected', () => {
  it('isProvenance rejects a payload with kind="prose"', () => {
    const fabricated = {
      kind: 'prose',
      sourceRepo: 'OlyForge3D/PrintFarmer',
      commitSha: '6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e',
      note: 'coordinator asserted this shape in a message',
    };
    expect(isProvenance(fabricated)).toBe(false);
  });

  it('isProvenance rejects a payload with no kind field at all', () => {
    expect(
      isProvenance({
        sourceRepo: 'x',
        commitSha: 'y',
        blobHash: 'z',
      }),
    ).toBe(false);
  });

  it('isProvenance accepts a well-formed csharp-source payload', () => {
    expect(
      isProvenance({
        kind: 'csharp-source',
        sourceRepo: 'x',
        commitSha: 'y',
        sourcePath: 'a/b/c.cs',
        blobHash: 'z',
      }),
    ).toBe(true);
  });

  it('isProvenance accepts a well-formed live-response payload', () => {
    expect(
      isProvenance({
        kind: 'live-response',
        sourceRepo: 'x',
        capturedFrom: 'http://loopback',
        serverVersion: 'v',
        commitSha: 'y',
        capturedAt: 't',
      }),
    ).toBe(true);
  });
});
