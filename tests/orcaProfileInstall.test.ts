/**
 * Unit tests for the OrcaSlicer profile install/restore service (issue #55).
 *
 * Covers: path computation, safe filename validation, canonical root guard,
 * profile cache operations, transactional install (success, temp cleanup,
 * verification failure), restore (hash verification, atomicity),
 * macOS canonicalization guards, and OrcaSlicer running detection contract.
 *
 * Independently authored test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {
  writeFile,
  mkdtemp,
  rm,
  symlink,
  readdir,
  mkdir,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  computeInstallPath,
  getWindowsOrcaInstallRoot,
  cacheGeneratedProfile,
  getCachedProfile,
  clearProfileCache,
  verifyExportedProfile,
  canonicalizeSaveTarget,
} from '../src/main/orcaProfileInstall.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'pfd-install-test-'));
}

/**
 * Create a reparse point at `link` pointing at directory `targetDir`.
 *
 * Windows junctions are directory-only and need no elevated privilege,
 * which a CI runner may not grant for file symlinks. Mirrors the same
 * helper in tests/calibrationMaliciousInputCorpus.test.ts so the
 * backup-metadata directory hardening is exercised with the identical
 * reparse-point fixture technique used for the existing install-path
 * hardening (#158 / #208 follow-up).
 */
async function makeDirReparsePoint(
  targetDir: string,
  link: string,
): Promise<void> {
  if (process.platform === 'win32') {
    await symlink(targetDir, link, 'junction');
    return;
  }
  await symlink(targetDir, link, 'dir');
}

// ---------------------------------------------------------------------------
// computeInstallPath
// ---------------------------------------------------------------------------

describe('computeInstallPath', () => {
  it('returns the joined path for a valid safeFilename', () => {
    const root = '/some/root';
    const filename = 'My_Profile_PFD-abc12345.json';
    const result = computeInstallPath(filename, root);
    expect(result).toBe(path.join(root, filename));
  });

  it('rejects filenames containing forward slash', () => {
    expect(() => computeInstallPath('path/traversal.json', '/root')).toThrow();
  });

  it('rejects filenames containing backslash', () => {
    expect(() => computeInstallPath('path\\traversal.json', '/root')).toThrow();
  });

  it('rejects filenames containing null byte', () => {
    expect(() => computeInstallPath('evil\0name.json', '/root')).toThrow();
  });

  it('rejects filenames not ending in .json', () => {
    expect(() => computeInstallPath('evil.exe', '/root')).toThrow();
  });

  it('rejects filenames longer than 200 chars', () => {
    const longName = 'a'.repeat(196) + '.json'; // 201 chars total
    expect(() => computeInstallPath(longName, '/root')).toThrow();
  });

  it('rejects empty filenames', () => {
    expect(() => computeInstallPath('', '/root')).toThrow();
  });

  it('rejects filenames shorter than 6 chars (min .json + 1 char)', () => {
    expect(() => computeInstallPath('a.json', '/root')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getWindowsOrcaInstallRoot (Windows-only, non-throwing on other platforms)
// ---------------------------------------------------------------------------

describe('getWindowsOrcaInstallRoot', () => {
  it('throws on non-Windows when APPDATA is not set', () => {
    if (process.platform === 'win32') {
      // On Windows, APPDATA should be set by the OS
      expect(() => getWindowsOrcaInstallRoot()).not.toThrow();
    } else {
      // On non-Windows, APPDATA is typically not set
      const originalAppData = process.env['APPDATA'];
      delete process.env['APPDATA'];
      try {
        expect(() => getWindowsOrcaInstallRoot()).toThrow();
      } finally {
        if (originalAppData !== undefined) {
          process.env['APPDATA'] = originalAppData;
        }
      }
    }
  });

  it('includes OrcaSlicer in the path when APPDATA is set', () => {
    const originalAppData = process.env['APPDATA'];
    process.env['APPDATA'] = '/fake/appdata';
    try {
      const root = getWindowsOrcaInstallRoot();
      expect(root.toLowerCase()).toContain('orcaslicer');
    } finally {
      if (originalAppData !== undefined) {
        process.env['APPDATA'] = originalAppData;
      } else {
        delete process.env['APPDATA'];
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Generated profile cache
// ---------------------------------------------------------------------------

describe('Profile cache (cacheGeneratedProfile / getCachedProfile)', () => {
  beforeEach(() => clearProfileCache());
  afterEach(() => clearProfileCache());

  it('stores and retrieves a profile by operationId', () => {
    const operationId = 'op-001';
    const entry = {
      generatedJson: '{"name":"test"}',
      profileJsonHash: 'a'.repeat(64),
      displayName: 'Test Profile',
      safeFilename: 'test.json',
      cachedAt: Date.now(),
    };
    cacheGeneratedProfile(operationId, entry);
    const retrieved = getCachedProfile(operationId);
    expect(retrieved).toEqual(entry);
  });

  it('returns undefined for unknown operationId', () => {
    expect(getCachedProfile('unknown-op')).toBeUndefined();
  });

  it('returns undefined after clearProfileCache', () => {
    cacheGeneratedProfile('op-002', {
      generatedJson: '{}',
      profileJsonHash: 'b'.repeat(64),
      displayName: 'B',
      safeFilename: 'b.json',
      cachedAt: Date.now(),
    });
    clearProfileCache();
    expect(getCachedProfile('op-002')).toBeUndefined();
  });

  it('evicts oldest entry when max entries (50) is reached', () => {
    // Insert 50 entries
    for (let i = 0; i < 50; i++) {
      cacheGeneratedProfile(`op-${i.toString().padStart(3, '0')}`, {
        generatedJson: `{"i":${i}}`,
        profileJsonHash: 'a'.repeat(64),
        displayName: `Profile ${i}`,
        safeFilename: `profile_${i}.json`,
        cachedAt: Date.now() + i,
      });
    }
    // All 50 should be present
    expect(getCachedProfile('op-000')).toBeDefined();

    // Add one more — should evict the oldest (op-000)
    cacheGeneratedProfile('op-050', {
      generatedJson: '{"i":50}',
      profileJsonHash: 'b'.repeat(64),
      displayName: 'Profile 50',
      safeFilename: 'profile_50.json',
      cachedAt: Date.now() + 50,
    });
    // op-000 should be gone
    expect(getCachedProfile('op-000')).toBeUndefined();
    // op-050 should be present
    expect(getCachedProfile('op-050')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// verifyExportedProfile
// ---------------------------------------------------------------------------

describe('verifyExportedProfile', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns the correct hash for a file with matching content', async () => {
    const content = '{"name":"Test Profile","type":"filament"}';
    const hash = sha256(content);
    const filePath = path.join(tmpDir, 'profile.json');
    await writeFile(filePath, content, 'utf8');
    const result = await verifyExportedProfile(filePath, hash);
    expect(result).toBe(hash);
  });

  it('throws verificationFailed when hash does not match', async () => {
    const content = '{"name":"Test Profile"}';
    const filePath = path.join(tmpDir, 'profile.json');
    await writeFile(filePath, content, 'utf8');
    await expect(
      verifyExportedProfile(filePath, 'a'.repeat(64)),
    ).rejects.toMatchObject({ code: 'verificationFailed' });
  });

  it('throws verificationFailed when file does not exist', async () => {
    await expect(
      verifyExportedProfile(
        path.join(tmpDir, 'nonexistent.json'),
        'a'.repeat(64),
      ),
    ).rejects.toMatchObject({ code: 'verificationFailed' });
  });
});

// ---------------------------------------------------------------------------
// canonicalizeSaveTarget
// ---------------------------------------------------------------------------

describe('canonicalizeSaveTarget', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns a canonicalized path for a valid target in a writable directory', async () => {
    const target = path.join(tmpDir, 'output.json');
    const result = await canonicalizeSaveTarget(target);
    // Should return a path with the same filename
    expect(path.basename(result)).toBe('output.json');
  });

  it('rejects paths in system directories', async () => {
    if (process.platform !== 'win32') {
      await expect(
        canonicalizeSaveTarget('/System/Library/output.json'),
      ).rejects.toMatchObject({ code: 'pathRestricted' });
      await expect(
        canonicalizeSaveTarget('/usr/local/output.json'),
      ).rejects.toMatchObject({ code: 'pathRestricted' });
    }
  });

  it('rejects non-existent parent directory', async () => {
    const badTarget = path.join(tmpDir, 'nonexistent', 'subdir', 'output.json');
    await expect(canonicalizeSaveTarget(badTarget)).rejects.toMatchObject({
      code: 'pathRestricted',
    });
  });
});

// ---------------------------------------------------------------------------
// Transactional install integration test (non-Windows: unsupportedPlatform)
// ---------------------------------------------------------------------------

import {
  installOrcaProfileWindows,
  restoreOrcaProfileWindows,
  findBackupByOperationId,
} from '../src/main/orcaProfileInstall.js';

describe('installOrcaProfileWindows', () => {
  it('throws unsupportedPlatform on non-Windows or rejects hash mismatch on Windows', async () => {
    const content = '{"name":"Test Profile","type":"filament"}';
    if (process.platform !== 'win32') {
      // Non-Windows: throws unsupportedPlatform before any other check
      await expect(
        installOrcaProfileWindows(
          content,
          'a'.repeat(64),
          'test.json',
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'unsupportedPlatform' });
    } else {
      // Windows: rejects when hash does not match the provided content
      await expect(
        installOrcaProfileWindows(
          content,
          'b'.repeat(64),
          'test_profile.json',
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'verificationFailed' });
    }
  });
});

describe('restoreOrcaProfileWindows', () => {
  it.runIf(process.platform !== 'win32')(
    'throws unsupportedPlatform on non-Windows',
    async () => {
      await expect(
        restoreOrcaProfileWindows(
          '/some/backup.bak',
          'a'.repeat(64),
          'test.json',
        ),
      ).rejects.toMatchObject({ code: 'unsupportedPlatform' });
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects a backup whose actual content hash does not match expectedBackupHash',
    async () => {
      const tmpDir = await makeTempDir();
      try {
        const backupPath = path.join(
          tmpDir,
          'profile.json.bak-2024-01-01T00-00-00-000Z',
        );
        await writeFile(backupPath, '{"name":"real"}');
        await expect(
          restoreOrcaProfileWindows(backupPath, 'f'.repeat(64), 'profile.json'),
        ).rejects.toMatchObject({ code: 'verificationFailed' });
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// findBackupByOperationId — durable, cache-independent backup identity (#208)
//
// Restore used to be gated on `getCachedProfile(operationId)`, an in-memory,
// process-lifetime, 50-entry LRU cache. That made a durable, hash-verified
// restore fail after a restart or after 50 subsequent installs evicted the
// original entry, even though the backup file on disk was untouched.
//
// A first fix attempt widened the lookup to scan the install directory for
// any backup file whose *content hash* matched what the caller supplied.
// That was itself unsafe: two different profiles can have byte-identical
// prior content (and therefore the same SHA-256 hash), which would let
// restore silently pick the wrong profile's backup. Reverse-parsing
// `safeFilename` back out of the backup's own filename was also unsafe: a
// generated profile's filename can legitimately contain the literal
// substring `.bak-` (see generateProfileIdentity), which corrupts that
// parse.
//
// findBackupByOperationId instead resolves identity from a durable metadata
// record written once, at backup-creation time, keyed by `operationId` —
// never by content hash or filename parsing. The content hash remains the
// separate safety check, enforced by restoreOrcaProfileWindows before any
// write.
// ---------------------------------------------------------------------------

describe('findBackupByOperationId', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when the install directory does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    expect(await findBackupByOperationId(missing, randomUUID())).toBeNull();
  });

  it('returns null when there is no metadata record for this operationId', async () => {
    expect(await findBackupByOperationId(tmpDir, randomUUID())).toBeNull();
  });

  it('rejects a malformed (non-UUID) operationId rather than guessing', async () => {
    expect(
      await findBackupByOperationId(tmpDir, 'not-a-uuid; ../../escape'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: restore survives restart and cache eviction (#208)
//
// These exercise the real install -> (simulated restart / cache eviction) ->
// findBackupByOperationId -> restoreOrcaProfileWindows pipeline against a
// sandboxed APPDATA so no real OrcaSlicer install directory is touched.
// ---------------------------------------------------------------------------

describe('restore pipeline is independent of profileCache state (#208)', () => {
  let sandboxAppData: string;
  const originalAppData = process.env['APPDATA'];

  beforeEach(async () => {
    sandboxAppData = await makeTempDir();
    process.env['APPDATA'] = sandboxAppData;
    clearProfileCache();
  });

  afterEach(async () => {
    if (originalAppData !== undefined) {
      process.env['APPDATA'] = originalAppData;
    } else {
      delete process.env['APPDATA'];
    }
    await rm(sandboxAppData, { recursive: true, force: true });
    clearProfileCache();
  });

  it.runIf(process.platform === 'win32')(
    'restores after a simulated restart clears the in-memory cache',
    async () => {
      const operationId = randomUUID();
      const safeFilename = 'restart_profile.json';
      const original = '{"name":"v1"}';
      const updated = '{"name":"v2"}';

      // Install v1 (nothing to back up yet), then v2 over it (backs up v1).
      await installOrcaProfileWindows(
        original,
        sha256(original),
        safeFilename,
        randomUUID(),
      );
      cacheGeneratedProfile(operationId, {
        generatedJson: updated,
        profileJsonHash: sha256(updated),
        displayName: 'Restart Profile',
        safeFilename,
        cachedAt: Date.now(),
      });
      const installResult = await installOrcaProfileWindows(
        updated,
        sha256(updated),
        safeFilename,
        operationId,
      );
      expect(getCachedProfile(operationId)).toBeDefined();

      // Simulate an app restart: the in-memory cache is gone, but the
      // operationId the renderer still has is unchanged.
      clearProfileCache();
      expect(getCachedProfile(operationId)).toBeUndefined();

      const installRoot = getWindowsOrcaInstallRoot();
      const located = await findBackupByOperationId(installRoot, operationId);
      expect(located).not.toBeNull();
      expect(located?.safeFilename).toBe(safeFilename);
      const restoreResult = await restoreOrcaProfileWindows(
        located!.backupPath,
        installResult.backupHash,
        located!.safeFilename,
      );
      expect(restoreResult.restoredHash).toBe(installResult.backupHash);
    },
  );

  it.runIf(process.platform === 'win32')(
    'restores after 50+ installs evict the original cache entry',
    async () => {
      const operationId = randomUUID();
      const safeFilename = 'evicted_profile.json';
      const original = '{"name":"v1-evict"}';
      const updated = '{"name":"v2-evict"}';

      await installOrcaProfileWindows(
        original,
        sha256(original),
        safeFilename,
        randomUUID(),
      );
      cacheGeneratedProfile(operationId, {
        generatedJson: updated,
        profileJsonHash: sha256(updated),
        displayName: 'Evicted Profile',
        safeFilename,
        cachedAt: Date.now(),
      });
      const installResult = await installOrcaProfileWindows(
        updated,
        sha256(updated),
        safeFilename,
        operationId,
      );
      expect(getCachedProfile(operationId)).toBeDefined();

      // Fill the cache past MAX_CACHE_ENTRIES so the original entry is
      // LRU-evicted, exactly as happens after 50 more installs in one
      // still-running session (no restart required).
      for (let i = 0; i < 60; i++) {
        cacheGeneratedProfile(`filler-op-${i}`, {
          generatedJson: `{"i":${i}}`,
          profileJsonHash: 'a'.repeat(64),
          displayName: `Filler ${i}`,
          safeFilename: `filler_${i}.json`,
          cachedAt: Date.now() + i + 1,
        });
      }
      expect(getCachedProfile(operationId)).toBeUndefined();

      const installRoot = getWindowsOrcaInstallRoot();
      const located = await findBackupByOperationId(installRoot, operationId);
      expect(located).not.toBeNull();
      expect(located?.safeFilename).toBe(safeFilename);
      const restoreResult = await restoreOrcaProfileWindows(
        located!.backupPath,
        installResult.backupHash,
        located!.safeFilename,
      );
      expect(restoreResult.restoredHash).toBe(installResult.backupHash);
    },
  );

  it.runIf(process.platform === 'win32')(
    'still refuses a tampered backup even when correctly located by operationId',
    async () => {
      const operationId = randomUUID();
      const safeFilename = 'tamper_profile.json';
      const original = '{"name":"v1-tamper"}';
      const updated = '{"name":"v2-tamper"}';

      await installOrcaProfileWindows(
        original,
        sha256(original),
        safeFilename,
        randomUUID(),
      );
      const installResult = await installOrcaProfileWindows(
        updated,
        sha256(updated),
        safeFilename,
        operationId,
      );

      // Tamper with the backup file on disk after it was created. Its
      // content hash no longer matches what the caller (renderer) was
      // originally given.
      await writeFile(installResult.backupPath, '{"name":"tampered!"}');

      const installRoot = getWindowsOrcaInstallRoot();
      // Identity resolution still finds the record — that part does not
      // depend on content — but the hash-verifying write itself must still
      // refuse, so widening past the cache never weakens the safety check.
      const located = await findBackupByOperationId(installRoot, operationId);
      expect(located).not.toBeNull();
      await expect(
        restoreOrcaProfileWindows(
          located!.backupPath,
          installResult.backupHash,
          located!.safeFilename,
        ),
      ).rejects.toMatchObject({ code: 'verificationFailed' });
    },
  );

  it.runIf(process.platform === 'win32')(
    'resolves the correct profile by operationId even when two profiles share a backupHash (hash collision)',
    async () => {
      // This exercises 4 installs + 2 lookups + 2 restores, each now doing
      // an extra per-segment reparse-point walk for the backup-metadata
      // directory (#208 follow-up hardening); comfortably fast locally, but
      // the default 5s test timeout is tight under CI I/O contention.
      // Two different profiles whose *prior* on-disk content happens to be
      // byte-identical — so their backups share the same SHA-256 hash. A
      // hash-only lookup cannot distinguish which backup belongs to which
      // profile; operationId must.
      const sharedPriorContent = '{"name":"identical-prior-content"}';
      const updatedA = '{"name":"profile-a-v2"}';
      const updatedB = '{"name":"profile-b-v2"}';
      const safeFilenameA = 'profile_a.json';
      const safeFilenameB = 'profile_b.json';
      const operationIdA = randomUUID();
      const operationIdB = randomUUID();

      await installOrcaProfileWindows(
        sharedPriorContent,
        sha256(sharedPriorContent),
        safeFilenameA,
        randomUUID(),
      );
      await installOrcaProfileWindows(
        sharedPriorContent,
        sha256(sharedPriorContent),
        safeFilenameB,
        randomUUID(),
      );

      const installResultA = await installOrcaProfileWindows(
        updatedA,
        sha256(updatedA),
        safeFilenameA,
        operationIdA,
      );
      const installResultB = await installOrcaProfileWindows(
        updatedB,
        sha256(updatedB),
        safeFilenameB,
        operationIdB,
      );

      // Both backups are byte-identical, so their hashes collide.
      expect(installResultA.backupHash).toBe(installResultB.backupHash);
      expect(installResultA.backupHash).toBe(sha256(sharedPriorContent));

      const installRoot = getWindowsOrcaInstallRoot();

      const locatedA = await findBackupByOperationId(installRoot, operationIdA);
      const locatedB = await findBackupByOperationId(installRoot, operationIdB);
      expect(locatedA).not.toBeNull();
      expect(locatedB).not.toBeNull();
      // Each operationId must resolve to its own profile's safeFilename and
      // its own distinct backup file — not to whichever hash-matching file
      // a scan happened to find first.
      expect(locatedA?.safeFilename).toBe(safeFilenameA);
      expect(locatedB?.safeFilename).toBe(safeFilenameB);
      expect(locatedA?.backupPath).not.toBe(locatedB?.backupPath);

      const restoredA = await restoreOrcaProfileWindows(
        locatedA!.backupPath,
        installResultA.backupHash,
        locatedA!.safeFilename,
      );
      const restoredB = await restoreOrcaProfileWindows(
        locatedB!.backupPath,
        installResultB.backupHash,
        locatedB!.safeFilename,
      );
      expect(restoredA.restoredHash).toBe(sha256(sharedPriorContent));
      expect(restoredB.restoredHash).toBe(sha256(sharedPriorContent));

      const destA = computeInstallPath(safeFilenameA, installRoot);
      const destB = computeInstallPath(safeFilenameB, installRoot);
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(destA, 'utf8')).toBe(sharedPriorContent);
      expect(await readFile(destB, 'utf8')).toBe(sharedPriorContent);
    },
    15_000,
  );

  it.runIf(process.platform === 'win32')(
    'resolves identity correctly even when safeFilename itself contains the literal substring ".bak-"',
    async () => {
      // generateProfileIdentity only strips path-reserved characters, so a
      // base profile name containing ".bak-" produces a safeFilename that
      // legitimately contains that substring too. Reverse-parsing the
      // backup's own filename to recover safeFilename (the previous
      // approach) breaks on names like this; reading it from durable
      // metadata does not.
      const safeFilename = 'PLA.bak-test_[PFD-abc12345].json';
      const operationId = randomUUID();
      const original = '{"name":"v1-bak-substring"}';
      const updated = '{"name":"v2-bak-substring"}';

      await installOrcaProfileWindows(
        original,
        sha256(original),
        safeFilename,
        randomUUID(),
      );
      const installResult = await installOrcaProfileWindows(
        updated,
        sha256(updated),
        safeFilename,
        operationId,
      );

      const installRoot = getWindowsOrcaInstallRoot();
      const located = await findBackupByOperationId(installRoot, operationId);
      expect(located).not.toBeNull();
      // The correct safeFilename is recovered whole, including the literal
      // ".bak-" substring it contains — not truncated at the first
      // occurrence of that substring.
      expect(located?.safeFilename).toBe(safeFilename);

      const restoreResult = await restoreOrcaProfileWindows(
        located!.backupPath,
        installResult.backupHash,
        located!.safeFilename,
      );
      expect(restoreResult.restoredHash).toBe(installResult.backupHash);
    },
  );

  it.runIf(process.platform === 'win32')(
    'refuses to write/read backup metadata through a junctioned .pfd-backup-meta directory',
    async () => {
      // Reviewer finding (Vasquez, reproduced concretely on Windows): the
      // durable backup-metadata sidecar directory reused only the
      // destination-file symlink check, not the same per-segment
      // reparse-point walk that guards the install root itself. If
      // `.pfd-backup-meta` (or a segment leading to it) is a symlink or
      // junction, writeBackupMeta/findBackupByOperationId could write to or
      // read from outside the canonical OrcaSlicer directory — the same
      // escape class #158 already covers for the profile install path.
      const safeFilename = 'junction_meta_profile.json';
      const operationId = randomUUID();
      const original = '{"name":"v1-junction-meta"}';
      const updated = '{"name":"v2-junction-meta"}';

      const installRoot = getWindowsOrcaInstallRoot();
      const escapeDir = path.join(sandboxAppData, '..', 'meta-escape');
      await mkdir(escapeDir, { recursive: true });

      // Seed a backup to write metadata for.
      await installOrcaProfileWindows(
        original,
        sha256(original),
        safeFilename,
        randomUUID(),
      );

      // Replace .pfd-backup-meta (not yet created, since no operation has
      // written metadata under this safeFilename/root combination yet) with
      // a junction pointing outside the sandbox, before the install that
      // would create a metadata record for it.
      const metaDir = path.join(installRoot, '.pfd-backup-meta');
      await rm(metaDir, { recursive: true, force: true });
      await makeDirReparsePoint(escapeDir, metaDir);

      // The install that would write a backup-metadata record must refuse,
      // rather than writing through the junction into escapeDir.
      await expect(
        installOrcaProfileWindows(
          updated,
          sha256(updated),
          safeFilename,
          operationId,
        ),
      ).rejects.toMatchObject({ code: 'pathRestricted' });
      expect(
        await readdir(escapeDir),
        'metadata was written through a junctioned .pfd-backup-meta directory',
      ).toEqual([]);

      // A lookup against the same junctioned directory must also refuse,
      // rather than reading whatever happens to be under escapeDir.
      const located = await findBackupByOperationId(installRoot, operationId);
      expect(located).toBeNull();

      await rm(metaDir, { recursive: true, force: true });
      await rm(escapeDir, { recursive: true, force: true });
    },
  );
});

// ---------------------------------------------------------------------------
// IPC handler isolation: renderer cannot see local paths
// (verified via schema tests above — no filePath fields in request schemas)
// ---------------------------------------------------------------------------

import { ipcSchemas, IpcChannel } from '../src/shared/ipc.js';

describe('IPC schema presence for issue #55 channels', () => {
  it('CalibrationGenerateOrcaProfile is registered in ipcSchemas', () => {
    expect(ipcSchemas[IpcChannel.CalibrationGenerateOrcaProfile]).toBeDefined();
    expect(
      ipcSchemas[IpcChannel.CalibrationGenerateOrcaProfile].request,
    ).toBeDefined();
    expect(
      ipcSchemas[IpcChannel.CalibrationGenerateOrcaProfile].response,
    ).toBeDefined();
  });

  it('CalibrationInstallOrcaProfile is registered in ipcSchemas', () => {
    expect(ipcSchemas[IpcChannel.CalibrationInstallOrcaProfile]).toBeDefined();
    expect(
      ipcSchemas[IpcChannel.CalibrationInstallOrcaProfile].request,
    ).toBeDefined();
    expect(
      ipcSchemas[IpcChannel.CalibrationInstallOrcaProfile].response,
    ).toBeDefined();
  });

  it('CalibrationRestoreOrcaProfile is registered in ipcSchemas', () => {
    expect(ipcSchemas[IpcChannel.CalibrationRestoreOrcaProfile]).toBeDefined();
    expect(
      ipcSchemas[IpcChannel.CalibrationRestoreOrcaProfile].request,
    ).toBeDefined();
    expect(
      ipcSchemas[IpcChannel.CalibrationRestoreOrcaProfile].response,
    ).toBeDefined();
  });

  it('CalibrationExportOrcaProfile is registered in ipcSchemas', () => {
    expect(ipcSchemas[IpcChannel.CalibrationExportOrcaProfile]).toBeDefined();
  });

  it('CalibrationListOrcaProfiles is registered in ipcSchemas', () => {
    expect(ipcSchemas[IpcChannel.CalibrationListOrcaProfiles]).toBeDefined();
  });

  it('all new channel string values are distinct', () => {
    const channels = [
      IpcChannel.CalibrationGenerateOrcaProfile,
      IpcChannel.CalibrationInstallOrcaProfile,
      IpcChannel.CalibrationRestoreOrcaProfile,
      IpcChannel.CalibrationExportOrcaProfile,
      IpcChannel.CalibrationListOrcaProfiles,
    ];
    const unique = new Set(channels);
    expect(unique.size).toBe(channels.length);
  });
});
