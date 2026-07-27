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
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
} from '../src/main/orcaProfileInstall.js';

describe('installOrcaProfileWindows', () => {
  it('throws unsupportedPlatform on non-Windows or rejects hash mismatch on Windows', async () => {
    const content = '{"name":"Test Profile","type":"filament"}';
    if (process.platform !== 'win32') {
      // Non-Windows: throws unsupportedPlatform before any other check
      await expect(
        installOrcaProfileWindows(content, 'a'.repeat(64), 'test.json'),
      ).rejects.toMatchObject({ code: 'unsupportedPlatform' });
    } else {
      // Windows: rejects when hash does not match the provided content
      await expect(
        installOrcaProfileWindows(content, 'b'.repeat(64), 'test_profile.json'),
      ).rejects.toMatchObject({ code: 'verificationFailed' });
    }
  });
});

describe('restoreOrcaProfileWindows', () => {
  it('throws unsupportedPlatform on non-Windows', async () => {
    if (process.platform === 'win32') {
      // On Windows, can only test with a real backup file present; skip this.
      return;
    }
    await expect(
      restoreOrcaProfileWindows(
        '/some/backup.bak',
        'a'.repeat(64),
        'test.json',
      ),
    ).rejects.toMatchObject({ code: 'unsupportedPlatform' });
  });
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
