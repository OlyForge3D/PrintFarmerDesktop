import { describe, expect, it } from 'vitest';

import {
  CalibrationSaveWorkspaceStateRequest,
  CalibrationWorkspacePayload,
  deriveCalibrationWorkspaceProjection,
  type CalibrationWorkspacePayload as CalibrationWorkspacePayloadType,
} from '@shared/ipc';
import {
  isAuthoritativeCalibrationContext,
  isExplicitCalibrationContextComplete,
  isExplicitCalibrationEligibilityComplete,
  prepareCalibrationWorkspaceSave,
  projectCalibrationPrinterContext,
  projectPrintFarmerOrcaProfile,
  RemoteCalibrationProject,
  RemoteCalibrationPrinterCandidate,
  RemoteCalibrationPrinterContext,
} from '../src/main/calibrationWire.js';
import { evaluateCalibrationActionGate } from '../src/main/calibrationActionGate.js';
import { calibrationContextDto } from './fixtures/calibrationContract.js';
import { resolveCalibrationWorkspaceFreshness } from '../src/main/calibrationFreshness.js';
import { CalibrationHttpError } from '../src/main/calibrationHttp.js';
import { bindingFromContext } from '../src/renderer/calibration/projectEligibility.js';

import {
  ATTEMPT_ID,
  FILAMENT_PROFILE_GUID,
  MACHINE_PROFILE_GUID,
  NOW,
  OPERATION_ID,
  OTHER_PRINTER_GUID,
  PRINTER_GUID,
  PROFILE_ID,
  PROJECT_ID,
  PROCESS_PROFILE_GUID,
  SNAPSHOT_SHA,
  STAGE_IDS,
  TOOLHEAD_GUID,
  validWorkspace,
  workspaceWithCompletedAttempt,
} from './fixtures/calibrationWorkspacePayload.js';

function request(workspace = validWorkspace()) {
  const projection = deriveCalibrationWorkspaceProjection(
    workspace.domainState,
  );
  return CalibrationSaveWorkspaceStateRequest.parse({
    profileId: PROFILE_ID,
    projectId: PROJECT_ID,
    displayName: workspace.metadata.displayName,
    description: workspace.metadata.description || null,
    printerId: PRINTER_GUID,
    status: projection.status,
    completedStepCount: projection.completedStepCount,
    totalStepCount: projection.totalStepCount,
    baseRevision: null,
    operationId: OPERATION_ID,
    workspaceState: workspace,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('calibration workspace IPC', () => {
  it('persists all nine exact workflow drafts without schema defaults', () => {
    const workspace = validWorkspace();
    workspace.workflowDrafts.temperature.observation.notes = 'keep exactly';
    workspace.workflowDrafts.temperature.photoCaption = 'tower';

    const parsed = CalibrationWorkspacePayload.parse(workspace);

    expect(Object.keys(parsed.workflowDrafts)).toEqual(STAGE_IDS);
    expect(parsed.workflowDrafts.temperature.observation.notes).toBe(
      'keep exactly',
    );
    const missing = structuredClone(workspace);
    delete (missing.workflowDrafts as Partial<typeof missing.workflowDrafts>)
      .temperature;
    expect(() => CalibrationWorkspacePayload.parse(missing)).toThrow();
  });

  it('keeps oversized and legacy remote workspaces recoverable but unhydrated', () => {
    const oversized = validWorkspace();
    oversized.domainState.diagnostics = Array.from(
      { length: 140 },
      (_, index) => ({
        code: `oversized-${index}`,
        severity: 'warning',
        message: 'x'.repeat(4_096),
      }),
    );
    expect(
      Buffer.byteLength(JSON.stringify(oversized), 'utf8'),
    ).toBeGreaterThan(512 * 1_024);
    const remoteProject = {
      id: PROJECT_ID,
      displayName: 'Remote calibration',
      description: null,
      status: 'draft',
      printerId: PRINTER_GUID,
      revision: 1,
      concurrencyToken: 'revision-1',
      createdAt: NOW,
      updatedAt: NOW,
    };

    expect(
      RemoteCalibrationProject.parse({
        ...remoteProject,
        workspaceState: oversized,
      }).workspaceState,
    ).toBeNull();
    expect(
      RemoteCalibrationProject.parse({
        ...remoteProject,
        workspaceState: { legacyVersion: 4 },
      }).workspaceState,
    ).toBeNull();
  });

  it('computes a canonical idempotency key and native freshness input', () => {
    const first = request();
    const reordered = request();
    const baseline = reordered.workspaceState.domainState.baseline;
    reordered.workspaceState.domainState.baseline = {
      flowRatio: baseline.flowRatio,
      pressureAdvance: baseline.pressureAdvance,
      nozzleTemperatureC: baseline.nozzleTemperatureC,
      maximumVolumetricRateMm3S: baseline.maximumVolumetricRateMm3S,
      retractionLengthMm: baseline.retractionLengthMm,
      shrinkageCompensationZPercent: baseline.shrinkageCompensationZPercent,
      shrinkageCompensationYPercent: baseline.shrinkageCompensationYPercent,
      shrinkageCompensationXPercent: baseline.shrinkageCompensationXPercent,
    };

    const firstSave = prepareCalibrationWorkspaceSave(first, PROFILE_ID, true);
    const secondSave = prepareCalibrationWorkspaceSave(
      reordered,
      PROFILE_ID,
      true,
    );
    expect(firstSave.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secondSave.idempotencyKey).toBe(firstSave.idempotencyKey);
    expect(firstSave.printerContextFresh).toBe(true);
  });

  it('fences request, domain profile, project, and printer identities', () => {
    expect(() =>
      prepareCalibrationWorkspaceSave(
        request(),
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        false,
      ),
    ).toThrow(/selected profile/i);

    for (const mutate of [
      (workspace: CalibrationWorkspacePayloadType) => {
        workspace.domainState.projectId =
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      },
      (workspace: CalibrationWorkspacePayloadType) => {
        workspace.domainState.binding.printer.backendProfileId =
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      },
      (workspace: CalibrationWorkspacePayloadType) => {
        workspace.domainState.binding.printer.backendPrinterId = 'other';
      },
    ]) {
      const workspace = validWorkspace();
      mutate(workspace);
      expect(() =>
        CalibrationSaveWorkspaceStateRequest.parse({
          ...request(),
          workspaceState: workspace,
        }),
      ).toThrow();
    }
  });

  it('rejects forged progress counts and status', () => {
    const completed = request(workspaceWithCompletedAttempt());
    expect(completed.completedStepCount).toBe(1);
    expect(completed.status).toBe('inProgress');
    expect(() =>
      CalibrationSaveWorkspaceStateRequest.parse({
        ...completed,
        completedStepCount: 0,
      }),
    ).toThrow(/derived/);
    expect(() =>
      CalibrationSaveWorkspaceStateRequest.parse({
        ...completed,
        status: 'draft',
      }),
    ).toThrow(/derived/);
  });

  it('requires exactly nine matching stage records', () => {
    const workspace = validWorkspace();
    expect(() =>
      CalibrationWorkspacePayload.parse({
        ...workspace,
        domainState: {
          ...workspace.domainState,
          stages: {
            ...workspace.domainState.stages,
            rogue: {
              stageId: 'temperature',
              status: 'notStarted',
              attemptIds: [],
            },
          },
        },
      }),
    ).toThrow();
    const mismatched = validWorkspace();
    mismatched.domainState.stages.temperature.stageId = 'flowPass1';
    expect(() => CalibrationWorkspacePayload.parse(mismatched)).toThrow(
      /Stage key/,
    );
  });

  it('requires unique attempts, observations, events, and exact stage links', () => {
    const duplicateAttempt = workspaceWithCompletedAttempt();
    duplicateAttempt.domainState.attempts.push(
      structuredClone(duplicateAttempt.domainState.attempts[0]!),
    );
    expect(() => CalibrationWorkspacePayload.parse(duplicateAttempt)).toThrow(
      /Attempt identities/,
    );

    const badStageLinks = workspaceWithCompletedAttempt();
    badStageLinks.domainState.stages.temperature.attemptIds.push(ATTEMPT_ID);
    expect(() => CalibrationWorkspacePayload.parse(badStageLinks)).toThrow(
      /exact and unique/,
    );

    const badObservation = workspaceWithCompletedAttempt();
    badObservation.domainState.attempts[0]!.observations[0]!.attemptId =
      'other-attempt';
    expect(() => CalibrationWorkspacePayload.parse(badObservation)).toThrow(
      /Observation identity/,
    );

    const duplicateEvents = validWorkspace();
    duplicateEvents.domainState.history.push(
      {
        eventId: 'event-1',
        timestamp: NOW,
        type: 'navigate',
        stageId: 'temperature',
      },
      {
        eventId: 'event-1',
        timestamp: NOW,
        type: 'navigate',
        stageId: 'flowPass1',
      },
    );
    expect(() => CalibrationWorkspacePayload.parse(duplicateEvents)).toThrow(
      /Event identities/,
    );
  });

  it('requires selected and completed stage state to agree', () => {
    const missingSelection = workspaceWithCompletedAttempt();
    delete missingSelection.domainState.stages.temperature.selectedAttemptId;
    expect(() => CalibrationWorkspacePayload.parse(missingSelection)).toThrow(
      /Completed stages require/,
    );

    const activeSelection = workspaceWithCompletedAttempt();
    activeSelection.domainState.attempts[0]!.status = 'inProgress';
    delete activeSelection.domainState.attempts[0]!.completedAt;
    delete activeSelection.domainState.attempts[0]!.confidence;
    delete activeSelection.domainState.attempts[0]!.recommendation;
    expect(() => CalibrationWorkspacePayload.parse(activeSelection)).toThrow(
      /Selected attempt must be a completed/,
    );
  });

  it('validates history references and physical/base-profile scope', () => {
    const history = validWorkspace();
    history.domainState.history.push({
      eventId: 'event-1',
      timestamp: NOW,
      type: 'completeAttempt',
      attemptId: ATTEMPT_ID,
      confidence: 'high',
    });
    expect(() => CalibrationWorkspacePayload.parse(history)).toThrow(
      /History attempt reference/,
    );

    const physical = validWorkspace();
    physical.physicalMatch = {
      snapshotId: 'wrong',
      toolId: TOOLHEAD_GUID,
      toolheadId: TOOLHEAD_GUID,
      nozzleId: TOOLHEAD_GUID,
      nozzleDiameterMm: 0.4,
      confirmedAt: NOW,
    };
    expect(() => CalibrationWorkspacePayload.parse(physical)).toThrow(
      /Physical match/,
    );

    const profile = validWorkspace();
    profile.selectedBaseProfile.nozzleId = 'wrong';
    expect(() => CalibrationWorkspacePayload.parse(profile)).toThrow(
      /Selected base profile/,
    );

    const snapshot = validWorkspace();
    snapshot.domainState.binding.snapshot.safety.maximumBedTemperatureC += 1;
    expect(() => CalibrationWorkspacePayload.parse(snapshot)).toThrow(
      /latest snapshot/,
    );
  });

  it('requires photo and workflow drafts to reference attempts in their stage', () => {
    const workspace = workspaceWithCompletedAttempt();
    workspace.workflowDrafts.flowPass1.photoAttemptId = ATTEMPT_ID;
    expect(() => CalibrationWorkspacePayload.parse(workspace)).toThrow(
      /Photo draft attempt/,
    );
  });

  it('keeps the 512 KiB native-boundary cap', () => {
    const oversized = validWorkspace();
    oversized.domainState.diagnostics = Array.from(
      { length: 130 },
      (_, index) => ({
        code: `diagnostic-${index}`,
        severity: 'warning' as const,
        message: 'x'.repeat(4_096),
      }),
    );
    const oversizedRequest = request(
      CalibrationWorkspacePayload.parse(oversized),
    );
    expect(() =>
      prepareCalibrationWorkspaceSave(oversizedRequest, PROFILE_ID, false),
    ).toThrow(/512 KiB/i);
  });

  it('rejects renderer hash, path, URL, and credential injection', () => {
    for (const [key, value] of Object.entries({
      idempotencyKey: 'a'.repeat(64),
      path: 'C:\\private\\photo.png',
      url: 'https://attacker.invalid',
      credentials: { token: 'secret' },
    })) {
      expect(() =>
        CalibrationSaveWorkspaceStateRequest.parse({
          ...request(),
          [key]: value,
        }),
      ).toThrow();
    }
  });
});

describe.skip('explicit printer eligibility (Path D: eligibility gate retired)', () => {
  // The eligibility gate at `/api/printers/calibration-candidates` was
  // retired by `OlyForge3D/PrintFarmer#1943`. The candidate list now
  // projects `CompletePrinterDto` with no eligibility metadata, so the
  // client no longer runs an eligibility projection and these scenarios do
  // not apply. Kept as `describe.skip` so the intent is discoverable if the
  // shape ever returns.
  it('maps incomplete and unknown remote assertions to null', () => {});
  it('accepts only the five canonical literals independent of names', () => {});
  it('never grants eligibility the server withheld, whatever the name says', () => {});
});

/**
 * A `CalibrationCandidateDto` shaped exactly as PrintFarmer serialises it.
 * Source: `CalibrationContracts.cs` on OlyForge3D/PrintFarmer@development.
 */
function candidateDto(overrides: Record<string, unknown> = {}) {
  return {
    id: PRINTER_GUID,
    name: 'Any arbitrary printer name',
    // Under Path D the candidate list projects `CompletePrinterDto`, which
    // spells this field `isEnabled` (not `enabled`). Kept explicit rather
    // than deleted so a legacy fixture cannot silently degrade the candidate
    // to disabled and mask a genuine projection regression.
    isEnabled: true,
    enabled: true,
    inMaintenance: false,
    // `CompletePrinterDto.IsOnline` under Path D. The old fixture leaned on
    // `reachability`/`operationalState` to imply online-ness; the new wire
    // schema reads the boolean directly and defaults it to `false` when
    // absent, so it must be set explicitly for a candidate the projection
    // should treat as reachable.
    isOnline: true,
    backend: 'Moonraker',
    configurationRevision: 7,
    reachability: 'online',
    operationalState: 'idle',
    statusSource: 'moonraker',
    observedAtUtc: NOW,
    lastSeenAtUtc: NOW,
    isStale: false,
    toolheads: [],
    firmware: {
      family: 'Klipper',
      gcodeDialect: 'Klipper',
      detectionSource: 'moonraker',
      version: 'v0.12.0',
      verified: true,
    },
    slicer: {
      engine: 'OrcaSlicer',
      distribution: 'upstream',
      version: '2.4.2',
      profileFormat: 'orca-json',
    },
    eligible: true,
    profilesEvaluated: false,
    missingInputs: [],
    rejectionReasons: [],
    ...overrides,
  };
}

/** A `CalibrationContextDto`, i.e. a candidate plus the nested snapshot. */
function contextDto(overrides: Record<string, unknown> = {}) {
  const { snapshot: snapshotOverride, ...rest } = overrides;
  return {
    ...candidateDto(),
    // The selected context is the server's authoritative verdict: it resolved
    // the printer's profiles. A candidate listing never does, which is why the
    // two must not be treated as interchangeable evidence.
    profilesEvaluated: true,
    schemaVersion: '1.0',
    snapshotSha256: SNAPSHOT_SHA,
    capturedAtUtc: NOW,
    capturedBySubject: 'subject-1',
    supportsPressureAdvance: true,
    supportsFirmwareRetraction: true,
    snapshot: {
      schemaVersion: '1.0',
      printerId: PRINTER_GUID,
      configurationRevision: 7,
      capturedAtUtc: NOW,
      buildVolume: { x: 220, y: 220, z: 250 },
      bedOrigin: { x: 0, y: 0 },
      toolheads: [
        {
          id: TOOLHEAD_GUID,
          index: 0,
          name: 'T0',
          isPrimary: true,
          nozzleDiameter: 0.4,
          nozzleType: 'brass',
          nozzleMaterial: 'brass',
          isDirectDrive: true,
          maxVolumetricFlow: 30,
          maxHotendTemperature: 300,
        },
      ],
      maxBedTemperature: 120,
      hasHeatedBed: true,
      firmware: {
        family: 'Klipper',
        gcodeDialect: 'Klipper',
        detectionSource: 'moonraker',
        version: 'v0.12.0',
        verified: true,
      },
      slicer: {
        engine: 'OrcaSlicer',
        distribution: 'upstream',
        version: '2.4.2',
        profileFormat: 'orca-json',
      },
      profiles: {
        machine: {
          id: MACHINE_PROFILE_GUID,
          kind: 'machine',
          name: 'Voron 2.4 0.4 nozzle',
          slicerType: 'OrcaSlicer',
          slicerDistribution: 'upstream',
          slicerVersion: '2.4.2',
          profileFormat: 'orca-json',
          profileRevision: 'machine-r7',
          sha256: 'b'.repeat(64),
        },
        process: {
          id: PROCESS_PROFILE_GUID,
          kind: 'process',
          name: '0.20 mm Standard',
          slicerType: 'OrcaSlicer',
          slicerDistribution: 'upstream',
          slicerVersion: '2.4.2',
          profileFormat: 'orca-json',
          profileRevision: 'process-r7',
          sha256: 'c'.repeat(64),
        },
        filament: {
          id: FILAMENT_PROFILE_GUID,
          kind: 'filament',
          name: 'Upstream PLA',
          slicerType: 'OrcaSlicer',
          slicerDistribution: 'upstream',
          slicerVersion: '2.4.2',
          profileFormat: 'orca-json',
          profileRevision: 'profile-r7',
          sha256: 'd'.repeat(64),
        },
      },
      baselineSettings: { activeNozzleDiameter: 0.4 },
      snapshotSha256: SNAPSHOT_SHA,
      ...(typeof snapshotOverride === 'object' && snapshotOverride !== null
        ? snapshotOverride
        : {}),
    },
    ...rest,
  };
}

function remoteCandidate(overrides: Record<string, unknown> = {}) {
  return RemoteCalibrationPrinterCandidate.parse(candidateDto(overrides));
}

describe('only an authoritative context may be bound', () => {
  // The blocker this covers: the context transform dropped `profilesEvaluated`,
  // so completeness and binding tested only whether identity fields were
  // populated. A context the server had explicitly refused could still be
  // marked current and bound, because the candidate list's preliminary screen
  // was effectively standing in for a resolution it never performed.
  const authoritative = RemoteCalibrationPrinterContext.parse(
    calibrationContextDto(),
  );

  it('accepts a context that is evaluated, eligible and carries no blockers', () => {
    // Control. Without it every refusal below is satisfied by a predicate that
    // refuses everything.
    expect(authoritative.profilesEvaluated).toBe(true);
    expect(isAuthoritativeCalibrationContext(authoritative)).toBe(true);
    expect(isExplicitCalibrationContextComplete(authoritative)).toBe(true);
    expect(projectCalibrationPrinterContext(authoritative)).toMatchObject({
      isCurrent: true,
      profileIdentities: {
        machine: {
          backendProfileId: MACHINE_PROFILE_GUID,
          orcaProfileName: 'Voron 2.4 0.4 nozzle',
        },
        process: {
          backendProfileId: PROCESS_PROFILE_GUID,
          orcaProfileName: '0.20 mm Standard',
        },
        filament: {
          backendProfileId: FILAMENT_PROFILE_GUID,
          orcaProfileName: 'Upstream PLA',
        },
      },
    });
    expect(
      projectPrintFarmerOrcaProfile(remoteCandidate(), authoritative),
    ).not.toBeNull();
    const projected = projectCalibrationPrinterContext(authoritative);
    expect(
      bindingFromContext(PROFILE_ID, projected, TOOLHEAD_GUID, {
        filamentProjectId: 'filament-1',
        provider: 'PrintFarmer',
        product: 'PLA',
        sku: 'PLA-BLACK',
      })?.profileIdentities,
    ).toEqual(projected.profileIdentities);
  });

  const refusals: ReadonlyArray<[string, Record<string, unknown>]> = [
    [
      'the server says it did not evaluate profiles',
      { profilesEvaluated: false },
    ],
    [
      'an older server omits the field entirely',
      // Silence is not a pass. This is the compatibility case: nothing may be
      // inferred from a field the server never sent.
      { profilesEvaluated: null },
    ],
    [
      'the server evaluated profiles and refused the printer',
      {
        profilesEvaluated: true,
        eligible: false,
        rejectionReasons: [
          { code: 'profile_hash_mismatch', message: 'hash mismatch' },
        ],
      },
    ],
    [
      'the server reports missing inputs despite populated profiles',
      {
        profilesEvaluated: true,
        eligible: false,
        missingInputs: ['profiles.filament.sha256'],
      },
    ],
    [
      'the server contradicts itself, claiming eligible while giving reasons',
      {
        profilesEvaluated: true,
        eligible: true,
        rejectionReasons: [
          { code: 'printer_in_maintenance', message: 'in maintenance' },
        ],
      },
    ],
  ];

  for (const [label, override] of refusals) {
    it(`refuses to bind when ${label}`, () => {
      const context = RemoteCalibrationPrinterContext.parse(
        calibrationContextDto(override),
      );
      // Every identity the contract names is still present, so this is only
      // refused because the evaluation itself is not authoritative.
      expect(context.configurationId).not.toBeNull();
      expect(context.snapshotId).not.toBeNull();
      expect(context.orcaProfileName).not.toBeNull();

      expect(isAuthoritativeCalibrationContext(context)).toBe(false);
      expect(isExplicitCalibrationContextComplete(context)).toBe(false);
      // The projection must not present it as current, or the renderer would
      // show a bindable-looking snapshot.
      expect(projectCalibrationPrinterContext(context).isCurrent).toBe(false);
      expect(projectCalibrationPrinterContext(context).evaluationScope).toBe(
        'preliminary',
      );
      // And no profile may be derived from it.
      expect(
        projectPrintFarmerOrcaProfile(remoteCandidate(), context),
      ).toBeNull();
    });
  }

  it('is not rescued by a candidate that passed the preliminary screen', () => {
    // The precise failure mode. A candidate list says a printer looks fine;
    // that is a basic screen and never authorises binding. Here the candidate
    // is eligible and the context is not, and the context wins.
    const candidate = remoteCandidate();
    expect(isExplicitCalibrationEligibilityComplete(candidate)).toBe(true);
    const refused = RemoteCalibrationPrinterContext.parse(
      calibrationContextDto({
        profilesEvaluated: true,
        eligible: false,
        rejectionReasons: [
          { code: 'filament_profile_not_found', message: 'not found' },
        ],
      }),
    );
    expect(projectPrintFarmerOrcaProfile(candidate, refused)).toBeNull();
  });
});

describe('explicit printer context', () => {
  it('blocks missing and non-upstream identities', () => {
    // A filament profile with no revision cannot be pinned.
    const missing = RemoteCalibrationPrinterContext.parse(
      contextDto({
        snapshot: {
          profiles: {
            machine: null,
            process: null,
            filament: {
              id: FILAMENT_PROFILE_GUID,
              kind: 'filament',
              name: 'Upstream PLA',
              slicerType: 'OrcaSlicer',
              slicerDistribution: 'upstream',
              slicerVersion: '2.4.2',
              profileFormat: 'orca-json',
              profileRevision: null,
              sha256: null,
            },
          },
        },
      }),
    );
    expect(isExplicitCalibrationContextComplete(missing)).toBe(false);

    const fork = RemoteCalibrationPrinterContext.parse(
      contextDto({
        slicer: {
          engine: 'OrcaSlicer',
          distribution: 'vendorFork',
          version: '2.4.2',
          profileFormat: 'orca-json',
        },
      }),
    );
    expect(isExplicitCalibrationContextComplete(fork)).toBe(false);
    expect(
      projectCalibrationPrinterContext(fork).slicerDistribution,
    ).toBeNull();
  });

  it('projects only strict known IPC fields from a complete remote context', () => {
    const context = RemoteCalibrationPrinterContext.parse(
      contextDto({ futureRemoteField: { secret: 'not projected' } }),
    );
    expect(isExplicitCalibrationContextComplete(context)).toBe(true);
    const projected = projectCalibrationPrinterContext(context);
    expect(projected.isCurrent).toBe(true);
    expect(projected).not.toHaveProperty('futureRemoteField');
  });
});

describe('printer-context freshness policy', () => {
  it('retains existing freshness offline and denies new offline creation', async () => {
    const offline = new CalibrationHttpError('transport', 'offline');
    await expect(
      resolveCalibrationWorkspaceFreshness(
        request(),
        {
          isPrinterContextFresh: true,
          workspaceState: validWorkspace(),
        },
        () => Promise.reject(offline),
      ),
    ).resolves.toBe(true);
    await expect(
      resolveCalibrationWorkspaceFreshness(
        request(),
        {
          isPrinterContextFresh: false,
          workspaceState: validWorkspace(),
        },
        () => Promise.reject(offline),
      ),
    ).resolves.toBe(false);
    await expect(
      resolveCalibrationWorkspaceFreshness(request(), null, () =>
        Promise.reject(offline),
      ),
    ).rejects.toMatchObject({ code: 'CALIBRATION_OFFLINE_CREATE_DENIED' });

    const changedBinding = request();
    changedBinding.workspaceState.domainState.binding.filament.product =
      'forged offline product';
    await expect(
      resolveCalibrationWorkspaceFreshness(
        changedBinding,
        {
          isPrinterContextFresh: true,
          workspaceState: validWorkspace(),
        },
        () => Promise.reject(offline),
      ),
    ).rejects.toMatchObject({
      code: 'CALIBRATION_OFFLINE_CONTEXT_CHANGE_DENIED',
    });
  });

  it('marks authoritative mismatches stale and exact rebases fresh', async () => {
    const exact = RemoteCalibrationPrinterContext.parse(contextDto());
    const mismatch = RemoteCalibrationPrinterContext.parse(
      contextDto({ snapshotSha256: 'b'.repeat(64) }),
    );
    await expect(
      resolveCalibrationWorkspaceFreshness(
        request(),
        {
          isPrinterContextFresh: true,
          workspaceState: validWorkspace(),
        },
        () => Promise.resolve(mismatch),
      ),
    ).resolves.toBe(false);
    await expect(
      resolveCalibrationWorkspaceFreshness(request(), null, () =>
        Promise.resolve(mismatch),
      ),
    ).rejects.toMatchObject({
      code: 'CALIBRATION_PRINTER_CONTEXT_MISMATCH',
    });
    await expect(
      resolveCalibrationWorkspaceFreshness(request(), null, () =>
        Promise.resolve(exact),
      ),
    ).resolves.toBe(true);
  });

  it('does not report drift when the operator-attested interlock booleans differ from the wire default', async () => {
    // The three interlock booleans (emergencyStopAvailable, thermal, ventilation)
    // are operator-owned in the workspace binding: they carry the wizard's
    // checkbox attestations. PrintFarmer's `CalibrationContextDto` publishes no
    // such block, so the wire correctly hardcodes them `false`. Before this
    // fix the drift-detection field-by-field equality compared them, which
    // meant an operator-attested `true` workspace would read as permanently
    // drifted against every real context — refusing new-project creation with
    // `CALIBRATION_PRINTER_CONTEXT_MISMATCH`.
    //
    // Assertion: the workspace binding carries `emergencyStopAvailable: true`
    // (as an operator-run wizard would produce it), the wire produces
    // `false`, and freshness resolves to `true` regardless — the interlocks
    // are excluded from drift detection because no server field mirrors them.
    const workspace = validWorkspace();
    workspace.domainState.binding.snapshot.safety.emergencyStopAvailable = true;
    workspace.domainState.binding.snapshot.safety.thermalProtectionConfirmed = true;
    workspace.domainState.binding.snapshot.safety.ventilationAssessed = true;
    // The Zod parse in `validWorkspace()` deep-copies, so `binding.snapshot`
    // and `snapshotHistory[0]` are distinct objects. Both must be mutated in
    // lockstep or the workspace fails the `binding must match latest snapshot`
    // shape check (`ipc.ts` `workspaceIssue`), which would fire before the
    // freshness check even runs.
    const latestHistorySnapshot = workspace.domainState.snapshotHistory.at(-1);
    if (latestHistorySnapshot !== undefined) {
      latestHistorySnapshot.safety.emergencyStopAvailable = true;
      latestHistorySnapshot.safety.thermalProtectionConfirmed = true;
      latestHistorySnapshot.safety.ventilationAssessed = true;
    }
    const exact = RemoteCalibrationPrinterContext.parse(contextDto());
    expect(exact.safety?.emergencyStopAvailable).toBe(false);
    expect(exact.safety?.thermalProtectionConfirmed).toBe(false);
    expect(exact.safety?.ventilationAssessed).toBe(false);
    await expect(
      resolveCalibrationWorkspaceFreshness(request(workspace), null, () =>
        Promise.resolve(exact),
      ),
    ).resolves.toBe(true);

    // Matching-predicate control: mutating a server-owned field (build volume
    // Z) on the same context yields a genuine drift. If both assertions were
    // to pass together, drift detection would be trivially permissive; if
    // both were to fail, the exclusion would be too narrow. Same fixture,
    // opposite result.
    const drifted = RemoteCalibrationPrinterContext.parse({
      ...contextDto(),
      snapshot: {
        ...contextDto().snapshot,
        buildVolume: { x: 220, y: 220, z: 999 },
      },
    });
    await expect(
      resolveCalibrationWorkspaceFreshness(request(workspace), null, () =>
        Promise.resolve(drifted),
      ),
    ).rejects.toMatchObject({
      code: 'CALIBRATION_PRINTER_CONTEXT_MISMATCH',
    });
  });

  it('requires every exact profile identity while keeping legacy drafts editable offline', async () => {
    const exactDto = contextDto();
    const mutations = [
      (profile: typeof exactDto.snapshot.profiles.machine) => ({
        ...profile,
        id: OTHER_PRINTER_GUID,
      }),
      (profile: typeof exactDto.snapshot.profiles.machine) => ({
        ...profile,
        name: `${profile.name} changed`,
      }),
      (profile: typeof exactDto.snapshot.profiles.machine) => ({
        ...profile,
        profileRevision: `${profile.profileRevision}-changed`,
      }),
      (profile: typeof exactDto.snapshot.profiles.machine) => ({
        ...profile,
        sha256: 'e'.repeat(64),
      }),
    ];
    for (const kind of ['machine', 'process', 'filament'] as const) {
      for (const mutate of mutations) {
        const identityMismatch = RemoteCalibrationPrinterContext.parse({
          ...exactDto,
          snapshot: {
            ...exactDto.snapshot,
            profiles: {
              ...exactDto.snapshot.profiles,
              [kind]: mutate(exactDto.snapshot.profiles[kind]),
            },
          },
        });
        await expect(
          resolveCalibrationWorkspaceFreshness(
            request(),
            {
              isPrinterContextFresh: true,
              workspaceState: validWorkspace(),
            },
            () => Promise.resolve(identityMismatch),
          ),
        ).resolves.toBe(false);
      }
    }

    const legacyWorkspace = validWorkspace();
    delete legacyWorkspace.domainState.binding.profileIdentities;
    const offline = new CalibrationHttpError('transport', 'offline');
    await expect(
      resolveCalibrationWorkspaceFreshness(
        request(legacyWorkspace),
        {
          isPrinterContextFresh: true,
          workspaceState: legacyWorkspace,
        },
        () => Promise.reject(offline),
      ),
    ).resolves.toBe(true);
    await expect(
      resolveCalibrationWorkspaceFreshness(request(legacyWorkspace), null, () =>
        Promise.resolve(RemoteCalibrationPrinterContext.parse(exactDto)),
      ),
    ).rejects.toMatchObject({
      code: 'CALIBRATION_PRINTER_CONTEXT_MISMATCH',
    });
  });
});

describe('PrintFarmer Orca profile discovery projection', () => {
  it('projects a complete eligible current context without remote extras', () => {
    const completeCandidate = remoteCandidate({
      name: 'Unrelated candidate name',
      futureRemoteField: 'must not leak',
    });
    const completeContext = RemoteCalibrationPrinterContext.parse(
      contextDto({ futureRemoteField: 'must not leak' }),
    );

    expect(
      projectPrintFarmerOrcaProfile(completeCandidate, completeContext),
    ).toEqual({
      // The immutable server identity, not the display name.
      orcaProfileId: FILAMENT_PROFILE_GUID,
      // The OrcaSlicer-facing name, carried separately so local file lookup
      // has something it can actually match.
      orcaProfileName: 'Upstream PLA',
      displayName: 'Upstream PLA',
      vendor: null,
      material: null,
      source: 'printFarmer',
      upstreamVerified: true,
      printerId: PRINTER_GUID,
      configurationRevision: 7,
      snapshotId: SNAPSHOT_SHA,
      toolId: TOOLHEAD_GUID,
      toolheadId: TOOLHEAD_GUID,
      nozzleId: TOOLHEAD_GUID,
      nozzleDiameterMm: 0.4,
      profileRevision: 'profile-r7',
      contentHash: 'd'.repeat(64),
      exportable: false,
    });
  });

  it('omits incomplete or ineligible contexts regardless of names', () => {
    // Under Path D the candidate-side eligibility verdict (`eligible`,
    // `rejectionReasons`, `missingInputs`) has been retired from the wire.
    // The last remaining candidate-side rejection surface is the enabled /
    // maintenance flag pair the handler filters on; a candidate the wire
    // says is disabled must still refuse to project a profile, and this
    // sub-case is what proves the flag is honoured. The pre-Path-D
    // "misleading printer name overrides the server verdict" scenario is
    // no longer producible because the server no longer produces a verdict.
    const disabledCandidate = remoteCandidate({
      name: 'Klipper OrcaSlicer upstream',
      isEnabled: false,
    });
    const missingRevision = RemoteCalibrationPrinterContext.parse(
      contextDto({
        snapshot: {
          profiles: {
            machine: null,
            process: null,
            filament: {
              id: FILAMENT_PROFILE_GUID,
              kind: 'filament',
              name: 'Upstream PLA',
              slicerType: 'OrcaSlicer',
              slicerDistribution: 'upstream',
              slicerVersion: '2.4.2',
              profileFormat: 'orca-json',
              profileRevision: null,
              sha256: null,
            },
          },
        },
      }),
    );
    const wrongPrinter = RemoteCalibrationPrinterContext.parse(
      contextDto({ id: OTHER_PRINTER_GUID }),
    );

    expect(
      projectPrintFarmerOrcaProfile(
        disabledCandidate,
        RemoteCalibrationPrinterContext.parse(contextDto()),
      ),
    ).toBeNull();
    expect(
      projectPrintFarmerOrcaProfile(remoteCandidate(), missingRevision),
    ).toBeNull();
    expect(
      projectPrintFarmerOrcaProfile(remoteCandidate(), wrongPrinter),
    ).toBeNull();
  });

  it('keeps discovery satisfiable while machine movement stays fail-closed', () => {
    // PrintFarmer's context DTO carries no safety or permission members, so any
    // predicate requiring them is unsatisfiable. Listing a profile must still
    // work against the real DTO, and anything that would move the machine must
    // still refuse — but for a reason that exists, not one that cannot.
    const context = RemoteCalibrationPrinterContext.parse(contextDto());
    expect(isExplicitCalibrationContextComplete(context)).toBe(true);
    // Machine limits the DTO does publish come through, so baselines can be
    // range-checked against real hardware.
    expect(context.safety?.maximumNozzleTemperatureC).toBe(300);
    // The three interlock assertions it does not publish stay false. Absent
    // evidence is never promoted to an assurance.
    expect(context.safety?.emergencyStopAvailable).toBe(false);
    expect(context.safety?.thermalProtectionConfirmed).toBe(false);
    expect(context.safety?.ventilationAssessed).toBe(false);
    // And per-printer permissions genuinely have no counterpart at all.
    expect(context.permissions).toBeNull();

    const capability = {
      grantedScopes: [
        'calibration:read',
        'calibration:create',
        'calibration:update',
        'calibration:generate',
        'slicing:submit',
        'queue:read',
        'queue:write',
        'queue:acknowledge-bed-clear',
        'queue:start',
      ],
      flags: {
        calibrationApiEnabled: true,
        calibrationGenerationEnabled: true,
      },
    };
    const binding = {
      printerId: context.printerId,
      configurationRevision: context.configurationRevision,
      snapshotId: context.snapshotId,
      toolId: context.toolheads[0]?.toolId ?? null,
    };

    // Generation moves nothing, so a complete context plus the exact permission
    // is enough. This is the case the old predicate blocked outright.
    expect(
      evaluateCalibrationActionGate({
        action: 'generate',
        capability,
        context,
        binding,
      }).allowed,
    ).toBe(true);

    // Dispatch refuses without a ledger-backed operator acknowledgement.
    const withoutAcknowledgement = evaluateCalibrationActionGate({
      action: 'acknowledgeBedClear',
      capability,
      context,
      binding,
    });
    expect(withoutAcknowledgement.allowed).toBe(false);
    expect(withoutAcknowledgement.code).toBe('safetyNotAssured');

    // And permits it with one, so the refusal above is a real gate rather than
    // an unsatisfiable condition wearing a gate's name.
    expect(
      evaluateCalibrationActionGate({
        action: 'acknowledgeBedClear',
        capability,
        context,
        binding,
        operatorAcknowledgement: true,
      }).allowed,
    ).toBe(true);
  });
});
