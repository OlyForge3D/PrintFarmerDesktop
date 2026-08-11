// @vitest-environment node

/**
 * Unit and mutation coverage for the calibration action interlock and the
 * bed-clear acknowledgement ledger.
 *
 * ## Why this file exists in this shape
 *
 * The interlock's predecessor was a gate in name only. It called a predicate
 * with no call sites, and its machine-moving branch read
 * `serverAssured || operatorAcknowledgedBedClear` where the first half was
 * permanently false (the context DTO has no safety member) and the second was a
 * boolean the renderer asserted about itself, hardcoded `true` at its one call
 * site. Both halves passed a superficial reading and neither gated anything.
 *
 * So every block code below is proved *reachable* — a gate that can never say no
 * is decoration — and every allow is paired with a mutation showing which single
 * missing piece of evidence turns it into a refusal. A test that only asserted
 * `allowed === true` on a fully-populated input would have passed against the
 * broken gate too.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateCalibrationActionGate,
  type CalibrationGatedAction,
  type CalibrationGateBlockCode,
} from '../src/main/calibrationActionGate.js';
import {
  ACKNOWLEDGEMENT_TTL_MS,
  BedClearAcknowledgementLedger,
} from '../src/main/calibrationBedClearLedger.js';
import { CalibrationSelectionCache } from '../src/main/calibrationSelectionCache.js';
import { RemoteCalibrationPrinterContext } from '../src/main/calibrationWire.js';
import {
  CALIBRATION_FIXTURE_IDS,
  calibrationActionBindingFixture,
  calibrationContextDto,
} from './fixtures/calibrationContract.js';

const context = RemoteCalibrationPrinterContext.parse(calibrationContextDto());

function capability(
  overrides: {
    grantedScopes?: readonly string[] | null;
    flags?: Record<string, boolean>;
  } = {},
) {
  return {
    grantedScopes: overrides.grantedScopes ?? [
      'calibration:read',
      'calibration:create',
      'calibration:update',
      'calibration:generate',
    ],
    flags: {
      calibrationApiEnabled: true,
      calibrationGenerationEnabled: true,
      ...overrides.flags,
    },
  };
}

function allowedInput(action: CalibrationGatedAction) {
  return {
    action,
    capability: capability(),
    context,
    binding: calibrationActionBindingFixture(),
    ...(action === 'acknowledgeBedClear'
      ? { operatorAcknowledgement: true }
      : {}),
  };
}

describe('the interlock permits a fully evidenced action', () => {
  // Control for every refusal below. Without it a gate that refused
  // unconditionally would satisfy the entire rest of this file.
  const actions: CalibrationGatedAction[] = [
    'createProject',
    'generate',
    'startPrint',
    'acknowledgeBedClear',
  ];
  for (const action of actions) {
    it(`allows ${action} when every piece of evidence is present`, () => {
      const result = evaluateCalibrationActionGate(allowedInput(action));
      expect(
        result.allowed,
        `${action} was refused with ${result.code ?? 'no code'}: ${result.message ?? ''}`,
      ).toBe(true);
      expect(result.code).toBeNull();
    });
  }

  it('permits generation against the verbatim real DTO, which has no safety or permissions member', () => {
    // The regression that motivated the whole split. Requiring the absent
    // members made this case unsatisfiable, which read as "calibration is
    // broken" rather than as any deliberate refusal.
    expect(context.safety?.emergencyStopAvailable).toBe(false);
    expect(context.permissions).toBeNull();
    expect(
      evaluateCalibrationActionGate(allowedInput('generate')).allowed,
    ).toBe(true);
  });
});

describe('every block code is reachable', () => {
  const cases: ReadonlyArray<{
    code: CalibrationGateBlockCode;
    input: Parameters<typeof evaluateCalibrationActionGate>[0];
  }> = [
    {
      code: 'capabilityUnknown',
      input: { ...allowedInput('generate'), capability: null },
    },
    {
      code: 'permissionDenied',
      input: {
        ...allowedInput('generate'),
        capability: capability({ grantedScopes: ['calibration:read'] }),
      },
    },
    {
      code: 'capabilityDisabled',
      input: {
        ...allowedInput('generate'),
        capability: capability({ flags: { calibrationApiEnabled: false } }),
      },
    },
    {
      code: 'contextUnavailable',
      input: { ...allowedInput('generate'), context: null },
    },
    {
      code: 'contextIncomplete',
      input: {
        ...allowedInput('generate'),
        context: RemoteCalibrationPrinterContext.parse(
          calibrationContextDto({
            snapshot: {
              profiles: { machine: null, process: null, filament: null },
            },
          }),
        ),
      },
    },
    {
      code: 'contextStale',
      input: {
        ...allowedInput('generate'),
        context: { ...context, isCurrent: false },
      },
    },
    {
      code: 'bindingMismatch',
      input: {
        ...allowedInput('generate'),
        binding: calibrationActionBindingFixture({
          printerId: CALIBRATION_FIXTURE_IDS.otherPrinterId,
        }),
      },
    },
    {
      code: 'safetyNotAssured',
      input: {
        action: 'acknowledgeBedClear',
        capability: capability(),
        context,
        binding: calibrationActionBindingFixture(),
      },
    },
  ];

  for (const { code, input } of cases) {
    it(`refuses with ${code}`, () => {
      const result = evaluateCalibrationActionGate(input);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe(code);
      // The operator-facing text must say something; a refusal nobody can read
      // is the failure mode this whole change exists to remove.
      expect(result.message ?? '').not.toBe('');
    });
  }
});

describe('binding fencing refuses each identity independently', () => {
  const mutations: ReadonlyArray<[string, Record<string, unknown>]> = [
    [
      'a different printer',
      { printerId: CALIBRATION_FIXTURE_IDS.otherPrinterId },
    ],
    ['a superseded configuration revision', { configurationRevision: 99 }],
    ['a snapshot that is no longer current', { snapshotId: 'b'.repeat(64) }],
    ['a tool the printer does not have', { toolId: 'no-such-tool' }],
  ];
  for (const [label, override] of mutations) {
    it(`refuses ${label}`, () => {
      const result = evaluateCalibrationActionGate({
        ...allowedInput('generate'),
        binding: calibrationActionBindingFixture(override),
      });
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('bindingMismatch');
    });
  }

  it('accepts a binding that declines to assert a revision, snapshot or tool', () => {
    // Null means "not claimed", which is different from "claimed wrongly". The
    // caller that supplies nothing is fenced by the printer alone; callers that
    // do supply these values are held to them exactly, as above.
    expect(
      evaluateCalibrationActionGate({
        ...allowedInput('generate'),
        binding: calibrationActionBindingFixture({
          configurationRevision: null,
          snapshotId: null,
          toolId: null,
        }),
      }).allowed,
    ).toBe(true);
  });
});

describe('each action requires its own exact canonical permission', () => {
  const required: ReadonlyArray<[CalibrationGatedAction, string]> = [
    ['createProject', 'calibration:create'],
    ['generate', 'calibration:generate'],
    ['startPrint', 'calibration:update'],
    ['acknowledgeBedClear', 'calibration:update'],
  ];

  for (const [action, permission] of required) {
    it(`${action} refuses when ${permission} is absent and permits when it is present`, () => {
      const without = [
        'calibration:read',
        'calibration:create',
        'calibration:update',
        'calibration:generate',
      ].filter((scope) => scope !== permission);
      const refused = evaluateCalibrationActionGate({
        ...allowedInput(action),
        capability: capability({ grantedScopes: without }),
      });
      expect(refused.allowed).toBe(false);
      expect(refused.code).toBe('permissionDenied');
      expect(refused.message).toContain(permission);
      // Paired positive: the refusal above is about this permission and not
      // about the shortened list generally.
      expect(
        evaluateCalibrationActionGate({
          ...allowedInput(action),
          capability: capability({ grantedScopes: [...without, permission] }),
        }).allowed,
      ).toBe(true);
    });
  }

  it('accepts a legacy spelling only when the server actually advertises it', () => {
    // Recognising a spelling the server sent is not the same as inventing a
    // grant. An account granted nothing still reads as granted nothing.
    expect(
      evaluateCalibrationActionGate({
        ...allowedInput('startPrint'),
        capability: capability({ grantedScopes: ['CalibrationWrite'] }),
      }).allowed,
    ).toBe(true);
    expect(
      evaluateCalibrationActionGate({
        ...allowedInput('startPrint'),
        capability: capability({ grantedScopes: [] }),
      }).allowed,
    ).toBe(false);
  });

  it('never treats the PascalCase vocabulary as satisfying an unrelated action', () => {
    // `CalibrationRead` maps to `calibration:read` and nothing else.
    const result = evaluateCalibrationActionGate({
      ...allowedInput('generate'),
      capability: capability({ grantedScopes: ['CalibrationRead'] }),
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('permissionDenied');
  });
});

describe('bed-clear acknowledgement ledger', () => {
  let clock = 1_000;
  let ledger: BedClearAcknowledgementLedger;
  const binding: {
    profileId: string;
    printerId: string;
    configurationRevision: number | null;
    jobId: string;
    projectId: string | null;
    attemptId: string | null;
    operationId: string;
  } = {
    profileId: CALIBRATION_FIXTURE_IDS.profileId,
    printerId: CALIBRATION_FIXTURE_IDS.printerId,
    configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
    jobId: 'job-1',
    projectId: 'project-1',
    attemptId: 'attempt-1',
    operationId: 'operation-1',
  };

  beforeEach(() => {
    clock = 1_000;
    ledger = new BedClearAcknowledgementLedger(() => clock);
  });

  it('consumes a recorded acknowledgement exactly once', () => {
    ledger.record(binding);
    expect(ledger.consume(binding)).toBe(true);
    // Replay. A dispatch retried with the same operation must not find a second
    // acknowledgement waiting for it.
    expect(ledger.consume(binding)).toBe(false);
  });

  it('refuses an acknowledgement that was never recorded', () => {
    expect(ledger.consume(binding)).toBe(false);
  });

  it('refuses an expired acknowledgement and does not leave it to be retried', () => {
    ledger.record(binding);
    clock += ACKNOWLEDGEMENT_TTL_MS + 1;
    expect(ledger.consume(binding)).toBe(false);
    // Rewinding the clock must not resurrect it: the record was spent by the
    // attempt above, so probing until it looks valid is not possible.
    clock = 1_000;
    expect(ledger.consume(binding)).toBe(false);
  });

  const mismatches: ReadonlyArray<[string, Partial<typeof binding>]> = [
    [
      'a different printer',
      { printerId: CALIBRATION_FIXTURE_IDS.otherPrinterId },
    ],
    ['a different configuration revision', { configurationRevision: 99 }],
    ['a different job', { jobId: 'job-2' }],
    ['a different project', { projectId: 'project-2' }],
    ['a different attempt', { attemptId: 'attempt-2' }],
    ['a different operation', { operationId: 'operation-2' }],
    ['a different server profile', { profileId: 'other-profile' }],
  ];
  for (const [label, override] of mismatches) {
    it(`does not authorise ${label}`, () => {
      ledger.record(binding);
      expect(ledger.consume({ ...binding, ...override })).toBe(false);
      // And the original is still intact, so a near-miss cannot spend it.
      expect(ledger.consume(binding)).toBe(true);
    });
  }

  it('drops expired records when pruned', () => {
    ledger.record(binding);
    clock += ACKNOWLEDGEMENT_TTL_MS + 1;
    ledger.prune();
    expect(ledger.has(binding)).toBe(false);
  });
});

describe('selection cache', () => {
  let clock = 1_000;
  let cache: CalibrationSelectionCache;
  const profileId = CALIBRATION_FIXTURE_IDS.profileId;

  beforeEach(() => {
    clock = 1_000;
    cache = new CalibrationSelectionCache(() => clock);
  });

  it('returns a remembered context for the same printer and revision', () => {
    cache.rememberContext(profileId, context);
    expect(
      cache.context(
        profileId,
        context.printerId,
        CALIBRATION_FIXTURE_IDS.configurationRevision,
      ),
    ).not.toBeNull();
  });

  it('treats a different revision as a miss rather than a hit', () => {
    // The caller asked about one configuration. Answering with another is
    // exactly the confusion the revision fence exists to prevent.
    cache.rememberContext(profileId, context);
    expect(cache.context(profileId, context.printerId, 99)).toBeNull();
  });

  it('never answers for a printer it was not told about', () => {
    cache.rememberContext(profileId, context);
    expect(
      cache.context(profileId, CALIBRATION_FIXTURE_IDS.otherPrinterId),
    ).toBeNull();
  });

  it('never answers across server profiles', () => {
    cache.rememberContext(profileId, context);
    expect(cache.context('another-profile', context.printerId)).toBeNull();
  });

  it('expires observations rather than holding them indefinitely', () => {
    cache.rememberContext(profileId, context);
    clock += 60_000;
    expect(cache.context(profileId, context.printerId)).toBeNull();
  });

  it('forgets everything for a profile whose binding changed', () => {
    cache.rememberContext(profileId, context);
    cache.forgetProfile(profileId);
    expect(cache.context(profileId, context.printerId)).toBeNull();
  });
});
