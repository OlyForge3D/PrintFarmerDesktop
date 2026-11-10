/**
 * Deterministic filament-calibration fixtures for the packaged-bundle
 * accessibility and journey specs.
 *
 * The packaged binary ships with `RunAsNode: false` (see `forge.config.ts`), so
 * Playwright's Electron launcher cannot drive it and the CDP attach used by
 * `helpers/packagedApp.ts` exposes no main process. Without `ipcMain` there is
 * no way to make a recovery state genuinely enter, and a recovery assertion
 * that cannot enter its state is an assertion that cannot fail. These helpers
 * therefore drive the production `.vite` bundles — the same renderer bundle
 * that is packaged — with fixture handlers installed in the main process, the
 * pattern already proven in `e2e/calibration.spec.ts`.
 *
 * Every scenario is applied to a single long-lived Electron app by replacing
 * the handlers and reloading the renderer, so the workspace store remounts and
 * observes the scenario from startup.
 *
 * **Post-#756 scope.** The printer-calibration saga was reaped in #756. Under
 * Path D the calibration workspace is a filament-spool wizard behind a
 * dashboard with a single primary CTA. The helpers below stub only the IPC
 * channels the filament dashboard + wizard actually consume:
 * `serverProfiles:list`, `catalog:listModels`, `calibration:getAvailability`,
 * `calibration:listPrinters`, and the wizard state read (empty). Saga
 * workspace-state, printer-context, orca-profile-list, workspace-save,
 * and generation/queue/orchestration/bed-clear stubs were removed with the
 * subjects they targeted.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Result } from 'axe-core';
import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  CalibrationConflict,
  CalibrationUnavailableReason,
  IpcSchemas,
  ServerProfile,
  UploadJob,
} from '@shared/ipc';
import type { z } from 'zod';

/**
 * Channels this fixture is allowed to stub, and the response each one owes.
 *
 * Derived from the live `ipcSchemas` registry rather than restated here, so a
 * channel whose contract changes cannot leave a stub behind that still
 * compiles. The previous signature took `channel: string` and returned
 * `unknown`, which meant the compiler checked no response shape at all: a stub
 * could return `{}` for every channel and typecheck stayed green while every
 * surface under test rendered its error state. That is the failure this
 * annotation exists to make impossible, and it is not hypothetical -- it is
 * how a fixture regression reached trunk.
 */
type StubbedChannel = keyof IpcSchemas;
type StubResponse<C extends StubbedChannel> = z.infer<
  IpcSchemas[C]['response']
>;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const requiredArtifacts = [
  path.join(repoRoot, '.vite', 'build', 'main.js'),
  path.join(repoRoot, '.vite', 'build', 'preload.js'),
  path.join(repoRoot, '.vite', 'renderer', 'main_window', 'index.html'),
];

export const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
];
const MATERIAL_IMPACTS = new Set(['moderate', 'serious', 'critical']);

export const CAL = {
  altProfileId: 'f1111111-1111-4111-8111-111111111112',
  draftProfileId: 'f1111111-1111-4111-8111-111111111113',
  now: '2026-07-29T10:00:00.000Z',
  profileId: 'f1111111-f111-4111-8111-111111111111',
  printerId: 'f3333333-f333-4333-8333-333333333333',
  altPrinterId: 'f3333333-f333-4333-8333-333333333334',
  printerModelId: 'a2222222-a222-4222-8222-222222222222',
  cloneId: 'f4444444-f444-4444-8444-444444444444',
  calibrationProjectId: 'f5555555-f555-4555-8555-555555555555',
  sliceJobId: 'a6666666-a666-4666-8666-666666666666',
  displayName: 'A11y Fixture Printer',
  altDisplayName: 'A11y Fixture Printer B',
} as const;

export type AvailabilityScenario = 'ok' | CalibrationUnavailableReason;

export type PrinterListScenario = 'populated' | 'empty';

export interface CalibrationScenario {
  /** Availability request rejects, which is the store's offline signal. */
  readonly offline?: boolean;
  readonly noProfile?: boolean;
  readonly serverProfileCount?: 0 | 1 | 2;
  readonly serverProfileMode?: 'modern' | 'legacy' | 'error' | 'insecureHttp';
  readonly serverProfileTestResult?: 'modern' | 'legacy';
  readonly serverProfileActionDelayMs?: number;
  readonly serverProfileActionFailure?:
    'list' | 'test' | 'save' | 'select' | 'delete';
  readonly libraryError?: string;
  readonly libraryErrorOnce?: string;
  readonly libraryQueryDelayMs?: number;
  readonly importCancellationFixture?: 'picker-cancel' | 'review-cancel';
  readonly importAmbiguityFixture?: boolean;
  readonly availableReleaseFixture?: 'beta';
  readonly sourceScanDelayMs?: number;
  readonly sourceScanFailureOnce?: string;
  readonly inspectorErrorFixture?: boolean;
  readonly organizationListDelayMs?: number;
  readonly organizationListFailure?: 'once' | 'always';
  readonly organizationListFixture?: 'large';
  readonly organizationCreateDelayMs?: number;
  readonly organizationCreateFailure?: boolean;
  readonly thumbnailCacheEntryCount?: number;
  readonly thumbnailCacheSaveResult?: 'success' | 'unwritable';
  readonly thumbnailCacheLoadFailure?: boolean;
  readonly thumbnailCacheLoadPending?: boolean;
  readonly organizationReviewFixture?: boolean;
  readonly uploadJobs?: UploadJob[];
  readonly uploadActionDelayMs?: number;
  readonly uploadActionDelayAction?:
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'retry'
    | 'confirmLegacyRetry'
    | 'remove'
    | 'reset';
  readonly uploadActionFailure?:
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'retry'
    | 'confirmLegacyRetry'
    | 'remove'
    | 'reset';
  readonly availability?: AvailabilityScenario;
  /** Seed the system machine/process/filament catalog for profile selection. */
  readonly profileCatalog?: boolean;
  readonly profileCatalogAdminNotice?: boolean;
  /** Seed a synthetic conflict-list state for the dashboard dialog. */
  readonly conflictList?: 'populated' | 'empty' | 'error' | 'loading';
  /** Seed the renderer with a malformed local payload summary. */
  readonly conflictPayload?: 'malformed' | 'tooManyFields' | 'noResolutions';
  /** Resolution responses are always local fixture data; never a live service. */
  readonly conflictResolution?: 'pending' | 'error' | 'resolved';
  /** Seed guidance/progress for all eight methods so each can be selected. */
  readonly methodVariants?: boolean;
  readonly methodProgressFailureOnce?: boolean;
  readonly cloneRequestPending?: boolean;
  readonly sendRequestPending?: boolean;
  readonly measurementWritePending?: boolean;
  readonly completionFailure?: boolean;
  /** Hold a mocked slice submission open to expose its transient busy state. */
  readonly sliceSubmissionPending?: boolean;
  /** Restore a synthetic persisted wizard at a stable resumable phase. */
  readonly restoreWizardPhase?:
    'methodPicker' | 'pollingSlice' | 'sliceReady' | 'awaitingMeasurement';
  /**
   * `populated` seeds two printers so the wizard's Step 1 picker renders
   * options and the ProfileSelectionSection can mount. `empty` returns no
   * printers so the "No PrintFarmer printers are available" hint renders —
   * this is the negative discriminator for the printer-list contract that
   * used to be enforced by the retired candidate endpoint.
   */
  readonly printerList?: PrinterListScenario;
}

interface FixtureArgs {
  readonly scenario: CalibrationScenario;
  readonly ids: typeof CAL;
}

export async function launchCalibrationApp(): Promise<{
  app: ElectronApplication;
  page: Page;
  stateRoot: string;
}> {
  for (const artifact of requiredArtifacts) {
    if (!existsSync(artifact)) {
      throw new Error(
        `Missing build artifact ${artifact}.\n` +
          'Run `npm run test:e2e` (which builds first) before the accessibility suite.',
      );
    }
  }
  // Kept out of the repository tree: a locked SQLite handle on Windows can
  // defeat cleanup, and a stray state directory must never look like a change.
  const stateRoot = mkdtempSync(path.join(tmpdir(), 'pf-cal-a11y-'));
  const userDataPath = path.join(stateRoot, 'user-data');
  mkdirSync(userDataPath, { recursive: true });
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      PRINTFARMER_CATALOG_DB: path.join(stateRoot, 'catalog.sqlite3'),
      PRINTFARMER_USER_DATA_PATH: userDataPath,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, stateRoot };
}

export async function getCalibrationFixtureCallCount(
  app: ElectronApplication,
  channel: keyof IpcSchemas,
): Promise<number> {
  return app.evaluate(({ ipcMain }, targetChannel) => {
    const counts = Reflect.get(ipcMain, '__pfA11yFixtureCallCounts') as
      Map<string, number> | undefined;
    if (!(counts instanceof Map)) {
      throw new Error('Calibration fixture call counters are not installed.');
    }
    return counts.get(targetChannel) ?? 0;
  }, channel);
}

/**
 * Installs the fixture handlers for one scenario and reloads the renderer so
 * the calibration store observes the scenario from its first request.
 */
export async function applyCalibrationScenario(
  app: ElectronApplication,
  page: Page,
  scenario: CalibrationScenario,
): Promise<void> {
  const args: FixtureArgs = { scenario, ids: CAL };

  await app.evaluate(({ ipcMain }, { scenario, ids }) => {
    const handle = <C extends StubbedChannel>(
      channel: C,
      handler: (...a: never[]) => StubResponse<C> | Promise<StubResponse<C>>,
    ) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler as never);
    };
    const fixtureCallCounts = new Map<string, number>();
    Reflect.set(ipcMain, '__pfA11yFixtureCallCounts', fixtureCallCounts);
    const recordFixtureCall = (channel: StubbedChannel): void => {
      fixtureCallCounts.set(channel, (fixtureCallCounts.get(channel) ?? 0) + 1);
    };

    const makeServerProfile = (
      id: string,
      displayName: string,
      mode = scenario.serverProfileMode ?? 'modern',
    ): ServerProfile => ({
      id,
      displayName,
      baseUrl:
        mode === 'insecureHttp'
          ? 'http://localhost:8000'
          : 'https://localhost:8000',
      authMode: 'apiKey' as const,
      version:
        mode === 'legacy'
          ? null
          : {
              service: 'PrintFarmer',
              version: '2.0',
              commit: null,
              environment: 'test',
              runtime: 'node',
              timestamp: ids.now,
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
        platformNote: null,
      },
      availability: {
        modelUpload: { mode: 'modern', available: true, reason: null },
        librarySync: { available: true, reason: null },
        clientThumbnailUpload: {
          available: false,
          reason: null,
        },
        serverThumbnailFallback: {
          available: false,
          reason: 'Not required',
        },
      },
      status:
        mode === 'legacy' ? 'legacy' : mode === 'error' ? 'error' : 'connected',
      lastCheckedAt: ids.now,
      warnings:
        mode === 'insecureHttp'
          ? ['insecureHttp']
          : mode === 'legacy'
            ? ['legacy']
            : [],
    });
    const profileIds = [ids.profileId, ids.altProfileId, ids.draftProfileId];
    const initialProfileCount =
      scenario.serverProfileCount ?? (scenario.noProfile ? 0 : 1);
    const serverProfiles = Array.from({ length: initialProfileCount }, (_, i) =>
      makeServerProfile(
        profileIds[i]!,
        i === 0 ? 'A11y Test Server' : 'A11y Backup Server',
      ),
    );
    let selectedProfileId: string | null =
      scenario.noProfile || initialProfileCount === 0 ? null : ids.profileId;
    let testedProfile: ServerProfile | null = null;
    const beforeServerProfileAction = async (action: string): Promise<void> => {
      if (scenario.serverProfileActionDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, scenario.serverProfileActionDelayMs),
        );
      }
      if (scenario.serverProfileActionFailure === action) {
        throw new Error(`Synthetic server profile ${action} failure.`);
      }
    };
    const currentProfileList = () => ({
      profiles: serverProfiles,
      selectedProfileId,
    });
    handle('serverProfiles:list', () => {
      if (scenario.serverProfileActionFailure === 'list') {
        throw new Error('Synthetic server profile list failure.');
      }
      return currentProfileList();
    });
    handle('serverProfiles:test', async () => {
      await beforeServerProfileAction('test');
      const result = makeServerProfile(
        ids.draftProfileId,
        'Synthetic Draft Server',
        scenario.serverProfileTestResult === 'legacy'
          ? 'legacy'
          : scenario.serverProfileMode,
      );
      testedProfile = result;
      return result;
    });
    handle('serverProfiles:save', async () => {
      await beforeServerProfileAction('save');
      const savedProfile =
        testedProfile ??
        makeServerProfile(ids.draftProfileId, 'Synthetic Draft Server');
      serverProfiles.push(savedProfile);
      selectedProfileId = savedProfile.id;
      return savedProfile;
    });
    handle('serverProfiles:select', async () => {
      await beforeServerProfileAction('select');
      const profile = serverProfiles[serverProfiles.length - 1];
      if (!profile) throw new Error('No synthetic server profile to select.');
      selectedProfileId = profile.id;
      return profile;
    });
    handle('serverProfiles:delete', async () => {
      await beforeServerProfileAction('delete');
      const removed = serverProfiles.pop();
      if (removed?.id === selectedProfileId) selectedProfileId = null;
      return currentProfileList();
    });

    handle('catalog:listModels', () => []);
    if (scenario.importCancellationFixture === 'picker-cancel') {
      handle('dialog:openFolder', () => null);
      handle('catalog:previewImport', () => {
        throw new Error('Unexpected import preview after picker cancellation.');
      });
      handle('catalog:importRoot', () => {
        throw new Error('Unexpected import after picker cancellation.');
      });
    } else if (scenario.importCancellationFixture === 'review-cancel') {
      handle('dialog:openFolder', () => ({
        path: 'C:\\SyntheticPrintFarmer\\import-source',
        approvalId: 'f7777777-7777-4777-8777-777777777777',
      }));
      handle('catalog:previewImport', () => ({
        modelCount: 1,
        totalBytes: 1024,
        skippedErrors: 0,
        complete: true,
        formats: { stl: 1, threeMf: 0, obj: 0 },
        folders: [],
        foldersTruncated: false,
        organization: {
          affectedModels: 1,
          newCollections: ['import-source'],
          reusedCollections: [],
          newTags: [],
          reusedTags: [],
          unmatchedModels: 0,
          samples: [],
          errors: [],
        },
      }));
      handle('catalog:importRoot', () => {
        throw new Error('Unexpected import after review cancellation.');
      });
    }
    if (scenario.importAmbiguityFixture === true) {
      handle('dialog:openFolder', () => ({
        path: 'C:\\SyntheticPrintFarmer\\import-source',
        approvalId: 'f7777777-7777-4777-8777-777777777777',
      }));
      handle('catalog:previewImport', () => ({
        modelCount: 2,
        totalBytes: 2048,
        skippedErrors: 0,
        complete: true,
        formats: { stl: 2, threeMf: 0, obj: 0 },
        folders: [
          { relativePath: 'Animals', name: 'Animals', depth: 1, modelCount: 2 },
        ],
        foldersTruncated: false,
        organization: {
          affectedModels: 2,
          newCollections: ['import-source'],
          reusedCollections: ['Animals'],
          newTags: [],
          reusedTags: [],
          unmatchedModels: 0,
          samples: [],
          errors: [],
        },
      }));
      handle('catalog:listCollections', () => [
        {
          id: 'synthetic-animals-one',
          name: 'Animals',
          sharedToFarm: false,
          memberCount: 1,
        },
        {
          id: 'synthetic-animals-two',
          name: 'Animals',
          sharedToFarm: true,
          memberCount: 2,
        },
      ]);
      handle('catalog:listTags', () => []);
      handle('catalog:importRoot', () => {
        throw new Error(
          'Unexpected import while collection target ambiguity is unresolved.',
        );
      });
    }
    if (scenario.inspectorErrorFixture === true) {
      handle('catalog:queryModels', () => ({
        models: [
          {
            hash: 'f'.repeat(64),
            format: 'threeMf',
            size: 1024,
            locations: [
              {
                rootId: 'metadata-error-root',
                path: '/fixtures/a11y-models/metadata-error.3mf',
                rootRelative: 'metadata-error.3mf',
                size: 1024,
                modifiedUnixSeconds: null,
                available: true,
              },
            ],
          },
        ],
        counts: {
          all: 1,
          favorites: 0,
          stl: 0,
          threeMf: 1,
          obj: 0,
          step: 0,
          duplicates: 0,
          missing: 0,
        },
        sources: [],
        filteredTotal: 1,
        page: 1,
        pageSize: 24,
      }));
      handle('catalog:tagsForModel', () => []);
      handle('catalog:collectionsForModel', () => {
        throw new Error('Synthetic model collection metadata failure.');
      });
      handle('model:extractVendorMetadata', () => {
        throw new Error('Synthetic slicer metadata failure.');
      });
      handle('model:renderThumbnail', () => {
        throw new Error('Synthetic thumbnail is unavailable.');
      });
    }
    if (scenario.availableReleaseFixture === 'beta') {
      handle('updates:getAvailableRelease', () => ({
        currentVersion: '0.1.0-beta.8',
        available: {
          version: '0.1.0-beta.9',
          prerelease: true,
          url: 'https://example.invalid/releases/v0.1.0-beta.9',
          publishedAt: null,
        },
      }));
    }
    const thumbnailCacheEntryCount = scenario.thumbnailCacheEntryCount;
    if (
      scenario.thumbnailCacheLoadFailure === true ||
      scenario.thumbnailCacheLoadPending === true
    ) {
      handle('thumbnailCache:getSettings', () => {
        if (scenario.thumbnailCacheLoadPending) {
          return new Promise<never>(() => {});
        }
        throw new Error('Synthetic cache settings load failure.');
      });
    }
    if (thumbnailCacheEntryCount !== undefined) {
      handle('thumbnailCache:getSettings', () => ({
        location: null,
        effectiveLocation: 'C:\\SyntheticPrintFarmer\\thumbnail-cache',
        maxBytes: 128 * 1024 * 1024,
        retentionDays: 30,
        usedBytes: thumbnailCacheEntryCount * 1024,
        entryCount: thumbnailCacheEntryCount,
        warning: null,
      }));
      if (scenario.thumbnailCacheSaveResult === undefined) {
        handle('thumbnailCache:setSettings', () => {
          throw new Error(
            'Unexpected cache settings write in visual coverage fixture.',
          );
        });
      } else {
        handle('thumbnailCache:setSettings', () => ({
          location: null,
          effectiveLocation: 'C:\\SyntheticPrintFarmer\\thumbnail-cache',
          maxBytes: 64 * 1024 * 1024,
          retentionDays: 14,
          usedBytes: thumbnailCacheEntryCount * 1024,
          entryCount: thumbnailCacheEntryCount,
          warning:
            scenario.thumbnailCacheSaveResult === 'unwritable'
              ? 'Thumbnail cache location is unavailable or not writable.'
              : null,
        }));
      }
    }
    if (
      scenario.organizationListDelayMs !== undefined ||
      scenario.organizationListFailure !== undefined ||
      scenario.organizationListFixture !== undefined ||
      scenario.organizationReviewFixture === true
    ) {
      let organizationListCalls = 0;
      handle('catalog:listOrganization', async () => {
        organizationListCalls += 1;
        if (scenario.organizationListDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, scenario.organizationListDelayMs),
          );
        }
        if (
          scenario.organizationListFailure === 'always' ||
          (scenario.organizationListFailure === 'once' &&
            organizationListCalls === 1)
        ) {
          throw new Error('Synthetic organization list failure.');
        }
        if (scenario.organizationListFixture === 'large') {
          return [
            {
              kind: 'collection' as const,
              id: 'synthetic-shared',
              name: 'Farm shared',
              modelCount: 0,
              synced: true,
              deleteScope: 'readOnly' as const,
            },
            ...Array.from({ length: 501 }, (_, index) => ({
              kind: 'collection' as const,
              id: `synthetic-local-${index + 1}`,
              name: `Synthetic local ${String(index + 1).padStart(3, '0')}`,
              modelCount: 0,
              synced: false,
              deleteScope: 'local' as const,
            })),
          ];
        }
        if (scenario.organizationReviewFixture === true) {
          return [
            {
              kind: 'collection' as const,
              id: 'synthetic-local-used',
              name: 'Local collection',
              modelCount: 3,
              synced: false,
              deleteScope: 'local' as const,
            },
            {
              kind: 'collection' as const,
              id: 'synthetic-sync-used',
              name: 'Synced collection',
              modelCount: 2,
              synced: true,
              deleteScope: 'sync' as const,
            },
            {
              kind: 'collection' as const,
              id: 'synthetic-readonly',
              name: 'Read-only shared collection',
              modelCount: 1,
              synced: true,
              deleteScope: 'readOnly' as const,
            },
          ];
        }
        return [];
      });
    }
    if (scenario.organizationReviewFixture === true) {
      const reviewEntries = [
        {
          kind: 'collection' as const,
          id: 'synthetic-local-used',
          name: 'Local collection',
          modelCount: 3,
          synced: false,
          deleteScope: 'local' as const,
        },
        {
          kind: 'collection' as const,
          id: 'synthetic-sync-used',
          name: 'Synced collection',
          modelCount: 2,
          synced: true,
          deleteScope: 'sync' as const,
        },
      ];
      handle('catalog:previewOrganizationDeletion', () => ({
        kind: 'collection',
        entries: reviewEntries,
        assignmentsRemoved: 5,
        serverDeletions: 1,
        fingerprint: 'a'.repeat(64),
      }));
      handle('catalog:applyOrganizationDeletion', () => {
        throw new Error(
          'Unexpected organization deletion in the rendered review fixture.',
        );
      });
    }
    if (scenario.organizationCreateFailure === true) {
      handle('catalog:createCollection', async () => {
        if (scenario.organizationCreateDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, scenario.organizationCreateDelayMs),
          );
        }
        throw new Error('Synthetic organization create failure.');
      });
    }
    if (scenario.uploadJobs !== undefined) {
      const uploadJobs = structuredClone(scenario.uploadJobs);
      const beforeUploadAction = async (action: string): Promise<void> => {
        if (
          scenario.uploadActionDelayMs &&
          (!scenario.uploadActionDelayAction ||
            scenario.uploadActionDelayAction === action)
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, scenario.uploadActionDelayMs),
          );
        }
        if (scenario.uploadActionFailure === action) {
          throw new Error(`Synthetic upload ${action} failure.`);
        }
      };
      const updateUploadSummary = (job: UploadJob): UploadJob => {
        const summary = {
          queued: 0,
          uploading: 0,
          succeeded: 0,
          failed: 0,
          cancelled: 0,
          uncertain: 0,
        };
        for (const item of job.items) summary[item.state] += 1;
        job.summary = summary;
        job.totalBytes = job.items.reduce(
          (total, item) => total + item.size,
          0,
        );
        job.bytesSent = job.items.reduce(
          (total, item) => total + item.bytesSent,
          0,
        );
        job.state =
          summary.queued + summary.uploading > 0
            ? job.paused
              ? 'paused'
              : 'running'
            : summary.uncertain > 0
              ? 'attention'
              : summary.failed > 0
                ? 'partialFailure'
                : summary.cancelled > 0 && summary.succeeded === 0
                  ? 'cancelled'
                  : 'completed';
        return job;
      };
      const firstUploadJob = (): UploadJob => {
        const job = uploadJobs[0];
        if (!job) throw new Error('No synthetic upload job is available.');
        return job;
      };

      handle('uploadJobs:list', () => uploadJobs);
      handle('uploadJobs:pause', async () => {
        await beforeUploadAction('pause');
        const job = firstUploadJob();
        job.paused = true;
        return updateUploadSummary(job);
      });
      handle('uploadJobs:resume', async () => {
        await beforeUploadAction('resume');
        const job = firstUploadJob();
        job.paused = false;
        return updateUploadSummary(job);
      });
      handle('uploadJobs:cancel', async () => {
        await beforeUploadAction('cancel');
        const job = firstUploadJob();
        for (const item of job.items) {
          if (item.state === 'queued' || item.state === 'uploading') {
            item.state = 'cancelled';
            item.error = {
              code: 'SYNTHETIC_UPLOAD_CANCELLED',
              message: 'Synthetic transfer was cancelled before completion.',
              retryable: true,
              retryAfterSeconds: null,
              duplicateRisk: false,
            };
          }
        }
        return updateUploadSummary(job);
      });
      const retryIncomplete = (job: UploadJob): UploadJob => {
        for (const item of job.items) {
          if (
            (item.state === 'failed' ||
              item.state === 'cancelled' ||
              item.state === 'uncertain') &&
            item.error?.retryable === true &&
            !item.error.duplicateRisk
          ) {
            item.state = 'queued';
            item.bytesSent = 0;
            item.error = null;
          }
        }
        job.paused = false;
        return updateUploadSummary(job);
      };
      handle('uploadJobs:retry', async () => {
        await beforeUploadAction('retry');
        return retryIncomplete(firstUploadJob());
      });
      handle('uploadJobs:confirmLegacyRetry', async () => {
        await beforeUploadAction('confirmLegacyRetry');
        const job = firstUploadJob();
        for (const item of job.items) {
          if (item.state === 'uncertain' && item.error?.duplicateRisk) {
            item.state = 'queued';
            item.bytesSent = 0;
            item.error = null;
          }
        }
        job.paused = false;
        return updateUploadSummary(job);
      });
      handle('uploadJobs:remove', async () => {
        await beforeUploadAction('remove');
        uploadJobs.splice(0, 1);
        return { removed: true };
      });
      handle('uploadJobs:reset', async () => {
        await beforeUploadAction('reset');
        uploadJobs.splice(0);
        return { reset: true, backupCreated: true };
      });
    }
    if (scenario.inspectorErrorFixture === true) {
      // The selected-model metadata fixture owns the queryModels response.
    } else if (scenario.libraryError !== undefined) {
      handle('catalog:queryModels', () => {
        throw new Error(scenario.libraryError);
      });
    } else if (
      scenario.libraryErrorOnce !== undefined ||
      scenario.libraryQueryDelayMs !== undefined
    ) {
      let queryCalls = 0;
      handle('catalog:queryModels', async () => {
        queryCalls += 1;
        if (scenario.libraryErrorOnce !== undefined && queryCalls === 1) {
          throw new Error(scenario.libraryErrorOnce);
        }
        if (scenario.libraryQueryDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, scenario.libraryQueryDelayMs),
          );
        }
        return {
          models: [],
          counts: {
            all: 0,
            favorites: 0,
            stl: 0,
            threeMf: 0,
            obj: 0,
            step: 0,
            duplicates: 0,
            missing: 0,
          },
          sources: [],
          filteredTotal: 0,
          page: 1,
          pageSize: 24,
        };
      });
    }
    if (
      scenario.sourceScanDelayMs !== undefined ||
      scenario.sourceScanFailureOnce !== undefined
    ) {
      let scanCalls = 0;
      handle('catalog:scanRoot', async () => {
        scanCalls += 1;
        if (scenario.sourceScanDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, scenario.sourceScanDelayMs),
          );
        }
        if (scenario.sourceScanFailureOnce !== undefined && scanCalls === 1) {
          throw new Error(scenario.sourceScanFailureOnce);
        }
        return {
          added: 0,
          changed: 0,
          unchanged: 0,
          missing: 0,
          hashErrors: 0,
          scanErrors: 0,
        };
      });
    }

    const availabilityKind = scenario.availability ?? 'ok';
    handle('calibration:getAvailability', () => {
      if (scenario.offline === true) {
        // The store treats a rejected availability request as offline.
        throw new Error('PrintFarmer is unreachable from this workstation.');
      }
      const available = availabilityKind === 'ok';
      return {
        available,
        unavailableReason: available ? null : availabilityKind,
        unavailableDetail: null,
        negotiatedApiVersion: '2',
        negotiatedSchemaVersion: '2.0',
        capabilityFlags: {
          calibrationApiEnabled: true,
          calibrationChangeFeedEnabled: true,
          calibrationOfflineDraftEnabled: true,
          calibrationPhotoUploadEnabled: true,
          calibrationGenerationEnabled:
            availabilityKind !== 'missingCapabilityFlags',
          calibrationArtifactPromotionEnabled:
            availabilityKind !== 'missingCapabilityFlags',
        },
        // Canonical `resource:action` permissions, exactly as PrintFarmer's
        // capability payload spells them in `effectivePermissions`. The former
        // PascalCase values matched nothing in production, so a fixture using
        // them proved only that the assertion never fired.
        grantedScopes:
          availabilityKind === 'missingScopes'
            ? ['calibration:read']
            : ['calibration:read', 'calibration:create', 'calibration:update'],
        offlineEditingEnabled: true,
        serverUnavailableReasons: [],
      };
    });

    // Filament wizard reads its persisted state on mount. Stable-phase
    // records exercise restart rendering without running a clone, print,
    // or profile-write request.
    handle('calibration:getFilamentWizardState', () =>
      scenario.restoreWizardPhase
        ? {
            schemaVersion: 1,
            printerId: ids.printerId,
            printerModelId: ids.printerModelId,
            machineName: 'K1 Max 0.4',
            processName: '0.20mm Standard',
            baseFilamentName: 'Generic PLA',
            baseFilamentGuid: '22222222-2222-4222-8222-222222222203',
            cloneId: ids.cloneId,
            cloneName: 'Generic PLA (calibration)',
            calibrationProjectId: ids.calibrationProjectId,
            completedMethods: [],
            currentMethod:
              scenario.restoreWizardPhase === 'methodPicker'
                ? null
                : 'temperature_tower',
            inFlightJob:
              scenario.restoreWizardPhase === 'pollingSlice' ||
              scenario.restoreWizardPhase === 'sliceReady'
                ? {
                    jobId: ids.sliceJobId,
                    method: 'temperature_tower',
                    submittedAt: ids.now,
                    pollAttempt: 2,
                    lastStatus:
                      scenario.restoreWizardPhase === 'sliceReady'
                        ? 'Completed'
                        : 'Processing',
                  }
                : null,
            draftObservationFailures: [],
            phase: scenario.restoreWizardPhase,
            updatedAt: ids.now,
          }
        : null,
    );
    if (
      scenario.restoreWizardPhase !== undefined ||
      scenario.sliceSubmissionPending === true ||
      scenario.cloneRequestPending === true ||
      scenario.sendRequestPending === true ||
      scenario.measurementWritePending === true ||
      scenario.methodProgressFailureOnce === true ||
      scenario.completionFailure === true
    ) {
      handle('calibration:saveFilamentWizardState', () => ({ saved: true }));
      for (const channel of [
        'calibration:sendSliceToPrinter',
        'calibration:updateFilamentProfileMeasurement',
        'calibration:submitCalibrationObservation',
        'calibration:completeCalibrationProject',
        'calibration:deleteWorkingCloneProfile',
      ] as const) {
        if (
          (channel === 'calibration:sendSliceToPrinter' &&
            scenario.sendRequestPending === true) ||
          (channel === 'calibration:updateFilamentProfileMeasurement' &&
            scenario.measurementWritePending === true)
        ) {
          handle(channel, () => {
            recordFixtureCall(channel);
            return new Promise<never>(() => {});
          });
          continue;
        }
        if (
          channel === 'calibration:completeCalibrationProject' &&
          scenario.completionFailure === true
        ) {
          handle(channel, () => {
            recordFixtureCall(channel);
            throw new Error('Synthetic project completion failure.');
          });
          continue;
        }
        handle(channel, () => {
          recordFixtureCall(channel);
          throw new Error(
            `Unexpected physical or profile mutation request: ${channel}.`,
          );
        });
      }
      const methodGuidance = [
        ['temperature_tower', 'Temperature tower'],
        ['max_volumetric_speed', 'Max volumetric speed'],
        ['pressure_advance_tower', 'Pressure advance — tower'],
        ['flow_rate_yolo_recommended', 'Flow rate — YOLO (Recommended)'],
        ['flow_rate_yolo_perfectionist', 'Flow rate — YOLO (Perfectionist)'],
        ['flow_rate_pass_1', 'Flow rate — pass 1'],
        ['flow_rate_pass_2', 'Flow rate — pass 2'],
        ['retraction', 'Retraction'],
      ] as const;
      handle('calibration:getMethodGuidanceCatalog', () => ({
        status: 'ok',
        catalog: scenario.methodVariants
          ? methodGuidance.map(([method, title]) => ({
              method,
              title,
              purpose: `Synthetic method purpose for ${title}.`,
              wikiUrl: '',
              setupInputs: [
                {
                  key: 'syntheticInput',
                  label: 'Synthetic setup input',
                  unit: 'units',
                  minimum: 1,
                  maximum: 9,
                },
              ],
              measureQuantity: null,
              steps: ['Synthetic method step.'],
            }))
          : [
              {
                method: 'temperature_tower',
                title: 'Temperature tower',
                purpose:
                  'Compare the synthetic tower bands to choose a nozzle temperature.',
                wikiUrl: '',
                setupInputs: [
                  {
                    key: 'nozzleTemperature',
                    label: 'Nozzle temperature',
                    unit: '°C',
                    minimum: 180,
                    maximum: 300,
                  },
                ],
                measureQuantity: null,
                steps: ['Choose a temperature band.'],
              },
            ],
      }));
      let methodProgressCalls = 0;
      handle('calibration:getMethodProgress', () => {
        recordFixtureCall('calibration:getMethodProgress');
        methodProgressCalls += 1;
        if (
          scenario.methodProgressFailureOnce === true &&
          methodProgressCalls === 1
        ) {
          throw new Error('Synthetic method progress sync failure.');
        }
        return {
          status: 'ok' as const,
          progress: scenario.methodVariants
            ? methodGuidance.map(([method], index) => ({
                id: `fa000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                projectId: ids.calibrationProjectId,
                method,
                disposition: 'Completed' as const,
                currentStepId: null,
                revision: 1,
                createdAtUtc: ids.now,
                updatedAtUtc: ids.now,
              }))
            : [],
        };
      });
      handle('calibration:getInFlightState', () => ({
        status: 'ok',
        projectId: ids.calibrationProjectId,
        orchestration: null,
        drafts: [],
      }));
      if (scenario.restoreWizardPhase === 'pollingSlice') {
        handle(
          'calibration:getSliceJobStatus',
          () => new Promise<never>(() => {}),
        );
      }
    }
    if (scenario.sliceSubmissionPending === true) {
      handle('calibration:createProject', () => {
        recordFixtureCall('calibration:createProject');
        return {
          status: 'ok',
          project: {
            id: ids.calibrationProjectId,
            name: 'Synthetic calibration project',
            lifecycleStatus: 'active',
            experienceMode: 'coach',
            printerId: ids.printerId,
            revision: 1,
          },
        };
      });
      handle('calibration:cloneFilamentProfile', () => {
        recordFixtureCall('calibration:cloneFilamentProfile');
        if (scenario.cloneRequestPending === true) {
          return new Promise<never>(() => {});
        }
        return {
          status: 'ok',
          clone: {
            id: ids.cloneId,
            name: 'Generic PLA (calibration)',
            profileType: 'filament',
            isSystem: false,
          },
        };
      });
      handle('calibration:submitCalibrationSlice', () => {
        recordFixtureCall('calibration:submitCalibrationSlice');
        return new Promise<never>(() => {});
      });
    }

    // Workspace-state hydration lives on the calibration store from the
    // pre-#756 saga era. Under Path D the shipped dashboard does not
    // consume any of the returned state, but the store still fetches on
    // mount — an empty list is the safe stub that keeps the store's
    // error surface quiet without seeding a saga-flavoured record the
    // filament flow neither wants nor renders.
    handle('calibration:listWorkspaceStates', () => ({
      states: [],
      unhydratedProjects: [],
    }));

    const conflicts: CalibrationConflict[] =
      scenario.conflictList === 'populated'
        ? [
            {
              conflictId: 'f7777777-7777-4777-8777-777777777777',
              profileId: ids.profileId,
              projectId: ids.calibrationProjectId,
              kind: 'stepDraft',
              entityId: 'f9999999-9999-4999-8999-999999999991',
              localPayloadSummary:
                scenario.conflictPayload === 'malformed'
                  ? 'not valid json'
                  : JSON.stringify(
                      scenario.conflictPayload === 'tooManyFields'
                        ? Object.fromEntries(
                            Array.from({ length: 21 }, (_, index) => [
                              `field${index + 1}`,
                              `value${index + 1}`,
                            ]),
                          )
                        : {
                            displayName: 'Local temperature notes',
                            targetTemperature: '220',
                          },
                    ),
              serverPayloadSummary: JSON.stringify(
                scenario.conflictPayload === 'tooManyFields'
                  ? {}
                  : {
                      displayName: 'Server temperature notes',
                      targetTemperature: '225',
                    },
              ),
              serverRevision: 5,
              availableResolutions:
                scenario.conflictPayload === 'noResolutions'
                  ? []
                  : [
                      'acceptServer',
                      'keepLocalAsNewRevision',
                      'manualFieldMerge',
                    ],
              resolvedAt: null,
              resolution: null,
              createdAt: ids.now,
            },
            {
              conflictId: 'f8888888-8888-4888-8888-888888888888',
              profileId: ids.profileId,
              projectId: ids.calibrationProjectId,
              kind: 'stepDraft',
              entityId: 'f9999999-9999-4999-8999-999999999992',
              localPayloadSummary: JSON.stringify({
                displayName: 'Local cooling notes',
              }),
              serverPayloadSummary: JSON.stringify({
                displayName: 'Server cooling notes',
              }),
              serverRevision: 6,
              availableResolutions: [
                'acceptServer',
                'keepLocalAsNewRevision',
                'manualFieldMerge',
              ],
              resolvedAt: null,
              resolution: null,
              createdAt: ids.now,
            },
          ]
        : [];
    handle('calibration:listConflicts', () => {
      if (scenario.conflictList === 'error') {
        throw new Error('Synthetic conflict service unavailable.');
      }
      if (scenario.conflictList === 'loading') {
        return new Promise<never>(() => {});
      }
      return { conflicts };
    });
    if (scenario.conflictResolution !== undefined) {
      handle('calibration:resolveConflict', () => {
        const conflict = conflicts[0];
        if (!conflict) {
          throw new Error(
            'The conflict resolution fixture requires a populated list.',
          );
        }
        if (scenario.conflictResolution === 'pending') {
          return new Promise<never>(() => {});
        }
        if (scenario.conflictResolution === 'error') {
          throw new Error('Synthetic stale-revision conflict.');
        }
        return {
          conflict: { ...conflict, resolution: 'acceptServer' },
          supersededObservations: [
            {
              observationId: 'synthetic-observation-1',
              attemptId: 'synthetic-attempt-1',
              stepId: 'synthetic-step-1',
              parameterKey: 'flowRate',
              boundSnapshotRevision: 2,
            },
          ],
        };
      });
    }

    const printerListScenario = scenario.printerList ?? 'populated';
    handle('calibration:listPrinters', () => {
      const printers =
        printerListScenario === 'populated'
          ? [
              {
                printerId: ids.printerId,
                displayName: ids.displayName,
                printerModel: 'A11y Reference Klipper',
                printerModelId: ids.printerModelId,
                isOnline: scenario.offline !== true,
              },
              {
                printerId: ids.altPrinterId,
                displayName: ids.altDisplayName,
                // Model unknown — exercises the wider-pool fallback the
                // retired candidate contract used to protect (see
                // `profileSelection.ts:49-53`).
                printerModel: null,
                printerModelId: null,
                isOnline: scenario.offline !== true,
              },
            ]
          : [];
      return {
        printers,
        printersTruncated: false,
        printersUnreadable: 0,
        fetchedAt: ids.now,
      };
    });

    if (scenario.profileCatalog === true) {
      const machineProfile = {
        name: 'K1 Max 0.4',
        guid: '22222222-2222-4222-8222-222222222201',
        source: 'system' as const,
        displayLabel: 'Bed 300×300',
        contentSha256: null,
      };
      const processProfile = {
        name: '0.20mm Standard',
        guid: '22222222-2222-4222-8222-222222222202',
        source: 'system' as const,
        displayLabel: '0.4 nozzle',
        contentSha256: null,
      };
      const filamentProfile = {
        name: 'Generic PLA',
        guid: '22222222-2222-4222-8222-222222222203',
        source: 'system' as const,
        displayLabel: 'PLA',
        contentSha256: null,
      };
      const profileResponse = {
        status: 'ok' as const,
        profilesTruncated: false,
        fetchedAt: ids.now,
      };

      handle('calibration:listExtendedProfiles', () => ({
        ...profileResponse,
        machineProfiles: [machineProfile],
        processProfiles: [processProfile],
        filamentProfiles: [filamentProfile],
      }));
      handle('calibration:listMachineProfilesForModel', () => ({
        ...profileResponse,
        profiles: scenario.profileCatalogAdminNotice ? [] : [machineProfile],
        noModelAlias: false,
      }));
      handle('calibration:listProcessProfilesForMachines', () => ({
        ...profileResponse,
        profiles: [processProfile],
      }));
      handle('calibration:listFilamentProfilesForMachines', () => ({
        ...profileResponse,
        profiles: [filamentProfile],
      }));
      handle('calibration:listCustomProfiles', () => ({
        status: 'ok',
        profiles: [],
        fetchedAt: ids.now,
      }));
      handle('calibration:listSpoolmanSpools', () => ({
        status: 'ok',
        spools: [],
        fetchedAt: ids.now,
      }));
    }
  }, args);

  // Seed a library source root so the onboarding modal does not block the
  // Filament Calibration nav button on reload.
  const approvalId =
    scenario.sourceScanDelayMs !== undefined ||
    scenario.sourceScanFailureOnce !== undefined
      ? 'f1111111-f111-4111-8111-111111111119'
      : null;
  await page.evaluate((fixtureApprovalId) => {
    localStorage.setItem(
      'printfarmer.library.sourceRoots.v1',
      JSON.stringify({
        version: 1,
        roots: [
          {
            rootId: 'a11y-fixture-root',
            path: '/fixtures/a11y-models',
            approvalId: fixtureApprovalId,
            removed: false,
            lastReport: null,
            lastScannedAt: null,
          },
        ],
      }),
    );
  }, approvalId);

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.getByRole('button', { name: 'Filament Calibration' }),
  ).toBeEnabled({ timeout: 20_000 });
}

/**
 * Navigates to the Filament Calibration dashboard and waits for it to render.
 * Idempotent — if the dashboard heading is already visible, returns
 * immediately.
 */
export async function openCalibrationWorkspace(page: Page): Promise<void> {
  const dashboardHeading = page.getByRole('heading', {
    name: 'Filament Calibration',
    level: 1,
  });
  if (!(await dashboardHeading.isVisible())) {
    const backToDashboard = page
      .getByRole('navigation', { name: 'Calibration views' })
      .getByRole('button', { name: 'Dashboard' });
    if (await backToDashboard.isVisible()) {
      await backToDashboard.click();
    } else {
      await page.getByRole('button', { name: 'Filament Calibration' }).click();
    }
  }
  await expect(
    page.getByRole('main', { name: 'Filament calibration workspace' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(dashboardHeading).toBeVisible({ timeout: 15_000 });
}

/**
 * Opens the Filament Calibration Wizard from the dashboard and waits for
 * Step 1 to render. Requires a scenario with `availability: 'ok'` and
 * `offline: false` (default) — otherwise the primary CTA is disabled and
 * this helper would time out on an unclickable button, which is the correct
 * failure for a test that expects to reach the wizard.
 */
export async function openFilamentCalibrationWizard(page: Page): Promise<void> {
  await openCalibrationWorkspace(page);
  await page
    .getByRole('button', { name: 'Calibrate a filament spool' })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Filament calibration wizard',
      level: 1,
    }),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * A control with no accessible name. Injected into a surface to prove the
 * scanner reports, because `0 violations` and `scanner not wired` are the same
 * observation until non-zero has been shown to be reachable. Sized explicitly
 * so it cannot be skipped as a zero-area element.
 */
const AXE_PROBE_RULE = 'button-name';

async function withAxeProbe<T>(
  container: Locator,
  run: () => Promise<T>,
): Promise<T> {
  await container.evaluate((node) => {
    const probe = document.createElement('button');
    probe.type = 'button';
    probe.setAttribute('data-axe-probe', 'true');
    probe.style.cssText = 'width:44px;height:44px;opacity:0.01;';
    node.append(probe);
  });
  try {
    return await run();
  } finally {
    await container.evaluate((node) => {
      node.querySelector('[data-axe-probe]')?.remove();
    });
  }
}

/**
 * Asserts the surface actually rendered, that the scanner reports violations
 * in it, and only then that it has none.
 *
 * Two independent lies are defeated here. An axe scan of a container that
 * never rendered reports zero violations, so `present` must be visible and
 * non-empty first. And a misconfigured scanner — wrong scope, disabled rules,
 * a failed injection — reports zero violations on a fully rendered page, which
 * the render precondition cannot see. So a known violation is injected into
 * this specific surface and the scan must report it before the clean scan is
 * believed. `present` must be a locator unique to the surface under test.
 */
export async function scanSurface(
  page: Page,
  options: {
    readonly name: string;
    readonly present: Locator;
    readonly testInfo: TestInfo;
    readonly include?: string;
    readonly soft?: boolean;
  },
): Promise<void> {
  const { name, present, testInfo } = options;
  await expect(
    present,
    `${name} did not render, so an axe scan of it would prove nothing`,
  ).toBeVisible({ timeout: 15_000 });
  const text = (await present.innerText()).trim();
  expect(
    text.length,
    `${name} rendered empty, so an axe scan of it would prove nothing`,
  ).toBeGreaterThan(0);

  const scan = async (): Promise<Result[]> => {
    // Electron's CDP target cannot create Axe's blank aggregation page. This
    // app has no frames, so legacy mode runs the same rules against the UI.
    let builder = new AxeBuilder({ page }).setLegacyMode().withTags(WCAG_TAGS);
    if (options.include !== undefined) {
      builder = builder.include(options.include);
    }
    const results = await builder.analyze();
    return results.violations.filter(
      (violation) =>
        typeof violation.impact === 'string' &&
        MATERIAL_IMPACTS.has(violation.impact),
    );
  };

  const probed = await withAxeProbe(present, scan);
  const detected = probed.find((violation) => violation.id === AXE_PROBE_RULE);
  expect(
    detected?.id,
    `the axe scan of ${name} did not report a deliberately unnamed button, so it is not scanning this surface and its zero-violation result would prove nothing (reported: ${probed.map((violation) => violation.id).join(', ') || 'nothing'})`,
  ).toBe(AXE_PROBE_RULE);
  expect(
    detected?.nodes.length ?? 0,
    `the axe scan of ${name} reported ${AXE_PROBE_RULE} with no nodes`,
  ).toBeGreaterThan(0);

  const material = await scan();
  if (material.length > 0) {
    const body = Buffer.from(JSON.stringify(material, null, 2));
    const findingsDirectory = path.join(
      repoRoot,
      'artifacts',
      'ui-coverage-review',
      'findings',
      process.platform,
    );
    mkdirSync(findingsDirectory, { recursive: true });
    const digest = createHash('sha256').update(body).digest('hex');
    const findingsPath = path.join(
      findingsDirectory,
      `${name.replaceAll(/[^a-z0-9.-]+/gi, '-')}-${digest}.json`,
    );
    writeFileSync(findingsPath, body);
    await testInfo.attach(`axe-${name.replaceAll(' ', '-')}.json`, {
      path: findingsPath,
    });
  }
  expect
    .configure({ soft: options.soft ?? false })(
      material,
      `${name} has material WCAG A/AA violations`,
    )
    .toEqual([]);
}

/** Accessible name and role of the currently focused element. */
export async function focusedDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return '<body>';
    const label =
      active.getAttribute('aria-label') ??
      (active.textContent ?? '').trim().slice(0, 80);
    return `${active.tagName.toLowerCase()}[${active.getAttribute('role') ?? 'implicit'}] "${label}"`;
  });
}

/**
 * Tabs forward until `target` is focused, asserting focus actually moved and
 * that the element reached sits inside `expectedContainer` when given.
 *
 * A traversal that ends where it started, or that never reaches the named
 * element, is a dead end — this reports which named element it could not
 * reach and where focus ended up.
 */
export async function expectTabReaches(
  page: Page,
  target: Locator,
  description: string,
  maxPresses = 60,
  expectedContainer?: Locator,
): Promise<void> {
  const start = await focusedDescription(page);
  const seen: string[] = [];
  for (let press = 0; press < maxPresses; press += 1) {
    await page.keyboard.press('Tab');
    const current = await focusedDescription(page);
    seen.push(current);
    if (await target.evaluate((node) => node === document.activeElement)) {
      expect(
        current,
        `Tab left focus on ${start}; a traversal that does not move proves nothing`,
      ).not.toBe(start);
      if (expectedContainer !== undefined) {
        expect(
          await focusIsInside(expectedContainer),
          `Tab reached ${description}, but that element is not inside the surface under test (focus is ${current})`,
        ).toBe(true);
      }
      return;
    }
  }
  throw new Error(
    `Tab never reached ${description} in ${String(maxPresses)} presses.\n` +
      `Focus started on ${start} and visited:\n  ${seen.join('\n  ')}`,
  );
}

/** True when the focused element is inside `container`. */
export async function focusIsInside(container: Locator): Promise<boolean> {
  return container.evaluate(
    (node) =>
      document.activeElement !== null && node.contains(document.activeElement),
  );
}
