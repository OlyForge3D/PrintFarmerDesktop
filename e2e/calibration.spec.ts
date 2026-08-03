/**
 * Calibration workspace Playwright E2E tests (D-07, A-02, S-04).
 *
 * Ported from PR #135 e2e/calibration.spec.ts, lines 1–1404.
 * Covers the IPC / preload boundary layer only (no DOM-coupled tests).
 *
 * Coverage areas:
 *   - Security boundary: openCalibrationManifestUrl IPC exists, window.open blocked
 *   - Preload bridge availability (A-02, S-01, S-04)
 *   - CalibrationApi does not expose generic URL primitives (S-04)
 *   - D-07: Generation + orchestration + queue + bed-clear IPC sequences
 *
 * API adaptations vs PR #135 (see docs/pr135-calibration-port.md for rationale):
 *   - openCalibrationExternalUrl({linkId}) → openCalibrationManifestUrl({url})
 *     Merged takes a full https:// URL validated by isManifestSourceUrl()
 *     rather than an opaque linkId resolved server-side. Tests pass manifest
 *     URLs and assert that non-manifest URLs are returned as {status:'error'}.
 *   - validateCalibrationLocalModel → validateCalibrationAssetFile
 *   - openCalibrationLocalModel → pickCalibrationAssetFile
 *   - CalibrationStartGenerationRequest: methodOptions field removed (strict schema
 *     uses `options?: CalibrationMethodOptions` instead).
 *   - CalibrationAcknowledgeBedClearRequest: jobEtag → rowVersion,
 *     dispatchStateEtag → dispatchStateRowVersion; response shape updated.
 *   - CalibrationOrchestrationStatus: `orchestrationId` field renamed to `id`;
 *     new nullable fields (workerId, sourceArtifactId, finalArtifactId,
 *     manifestSha256, slicerBinarySha256) required.
 *   - CalibrationQueueJobState: `jobStatus`/`jobEtag`/`bedClearExpiresAtUtc`
 *     renamed to `status`/`rowVersion`/`acknowledgementExpiresAt`; new nullable
 *     required fields (jobKind, dispatchAttemptOutcome, bedClearState,
 *     calibrationAttemptId) added.
 *
 * Tests NOT ported: lines 1405–2284 (D-07 DOM-coupled tests that reference
 * ~37 data-testid attributes absent from the merged implementation; adding
 * data-testid attributes to production components is out of scope).
 *
 * Fixture strategy:
 *   - beforeAll installs deterministic IPC fixture handlers ONLY for channels
 *     where no production behaviour is under test (serverProfiles:list,
 *     catalog:listModels, workspace-state seeding, photo operations).
 *   - calibration:startGeneration, calibration:getQueueState,
 *     calibration:getOrchestrationStatus, and calibration:acknowledgeBedClear
 *     are NOT overridden in beforeAll — the real production handlers remain
 *     active so request-schema rejection tests target the real Zod parse.
 *   - Acceptance tests for those channels install a local fixture inside the
 *     test itself via app.evaluate(), exercising the preload response.parse().
 *   - localStorage is seeded with a library source root so the onboarding modal
 *     does not block the Printer Calibration nav button
 *   - renderer is reloaded after handlers are installed so startup sees them
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const requiredArtifacts = [
  path.join(repoRoot, '.vite', 'build', 'main.js'),
  path.join(repoRoot, '.vite', 'build', 'preload.js'),
  path.join(repoRoot, '.vite', 'renderer', 'main_window', 'index.html'),
];

// ─── Fixture constants ────────────────────────────────────────────────────────
const F_NOW = '2026-07-29T10:00:00.000Z';
const F_EXPIRY = new Date(Date.now() + 300_000).toISOString();
const F_PROFILE_ID = 'f1111111-f111-4111-8111-111111111111';
const F_PROJECT_ID = 'f2222222-f222-4222-8222-222222222222';
const F_PRINTER_ID = 'f3333333-f333-4333-8333-333333333333';
const F_ATTEMPT_ID = 'f4444444-f444-4444-8444-444444444444';
const F_ORCH_ID = 'f5555555-f555-4555-8555-555555555555';
const F_JOB_ID = 'f6666666-f666-4666-8666-666666666666';
const F_FILAMENT_ID = 'f7777777-f777-4777-8777-777777777777';
const F_GCODE_ID = 'f8888888-f888-4888-8888-888888888888';
const F_OPER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const F_EVENT_ID_1 = 'e1111111-e111-4111-8111-111111111111';
const F_PHOTO_APPROVAL_ID = 'fb000000-fb00-4b00-8b00-bb0000000000';
const F_ORCA_PROFILE_ID = 'orca-e2e-base';
const F_SNAPSHOT_ID = 'snapshot-e2e-7';
const F_CONFIG_REV = 7;
const F_TOOL_ID = 'tool-e2e-a';
const F_TOOLHEAD_ID = 'head-e2e-a';
const F_NOZZLE_ID = 'nozzle-e2e-a';
const F_NOZZLE_DIM = 0.4;
const F_CONTENT_HASH = 'a'.repeat(64);
const F_PHOTO_HASH = 'b'.repeat(64);
const F_PHOTO_APPROVAL_ID_UNUSED = F_PHOTO_APPROVAL_ID;
const F_DISPLAY_NAME = 'E2E PLA Calibration';

/** Build the complete fixture workspace state record inline. */
function buildFixtureRecord(): Record<string, unknown> {
  const emptyStage = (id: string) => ({
    stageId: id,
    status: 'notStarted',
    attemptIds: [],
  });
  const emptyObservation = () => ({
    primary: '',
    quality: '',
    notes: '',
    passed: false,
    nominalXmm: '',
    nominalYmm: '',
    nominalZmm: '',
    measuredXmm: '',
    measuredYmm: '',
    measuredZmm: '',
  });
  const emptyDraft = () => ({
    method: null,
    observation: emptyObservation(),
    confidence: null,
    reason: '',
    photoAttemptId: null,
    photoCaption: '',
    photoOrder: 1,
  });
  const snapshot = {
    snapshotId: F_SNAPSHOT_ID,
    snapshotRevision: F_CONFIG_REV,
    capturedAt: F_NOW,
    configurationRevision: F_CONFIG_REV,
    toolheads: [
      {
        toolId: F_TOOL_ID,
        toolheadId: F_TOOLHEAD_ID,
        nozzle: {
          nozzleId: F_NOZZLE_ID,
          diameterMm: F_NOZZLE_DIM,
          material: 'brass',
        },
        extruderType: 'directDrive',
      },
    ],
    safety: {
      buildVolumeMm: { x: 250, y: 250, z: 250 },
      maximumNozzleTemperatureC: 300,
      maximumBedTemperatureC: 110,
      maximumVolumetricRateMm3S: 35,
      emergencyStopAvailable: true,
      thermalProtectionConfirmed: true,
      ventilationAssessed: true,
    },
  };
  const binding = {
    printer: {
      backendProfileId: F_PROFILE_ID,
      backendPrinterId: F_PRINTER_ID,
      printerConfigurationId: 'config-e2e-1',
      printerConfigurationRevision: F_CONFIG_REV,
    },
    snapshot,
    selectedToolId: F_TOOL_ID,
    selectedToolheadId: F_TOOLHEAD_ID,
    selectedNozzleId: F_NOZZLE_ID,
    filament: {
      filamentProjectId: F_FILAMENT_ID,
      provider: 'E2E Materials Co',
      product: 'E2E PLA Pro',
      sku: 'E2E-PLA',
      spoolId: 'spool-e2e-1',
    },
  };
  const domainState = {
    schemaVersion: 1,
    projectId: F_PROJECT_ID,
    createdAt: F_NOW,
    mode: 'expert',
    baseline: {
      nozzleTemperatureC: 220,
      flowRatio: 1.0,
      pressureAdvance: 0.03,
      retractionLengthMm: 0.6,
      maximumVolumetricRateMm3S: 12,
      shrinkageCompensationXPercent: 0,
      shrinkageCompensationYPercent: 0,
      shrinkageCompensationZPercent: 0,
    },
    binding,
    snapshotHistory: [snapshot],
    currentStageId: 'temperature',
    stages: {
      temperature: emptyStage('temperature'),
      flowPass1: emptyStage('flowPass1'),
      flowPass2: emptyStage('flowPass2'),
      pressureAdvance: emptyStage('pressureAdvance'),
      flowVerification: emptyStage('flowVerification'),
      retraction: emptyStage('retraction'),
      maximumVolumetricSpeed: emptyStage('maximumVolumetricSpeed'),
      shrinkage: emptyStage('shrinkage'),
      finalVerification: emptyStage('finalVerification'),
    },
    attempts: [],
    history: [],
    diagnostics: [],
  };
  const selectedBaseProfile = {
    orcaProfileId: F_ORCA_PROFILE_ID,
    displayName: 'E2E Base Profile',
    source: 'printFarmer',
    upstreamVerified: true,
    printerId: F_PRINTER_ID,
    configurationRevision: F_CONFIG_REV,
    snapshotId: F_SNAPSHOT_ID,
    toolId: F_TOOL_ID,
    toolheadId: F_TOOLHEAD_ID,
    nozzleId: F_NOZZLE_ID,
    nozzleDiameterMm: F_NOZZLE_DIM,
    profileRevision: 'rev-e2e-7',
    contentHash: F_CONTENT_HASH,
  };
  const workflowDrafts = {
    // temperature has method pre-selected so "Start generation" button is enabled
    temperature: {
      ...emptyDraft(),
      method: 'temperatureTower',
    },
    flowPass1: emptyDraft(),
    flowPass2: emptyDraft(),
    pressureAdvance: emptyDraft(),
    flowVerification: emptyDraft(),
    retraction: emptyDraft(),
    maximumVolumetricSpeed: emptyDraft(),
    shrinkage: emptyDraft(),
    finalVerification: emptyDraft(),
  };
  return {
    profileId: F_PROFILE_ID,
    projectId: F_PROJECT_ID,
    displayName: F_DISPLAY_NAME,
    description: 'E2E fixture workspace',
    printerId: F_PRINTER_ID,
    status: 'inProgress',
    completedStepCount: 0,
    totalStepCount: 9,
    isSynced: true,
    isPrinterContextFresh: true,
    hasConflicts: false,
    remoteProjectId: null,
    baseRevision: 1,
    createdAt: F_NOW,
    updatedAt: F_NOW,
    workspaceState: {
      schemaVersion: 1,
      domainState,
      metadata: {
        displayName: F_DISPLAY_NAME,
        description: 'E2E fixture workspace',
      },
      stepDrafts: {},
      workflowDrafts,
      photos: [],
      physicalMatch: {
        snapshotId: F_SNAPSHOT_ID,
        toolId: F_TOOL_ID,
        toolheadId: F_TOOLHEAD_ID,
        nozzleId: F_NOZZLE_ID,
        nozzleDiameterMm: F_NOZZLE_DIM,
        confirmedAt: F_NOW,
      },
      selectedBaseProfile,
      selectedBaseProfileId: F_ORCA_PROFILE_ID,
      autosaveRevision: 4,
      pendingGeneration: null,
    },
  };
}

/**
 * Builds a fixture record with an in-progress temperature attempt already
 * created. Kept for completeness; used by DOM-layer tests not ported here.
 */
function buildFixtureRecordWithAttempt(): Record<string, unknown> {
  const base = buildFixtureRecord();
  const ws = base['workspaceState'] as Record<string, unknown>;
  const ds = ws['domainState'] as Record<string, unknown>;
  const stages = ds['stages'] as Record<string, Record<string, unknown>>;
  const wds = ws['workflowDrafts'] as Record<string, unknown>;
  const emptyObs = {
    primary: '',
    quality: '',
    notes: '',
    passed: false,
    nominalXmm: '',
    nominalYmm: '',
    nominalZmm: '',
    measuredXmm: '',
    measuredYmm: '',
    measuredZmm: '',
  };
  return {
    ...base,
    workspaceState: {
      ...ws,
      domainState: {
        ...ds,
        stages: {
          ...stages,
          temperature: {
            stageId: 'temperature',
            status: 'inProgress',
            attemptIds: [F_ATTEMPT_ID],
          },
        },
        attempts: [
          {
            attemptId: F_ATTEMPT_ID,
            stageId: 'temperature',
            method: 'temperatureTower',
            scope: {
              backendProfileId: F_PROFILE_ID,
              backendPrinterId: F_PRINTER_ID,
              printerConfigurationId: 'config-e2e-1',
              printerConfigurationRevision: F_CONFIG_REV,
              snapshotId: F_SNAPSHOT_ID,
              snapshotRevision: F_CONFIG_REV,
              toolId: F_TOOL_ID,
              toolheadId: F_TOOLHEAD_ID,
              nozzleId: F_NOZZLE_ID,
              filamentProjectId: F_FILAMENT_ID,
              filamentProvider: 'E2E Materials Co',
              filamentProduct: 'E2E PLA Pro',
              filamentSku: 'E2E-PLA',
              spoolId: 'spool-e2e-1',
            },
            ordinal: 1,
            status: 'inProgress',
            startedAt: F_NOW,
            observations: [],
            diagnostics: [],
          },
        ],
        history: [
          {
            eventId: F_EVENT_ID_1,
            timestamp: F_NOW,
            type: 'beginAttempt',
            attemptId: F_ATTEMPT_ID,
            stageId: 'temperature',
            method: 'temperatureTower',
          },
        ],
      },
      workflowDrafts: {
        ...wds,
        temperature: {
          method: 'temperatureTower',
          observation: emptyObs,
          confidence: null,
          reason: '',
          photoAttemptId: F_ATTEMPT_ID,
          photoCaption: '',
          photoOrder: 1,
        },
      },
    },
  };
}

// Suppress unused-variable warning; exported for potential DOM-test reuse.
void buildFixtureRecordWithAttempt;
void F_PHOTO_APPROVAL_ID_UNUSED;
void F_PHOTO_HASH;

let app: ElectronApplication;
let page: Page;
let e2eStateRoot: string;

test.beforeAll(async () => {
  for (const artifact of requiredArtifacts) {
    if (!existsSync(artifact)) {
      throw new Error(
        `Missing build artifact ${artifact}.\n` +
          'Run `npm run test:e2e` (which builds first) before running calibration E2E.',
      );
    }
  }

  e2eStateRoot = mkdtempSync(path.join(repoRoot, '.pf-cal-e2e-'));
  const catalogDb = path.join(e2eStateRoot, 'catalog.sqlite3');
  const userDataPath = path.join(e2eStateRoot, 'user-data');
  mkdirSync(userDataPath, { recursive: true });

  app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      PRINTFARMER_CATALOG_DB: catalogDb,
      PRINTFARMER_USER_DATA_PATH: userDataPath,
    },
  });

  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // Build fixture data in Node context then pass to main process
  const fixtureRecord = buildFixtureRecord();

  const fixtureArgs = {
    profileId: F_PROFILE_ID,
    printerId: F_PRINTER_ID,
    orcaProfileId: F_ORCA_PROFILE_ID,
    snapshotId: F_SNAPSHOT_ID,
    configRev: F_CONFIG_REV,
    toolId: F_TOOL_ID,
    toolheadId: F_TOOLHEAD_ID,
    nozzleId: F_NOZZLE_ID,
    nozzleDim: F_NOZZLE_DIM,
    contentHash: F_CONTENT_HASH,
    photoHash: F_PHOTO_HASH,
    photoApprovalId: F_PHOTO_APPROVAL_ID,
    now: F_NOW,
    record: fixtureRecord,
  };

  // Install all fixture handlers in the main process with correct camelCase
  // channel names. Reload renderer so startup picks up the fresh handlers.
  await app.evaluate(
    (
      { ipcMain },
      {
        profileId,
        printerId,
        orcaProfileId,
        snapshotId,
        configRev,
        toolId,
        toolheadId,
        nozzleId,
        nozzleDim,
        contentHash,
        photoHash,
        photoApprovalId,
        now,
        record,
      },
    ) => {
      // Server profiles — provide a selected profile so calibration can load
      ipcMain.removeHandler('serverProfiles:list');
      ipcMain.handle('serverProfiles:list', () => ({
        profiles: [
          {
            id: profileId,
            displayName: 'E2E Test Server',
            baseUrl: 'http://localhost:8000',
            authMode: 'apiKey',
            version: {
              service: 'PrintFarmer',
              version: '2.0',
              commit: null,
              environment: 'test',
              runtime: 'node',
            },
            capabilities: {
              architecture: 'test',
              slicingEnabled: true,
              modelFilesEnabled: true,
              thumbnailGenerationEnabled: false,
              gcodeUploadEnabled: true,
              clientThumbnailUploadEnabled: false,
              idempotentModelUploadEnabled: true,
              modelThumbnailReplacementEnabled: false,
            },
            availability: {
              modelUpload: { available: true, reason: null },
              librarySync: { available: true, reason: null },
              clientThumbnailUpload: { available: false, reason: null },
              serverThumbnailFallback: {
                available: false,
                reason: 'Not required',
              },
            },
            status: 'connected',
            lastCheckedAt: now,
            warnings: [],
          },
        ],
        selectedProfileId: profileId,
      }));

      // Library models — return empty catalog (localStorage seeds the source root)
      ipcMain.removeHandler('catalog:listModels');
      ipcMain.handle('catalog:listModels', () => []);

      // Calibration availability — online and all capabilities enabled
      ipcMain.removeHandler('calibration:getAvailability');
      ipcMain.handle('calibration:getAvailability', () => ({
        available: true,
        unavailableReason: null,
        unavailableDetail: null,
        negotiatedApiVersion: '2',
        negotiatedSchemaVersion: '2.0',
        capabilityFlags: {
          calibrationApiEnabled: true,
          calibrationChangeFeedEnabled: true,
          calibrationOfflineDraftEnabled: true,
          calibrationPhotoUploadEnabled: true,
          calibrationGenerationEnabled: true,
        },
        grantedScopes: ['CalibrationRead', 'CalibrationWrite'],
        offlineEditingEnabled: true,
      }));

      // List workspace states — return the seeded fixture record
      ipcMain.removeHandler('calibration:listWorkspaceStates');
      ipcMain.handle('calibration:listWorkspaceStates', () => ({
        states: [record],
        unhydratedProjects: [],
      }));

      // Get workspace state — return seeded record when project is opened
      ipcMain.removeHandler('calibration:getWorkspaceState');
      ipcMain.handle('calibration:getWorkspaceState', () => record);

      // Save workspace state — return the seeded fixture record.
      ipcMain.removeHandler('calibration:saveWorkspaceState');
      ipcMain.handle('calibration:saveWorkspaceState', () => ({
        state: record,
        queued: true,
      }));

      // Printer context — valid, current, matches binding for G-02 validation
      ipcMain.removeHandler('calibration:getPrinterContext');
      ipcMain.handle('calibration:getPrinterContext', () => ({
        printerId,
        displayName: 'E2E Fixture Printer',
        printerModel: null,
        firmware: {
          firmware: 'Klipper',
          gcodeDialect: 'Klipper',
          firmwareVersion: '0.12',
          klipperConfigHash: null,
        },
        orcaProfileId,
        orcaProfileDisplayName: 'E2E Base Profile',
        bedWidthMm: 250,
        bedDepthMm: 250,
        nozzleDiameterMm: nozzleDim,
        snapshotAt: now,
        isCurrent: true,
        configurationId: 'config-e2e-1',
        configurationRevision: configRev,
        snapshotId,
        snapshotRevision: configRev,
        slicerIdentity: 'OrcaSlicer',
        slicerDistribution: 'upstream',
        profileRevision: 'rev-e2e-7',
        contentHash,
        toolheads: [
          {
            toolId,
            toolheadId,
            extruderType: 'directDrive',
            nozzle: { id: nozzleId, diameterMm: nozzleDim, material: 'brass' },
          },
        ],
        safety: {
          buildVolumeMm: { x: 250, y: 250, z: 250 },
          maximumNozzleTemperatureC: 300,
          maximumBedTemperatureC: 110,
          maximumVolumetricRateMm3S: 35,
          emergencyStopAvailable: true,
          thermalProtectionConfirmed: true,
          ventilationAssessed: true,
        },
        permissions: {
          readPrinter: true,
          writeCalibration: true,
          generateCalibration: true,
          startPrint: true,
        },
      }));

      // List Orca profiles — return the matching base profile
      ipcMain.removeHandler('calibration:listOrcaProfiles');
      ipcMain.handle('calibration:listOrcaProfiles', () => ({
        profiles: [
          {
            orcaProfileId,
            displayName: 'E2E Base Profile',
            vendor: null,
            material: null,
            source: 'printFarmer',
            upstreamVerified: true,
            printerId,
            configurationRevision: configRev,
            snapshotId,
            toolId,
            toolheadId,
            nozzleId,
            nozzleDiameterMm: nozzleDim,
            profileRevision: 'rev-e2e-7',
            contentHash,
            exportable: true,
          },
        ],
      }));

      // Note: calibration:startGeneration, calibration:getOrchestrationStatus,
      // calibration:getQueueState, and calibration:acknowledgeBedClear are NOT
      // overridden here.  Their real production handlers remain active so that
      // request-schema rejection tests can target the real Zod parse.
      // The acceptance tests for these channels install their own local fixtures.

      // Open calibration photo — returns approval ID (no OS path exposed)
      ipcMain.removeHandler('calibration:openPhoto');
      ipcMain.handle('calibration:openPhoto', () => ({
        approvalId: photoApprovalId,
      }));

      // Stage photo — echo request fields with fixture content hash
      ipcMain.removeHandler('calibration:stagePhoto');
      ipcMain.handle(
        'calibration:stagePhoto',
        (
          _ev: unknown,
          req: {
            photoId: string;
            attemptId: string;
            stageId: string;
            projectId: string;
            profileId: string;
            caption: string;
            order: number;
          },
        ) => ({
          photoId: req.photoId,
          attemptId: req.attemptId,
          stageId: req.stageId,
          projectId: req.projectId,
          profileId: req.profileId,
          contentHash: photoHash,
          mimeType: 'image/jpeg',
          byteSize: 12345,
          status: 'staged',
          uploadAttempts: 0,
          remotePhotoId: null,
          remoteUrl: null,
          stagedAt: now,
          uploadedAt: null,
          caption: req.caption,
          order: req.order,
        }),
      );
    },
    fixtureArgs,
  );

  // Seed localStorage with a library source root so the onboarding modal
  // does not block the Printer Calibration nav button on reload.
  await page.evaluate(() => {
    localStorage.setItem(
      'printfarmer.library.sourceRoots.v1',
      JSON.stringify({
        version: 1,
        roots: [
          {
            rootId: 'e2e-fixture-root-a',
            path: '/fixtures/e2e-models',
            approvalId: null,
            removed: false,
            lastReport: null,
            lastScannedAt: null,
          },
        ],
      }),
    );
  });

  // Reload so the renderer picks up the fixture handlers from startup.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  // Wait for the Printer Calibration nav button to be enabled. It becomes
  // enabled once the library source root prevents the onboarding modal.
  await expect(
    page.getByRole('button', { name: 'Printer Calibration' }),
  ).toBeEnabled({ timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.close();
  if (e2eStateRoot) {
    rmSync(e2eStateRoot, { recursive: true, force: true });
  }
});

// ─── Navigation helpers ───────────────────────────────────────────────────────
// Each helper navigates via Library first to ensure a fresh calibration
// workspace mount (resets generationState, queueJobState, activeProject).

async function navigateToCalibration(p: Page): Promise<void> {
  // Go via Library to force a fresh CalibrationWorkspaceStore mount.
  const libBtn = p.getByRole('button', { name: 'Library' });
  const isOnLib = (await libBtn.getAttribute('aria-current')) === 'page';
  if (!isOnLib) {
    await libBtn.click();
    await expect(libBtn).toHaveAttribute('aria-current', 'page', {
      timeout: 8_000,
    });
  }
  await p.getByRole('button', { name: 'Printer Calibration' }).click();
  await expect(
    p.getByRole('main', { name: 'Printer calibration workspace' }),
  ).toBeVisible({ timeout: 10_000 });
}

async function openFixtureProject(p: Page): Promise<void> {
  await navigateToCalibration(p);
  const projectBtn = p
    .getByRole('button', { name: new RegExp(F_DISPLAY_NAME) })
    .first();
  await expect(projectBtn).toBeVisible({ timeout: 12_000 });
  await projectBtn.click();
  await expect(p.getByRole('heading', { name: F_DISPLAY_NAME })).toBeVisible({
    timeout: 8_000,
  });
}

async function openTemperatureStage(p: Page): Promise<void> {
  await openFixtureProject(p);
  await p.getByRole('button', { name: /Open Temperature,/i }).click();
  await expect(p.getByRole('heading', { name: 'Temperature' })).toBeVisible({
    timeout: 8_000,
  });
}

// Suppress unused helper warning (openTemperatureStage is for DOM-layer tests)
void openTemperatureStage;

// ─── A-02 / S-01 / S-04: Allowlisted external navigation IPC ─────────────────

test('openCalibrationManifestUrl is present on the preload bridge (A-02, S-01)', async () => {
  // Adaptation: PR135 checked for openCalibrationExternalUrl (linkId-based).
  // Merged exposes openCalibrationManifestUrl(url) validated by isManifestSourceUrl().
  const fnType = await page.evaluate(
    () =>
      typeof (window as unknown as { printFarmer?: Record<string, unknown> })
        .printFarmer?.openCalibrationManifestUrl,
  );
  expect(fnType).toBe('function');
});

test('no generic openExternalUrl(url:string) primitive on printFarmer bridge (S-04)', async () => {
  const hasGeneric = await page.evaluate(
    () =>
      'openExternalUrl' in
      ((window as unknown as { printFarmer?: Record<string, unknown> })
        .printFarmer ?? {}),
  );
  // The generic url-string primitive must NOT be exposed on the bridge
  expect(hasGeneric).toBe(false);
});

test('renderer window.open is blocked by setWindowOpenHandler (S-04)', async () => {
  // Electron hardenWindow() installs setWindowOpenHandler that denies all
  // new windows; window.open() returns null in the renderer.
  const result = await page.evaluate(() => {
    const w = window.open('https://example.com', '_blank');
    return w === null;
  });
  expect(result).toBe(true);
});

test('openCalibrationManifestUrl rejects malformed URL via Zod schema (S-05)', async () => {
  // Adaptation: PR135 tested that an invalid linkId was rejected by the preload
  // schema. In merged, the schema validates `url` as z.string().url().max(2048).
  // Passing a non-URL string causes the main-process request.parse() to throw,
  // which propagates as an IPC error and surfaces as a thrown error in the renderer.
  const threw = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            openCalibrationManifestUrl: (r: unknown) => Promise<void>;
          };
        }
      ).printFarmer.openCalibrationManifestUrl({
        url: 'not-a-valid-url-at-all',
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(threw).toBe(true);
});

// ─── Basic app mount / preload bridge ─────────────────────────────────────────

test('calibration: preload bridge is an object with calibration IPC methods', async () => {
  // Adaptation: openCalibrationExternalUrl → openCalibrationManifestUrl,
  //             validateCalibrationLocalModel → validateCalibrationAssetFile,
  //             openCalibrationLocalModel → pickCalibrationAssetFile.
  const methods = await page.evaluate(() => {
    const api = (window as unknown as { printFarmer?: Record<string, unknown> })
      .printFarmer;
    if (!api) return [];
    return [
      'startCalibrationGeneration',
      'getCalibrationOrchestrationStatus',
      'getCalibrationQueueState',
      'acknowledgeCalibrationBedClear',
      'openCalibrationManifestUrl',
      'pickCalibrationAssetFile',
      'validateCalibrationAssetFile',
    ].filter((key) => typeof api[key] === 'function');
  });
  expect(methods).toContain('startCalibrationGeneration');
  expect(methods).toContain('getCalibrationQueueState');
  expect(methods).toContain('acknowledgeCalibrationBedClear');
  expect(methods).toContain('openCalibrationManifestUrl');
});

test('calibration: openCalibrationManifestUrl with manifest URL calls through to shell (A-02)', async () => {
  // Adaptation: PR135 used linkId:'calibration-source-releases' and expected a
  // Filament_Calibration_Wizard URL. Merged takes a full URL and validates it
  // against the shipped asset manifest via isManifestSourceUrl().
  // The manifest contains https://github.com/OlyForge3D/PrintFarmer — we use
  // that as the allowed URL and verify shell.openExternal is called with it.
  const MANIFEST_URL = 'https://github.com/OlyForge3D/PrintFarmer';

  // Stub shell.openExternal WITHOUT calling the original — no side effects in tests.
  await app.evaluate(({ shell }) => {
    (shell as { openExternal: (url: string) => Promise<void> }).openExternal = (
      url: string,
    ) => {
      process.env['PRINTFARMER_TEST_LAST_OPENED_URL'] = url;
      return Promise.resolve();
    };
  });

  const result = await page.evaluate(async (manifestUrl) => {
    try {
      const response = await (
        window as unknown as {
          printFarmer: {
            openCalibrationManifestUrl: (r: {
              url: string;
            }) => Promise<{ status: string }>;
          };
        }
      ).printFarmer.openCalibrationManifestUrl({ url: manifestUrl });
      return { ok: response.status === 'ok', status: response.status };
    } catch (e) {
      return {
        ok: false,
        status: 'threw',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }, MANIFEST_URL);

  expect(result.ok).toBe(true);

  const capturedUrl = await app.evaluate(
    () => process.env['PRINTFARMER_TEST_LAST_OPENED_URL'] ?? null,
  );
  expect(capturedUrl).toBe(MANIFEST_URL);
  expect(capturedUrl).toMatch(/^https:\/\//);
});

test('openCalibrationManifestUrl rejects URL not in manifest allowlist (A-02/S-04)', async () => {
  // Verifies isManifestSourceUrl() enforcement: a valid https:// URL that is
  // NOT listed as a sourceUrl in the shipped asset manifest must be returned
  // as {status:'error'}, never opened in the system browser.
  //
  // Mutation test target: replacing `isManifestSourceUrl` with `return true`
  // makes this test fail (the call returns {status:'ok'} and opens the URL).
  const result = await page.evaluate(async () => {
    const response = await (
      window as unknown as {
        printFarmer: {
          openCalibrationManifestUrl: (r: {
            url: string;
          }) => Promise<{ status: string }>;
        };
      }
    ).printFarmer.openCalibrationManifestUrl({
      url: 'https://attacker.example.com/evil-calibration-model.stl',
    });
    return response.status;
  });
  // Must be rejected — non-manifest URLs must never reach the system browser
  expect(result).toBe('error');
});

// ─── Calibration IPC — named channels reject bad input (S-01, S-05) ──────────
// These tests exercise the REAL production handler (no fixture override for the
// channel under test).  Each assertion checks the Zod error path string so that
// a mutation making the schema more permissive causes the assertion to fail.

test('calibration: getCalibrationQueueState rejects request with missing profileId (S-01)', async () => {
  // Sends a request with projectId but NO profileId.
  // Production handler: ipcSchemas[CalibrationGetQueueState].request.parse()
  // rejects because profileId is z.string().uuid() (required).
  // The Zod error message JSON contains "profileId" in the path.
  // Mutation target: CalibrationGetQueueStateRequest.profileId → optional
  const msg = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            getCalibrationQueueState: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.getCalibrationQueueState({
        projectId: '22222222-2222-4222-8222-222222222222',
        // profileId intentionally absent — Zod must reject
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(msg).not.toBeNull();
  // Zod path ["profileId"] serialises into the error message JSON
  expect(msg).toMatch(/profileId/);
});

test('calibration: acknowledgeCalibrationBedClear rejects request with invalid UUID in profileId (S-05)', async () => {
  // All fields are valid UUIDs/values EXCEPT profileId which is a plain string.
  // Production handler: request.parse() rejects because profileId is z.string().uuid().
  // Zod error message contains "uuid" (the validation keyword).
  // Mutation target: CalibrationAcknowledgeBedClearRequest.profileId → z.string()
  const msg = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            acknowledgeCalibrationBedClear: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.acknowledgeCalibrationBedClear({
        profileId: 'not-a-valid-uuid', // invalid — all other fields are valid UUIDs
        jobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        printerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        operationId: '44444444-4444-4444-8444-444444444444',
        rowVersion: 'W/"abc123"',
        dispatchStateRowVersion: 'W/"def456"',
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(msg).not.toBeNull();
  // Zod "Invalid uuid" message for profileId
  expect(msg).toMatch(/uuid/i);
});

// ─── Calibration IPC — no generic URL/shell primitive exposed (S-04) ─────────

test('calibration: getCalibrationOrchestrationStatus rejects request with missing profileId (S-04)', async () => {
  // Sends orchestrationId but NO profileId.
  // Production handler: request.parse() rejects because profileId is z.string().uuid().
  // Zod error message JSON contains "profileId" in the path.
  // Mutation target: CalibrationGetOrchestrationStatusRequest.profileId → optional
  const msg = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            getCalibrationOrchestrationStatus: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.getCalibrationOrchestrationStatus({
        orchestrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        // profileId intentionally missing
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(msg).not.toBeNull();
  // Zod path ["profileId"] serialises into the error message JSON
  expect(msg).toMatch(/profileId/);
});

// ─── IPC unhandled-rejection safety (S-03, S-05) ─────────────────────────────

test('calibration: renderer IPC rejection is surfaced as a thrown error, not an unhandled promise (S-05)', async () => {
  // Adaptation: PR135 used openCalibrationExternalUrl({linkId:'not-in-allowlist'})
  // which was rejected at the Zod schema level (throws). In merged,
  // openCalibrationManifestUrl({url:'not-a-url'}) is rejected by the main-process
  // z.string().url() validation and propagates as a thrown IPC error — same
  // observable behaviour: threw=true, unhandled=false.
  const result = await page.evaluate(async () => {
    let threw = false;
    let unhandled = false;
    const handler = () => {
      unhandled = true;
    };
    window.addEventListener('unhandledrejection', handler);
    try {
      await (
        window as unknown as {
          printFarmer: {
            openCalibrationManifestUrl: (r: unknown) => Promise<void>;
          };
        }
      ).printFarmer.openCalibrationManifestUrl({ url: 'not-a-url' });
    } catch {
      threw = true;
    }
    // Yield so that unhandled-rejection handlers can fire if applicable
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    window.removeEventListener('unhandledrejection', handler);
    return { threw, unhandled };
  });
  expect(result.threw).toBe(true);
  expect(result.unhandled).toBe(false);
});

// ─── Calibration workflow: preload response-schema tests (D-07) ──────────────
// These tests exercise ipcSchemas[channel].response.parse() in preload.ts —
// the real production code that validates every IPC response before returning
// it to the renderer.  Rejection tests send a bad request to the real production
// handler (no fixture override); acceptance tests install a local fixture that
// returns a valid deterministic response, proving the preload parses it.

// ─── D-07/G-04: startCalibrationGeneration ───────────────────────────────────

test('calibration: startCalibrationGeneration rejects request with invalid UUID in profileId (S-01/G-04)', async () => {
  // No fixture override — the real production handler validates the request first.
  // CalibrationStartGenerationRequest.profileId is z.string().uuid() (required).
  // Zod error message JSON contains "profileId" in the path.
  // Mutation target: CalibrationStartGenerationRequest.profileId → z.any()
  //   → Zod accepts, requireSelectedCalibrationProfile throws "does not match"
  //   → error message no longer contains "profileId" → test fails.
  const msg = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            startCalibrationGeneration: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.startCalibrationGeneration({
        profileId: 'not-a-valid-uuid',
        projectId: '22222222-2222-4222-8222-222222222222',
        attemptId: '33333333-3333-4333-8333-333333333333',
        operationId: '44444444-4444-4444-8444-444444444444',
        method: 'temperatureTower',
        definitionVersion: '1',
        baseRevision: null,
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(msg).not.toBeNull();
  expect(msg).toMatch(/profileId/i);
});

test('calibration: startCalibrationGeneration preload response schema parses valid submitted response (G-04)', async () => {
  // Install a local fixture that returns a valid CalibrationStartGenerationResponse.
  // The real production handler was NOT overridden in beforeAll; this fixture is
  // local to this test and stays installed for the remainder of the run.
  // Mutation target: CalibrationStartGenerationResponse.orchestrationId → z.string().min(100)
  //   → preload response.parse() rejects the short UUID → threw = true → test fails.
  await app.evaluate(({ ipcMain }, orchId) => {
    ipcMain.removeHandler('calibration:startGeneration');
    ipcMain.handle('calibration:startGeneration', () => ({
      status: 'submitted',
      orchestrationId: orchId,
    }));
  }, F_ORCH_ID);

  const threw = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            startCalibrationGeneration: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.startCalibrationGeneration({
        profileId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
        attemptId: '33333333-3333-4333-8333-333333333333',
        operationId: '44444444-4444-4444-8444-444444444444',
        method: 'temperatureTower',
        definitionVersion: '1',
        baseRevision: null,
      });
      return false;
    } catch {
      return true;
    }
  });
  // Fixture response must be accepted by the production preload response schema
  expect(threw).toBe(false);
});

// ─── D-07/G-06: getCalibrationOrchestrationStatus response schema ─────────────

test('calibration: getCalibrationOrchestrationStatus preload response schema parses valid fixture response (D-07/G-06)', async () => {
  // Install a temporary fixture so the preload's response.parse() is exercised
  // against a valid CalibrationGetOrchestrationStatusResponse.
  // The real production handler was NOT overridden in beforeAll; this fixture is
  // local to this test.
  // Mutation target: CalibrationOrchestrationStatus.id → z.string().min(100)
  await app.evaluate(
    ({ ipcMain }, { orchId, projectId, attemptId, operId, now }) => {
      ipcMain.removeHandler('calibration:getOrchestrationStatus');
      ipcMain.handle('calibration:getOrchestrationStatus', () => ({
        status: 'ok',
        orchestration: {
          id: orchId,
          projectId,
          attemptId,
          operationId: operId,
          status: 'Running',
          currentStep: 'SlicingQueued',
          revision: 1,
          retryCount: 0,
          nextRetryAtUtc: null,
          stepStartedAtUtc: now,
          lastErrorCode: null,
          problems: [],
          model3DId: null,
          sliceJobId: null,
          workerId: null,
          sourceArtifactId: null,
          finalArtifactId: null,
          gcodeFileId: null,
          specificationSha256: null,
          planManifestSha256: null,
          gcodeSha256: null,
          manifestSha256: null,
          generatorVersion: 'e2e-gen-1.0',
          slicerContainerDigest: null,
          slicerBinarySha256: null,
          statusRoute: `/api/calibration-orchestrations/${orchId}`,
          createdAtUtc: now,
          updatedAtUtc: now,
          completedAtUtc: null,
        },
      }));
    },
    {
      orchId: F_ORCH_ID,
      projectId: F_PROJECT_ID,
      attemptId: F_ATTEMPT_ID,
      operId: F_OPER_ID,
      now: F_NOW,
    },
  );

  const threw = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            getCalibrationOrchestrationStatus: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.getCalibrationOrchestrationStatus({
        profileId: '11111111-1111-4111-8111-111111111111',
        orchestrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(threw).toBe(false);
});

// ─── D-07/Q-01: getCalibrationQueueState response schema ──────────────────────

test('calibration: getCalibrationQueueState preload response schema parses valid fixture response (D-07/Q-01)', async () => {
  // Mutation target: CalibrationQueueJobState.jobId → z.string().min(100)
  await app.evaluate(
    (
      { ipcMain },
      {
        jobId,
        gcodeId,
        printerId,
        projectId,
        attemptId,
        configRev,
        expiry,
        now,
      },
    ) => {
      ipcMain.removeHandler('calibration:getQueueState');
      ipcMain.handle('calibration:getQueueState', () => ({
        status: 'ok',
        job: {
          jobId,
          jobKind: 'FilamentCalibration',
          rowVersion: 'W/"fixture-etag"',
          dispatchStateRowVersion: 'W/"fixture-dispatch"',
          status: 'Assigned',
          dispatchAttemptOutcome: null,
          bedClearState: 'None',
          gcodeFileId: gcodeId,
          assignedPrinterId: printerId,
          assignedPrinterName: 'Fixture Printer A',
          acknowledgementExpiresAt: expiry,
          calibrationProjectId: projectId,
          calibrationAttemptId: attemptId,
          pinnedPrinterConfigRevision: configRev,
          priority: 50,
          queuePosition: 1,
          updatedAt: now,
        },
      }));
    },
    {
      jobId: F_JOB_ID,
      gcodeId: F_GCODE_ID,
      printerId: F_PRINTER_ID,
      projectId: F_PROJECT_ID,
      attemptId: F_ATTEMPT_ID,
      configRev: F_CONFIG_REV,
      expiry: F_EXPIRY,
      now: F_NOW,
    },
  );

  const threw = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            getCalibrationQueueState: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.getCalibrationQueueState({
        profileId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
        jobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(threw).toBe(false);
});

// ─── D-07/B-02: acknowledgeCalibrationBedClear ────────────────────────────────

test('calibration: acknowledgeCalibrationBedClear rejects request with missing rowVersion field (D-07/B-02)', async () => {
  // All required fields present except rowVersion.
  // Production handler: request.parse() rejects because rowVersion is
  //   z.string().min(1).max(256) (required).
  // Zod error message JSON contains "rowVersion" in the path.
  // Mutation target: CalibrationAcknowledgeBedClearRequest.rowVersion → optional
  const msg = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            acknowledgeCalibrationBedClear: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.acknowledgeCalibrationBedClear({
        profileId: '11111111-1111-4111-8111-111111111111',
        jobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        printerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        operationId: '44444444-4444-4444-8444-444444444444',
        // rowVersion intentionally absent
        dispatchStateRowVersion: 'W/"def456"',
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(msg).not.toBeNull();
  // Zod path ["rowVersion"] serialises into the error message JSON
  expect(msg).toMatch(/rowVersion/i);
});

test('calibration: acknowledgeCalibrationBedClear preload response schema parses valid fixture response (D-07/B-02)', async () => {
  // Mutation target: CalibrationAcknowledgeBedClearResponse status literal
  //   'ok' → 'accepted' — discriminatedUnion fails to match fixture's 'ok'
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('calibration:acknowledgeBedClear');
    ipcMain.handle('calibration:acknowledgeBedClear', () => ({
      status: 'ok',
      jobRowVersion: null,
      dispatchStateRowVersion: null,
    }));
  });

  const threw = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            acknowledgeCalibrationBedClear: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.acknowledgeCalibrationBedClear({
        profileId: '11111111-1111-4111-8111-111111111111',
        jobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        printerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        operationId: '44444444-4444-4444-8444-444444444444',
        rowVersion: 'W/"abc123"',
        dispatchStateRowVersion: 'W/"def456"',
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(threw).toBe(false);
});
