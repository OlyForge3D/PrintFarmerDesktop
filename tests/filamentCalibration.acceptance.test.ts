/**
 * Filament-calibration acceptance suite (owner reframe 2026-08-23).
 *
 * The tests below assert **observable operator outcomes** against the
 * `FakeFilamentCalibrationServer` fixture. Every fixture DTO is a
 * transcription of a real server shape at a cited commit; see the header of
 * `fakeFilamentCalibrationServer.ts`. Nothing in this file asserts on the
 * arguments the desktop passed to its own methods — that is exactly the
 * cargo-cult shape the owner brief warned against, and the same one that let
 * three prior PRs merge green on top of a dead feature.
 *
 * ## Method
 *
 * Each positive assertion is paired with a **matching-predicate control**
 * (`.squad/known-lying-commands.md`, §"The rule") that must return the
 * opposite result when evaluated against the opposite data by the same
 * predicate. Controls appear inline as `it(... 'control: ...')` cases.
 *
 * ## Blocked-on
 *
 * Bishop is landing the calibration slice-pipeline IPC channels and the
 * matching `CalibrationHttpClient` methods on
 * `dev-bishop-filament-calibration-channels`. Until those land, EVERY test
 * in this file is EXPECTED to fail — the `describe` block runs, but each
 * `it` calls a client method that does not yet exist. This is deliberate:
 * the acceptance gate must fail *now* and pass *only* when the desktop can
 * genuinely take a spool through the wiki workflow. See
 * `.squad/decisions/inbox/hicks-filament-calibration-acceptance.md`.
 *
 * The tests are agnostic to Bishop's chosen client method names — a bindings
 * shim at the top of this file adapts the naming Bishop lands to the seven
 * verbs the operator flow needs. When Bishop's shape differs from the shim's
 * probing, the failure is a clear `Error: CalibrationHttpClient does not
 * expose <verb>` rather than a mysterious runtime exception.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  CalibrationHttpClient,
  type CalibrationTokenProvider,
} from '../src/main/calibrationHttp.js';
import {
  FakeFilamentCalibrationServer,
  SUPPORTED_CALIBRATION_METHODS,
  sampleBaseFilamentProfile,
  canonicalJson,
  type FakeProfileRecord,
  type SupportedCalibrationMethod,
} from './fixtures/fakeFilamentCalibrationServer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_URL = 'http://farm.local';
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PRINTER_ID = '33333333-3333-4333-8333-333333333333';
const BINDING = 'binding-hicks-acceptance';

function stableTokens(): CalibrationTokenProvider {
  return {
    getAuthenticatedContext: () =>
      Promise.resolve({
        baseUrl: BASE_URL,
        token: 'test-jwt',
        binding: BINDING,
      }),
  };
}

// ---------------------------------------------------------------------------
// CalibrationHttpClient extension probe
// ---------------------------------------------------------------------------
//
// The seven operator verbs the wiki workflow needs. Bishop is expected to add
// them to `CalibrationHttpClient` in one form or another; the probe below is
// agnostic to the exact names he picks. When a verb has not been landed yet,
// the probe returns a stub that throws a descriptive `Error` — every test
// then fails loudly with the missing-verb name in the message, rather than
// with a generic `TypeError: client.foo is not a function`.
//
// This is the seam that flips from "fail today" to "pass when landed".

type CloneRequest = {
  sourceProfileId: string;
  profileType: 'machine' | 'filament' | 'process';
  name: string | null;
};
type CloneResponse = {
  id: string;
  name: string;
  profileType: string;
  isSystem: boolean;
};

type SubmitRequest = {
  userId: string;
  printerId: string;
  slicerProfileJson: string;
  method: SupportedCalibrationMethod;
  params?: Record<string, number> | null;
  idempotencyKey?: string | null;
};
type SubmitResponse = { jobId: string; status: string; queuedAt: string };

type SliceStatus = {
  id: string;
  status: 'Queued' | 'Processing' | 'Completed' | 'Failed';
  failureReason: string | null;
  failureHint: string | null;
  errorMessage: string | null;
};

type SendToPrinterRequest = { printerId: string; startPrint: boolean };
type SendToPrinterResponse = {
  jobId: string;
  printerId: string;
  fileName: string;
  printStarted: boolean;
};

type UpdateCustomRequest = { rawJson: string | null; name: string | null };
type UpdateCustomResponse = {
  id: string;
  name: string;
  profileType: string;
  isSystem: boolean;
};

interface OperatorBindings {
  cloneFilamentProfile: (req: CloneRequest) => Promise<CloneResponse>;
  submitCalibrationSlice: (req: SubmitRequest) => Promise<SubmitResponse>;
  getSliceJobStatus: (jobId: string) => Promise<SliceStatus>;
  sendSliceToPrinter: (
    jobId: string,
    req: SendToPrinterRequest,
  ) => Promise<SendToPrinterResponse>;
  updateCustomProfile: (
    id: string,
    req: UpdateCustomRequest,
  ) => Promise<UpdateCustomResponse>;
}

/**
 * Bind the acceptance suite to whatever calibration-slice verbs Bishop has
 * landed on `CalibrationHttpClient`. Every verb has a set of candidate names
 * Bishop is likely to pick; if none exist, the returned binding throws a
 * clear error naming the missing verb the first time a test tries to use it.
 *
 * This is what makes the suite fail-now / pass-when-landed: today all seven
 * probes fall through to the missing-verb error; when Bishop's PR lands, the
 * probes find the real methods and the tests advance to their observable-
 * outcome assertions.
 */
function bindOperatorFlow(client: CalibrationHttpClient): OperatorBindings {
  const clientAny = client as any;
  const signal = () => AbortSignal.timeout(30_000);
  const missing = (verb: string) => () => {
    throw new Error(
      `CalibrationHttpClient does not expose ${verb}: blocked on ` +
        `dev-bishop-filament-calibration-channels landing.`,
    );
  };

  // For each verb, try the candidate method names in order.
  const pick = <T>(candidates: readonly string[], verb: string): T => {
    for (const c of candidates) {
      if (typeof clientAny[c] === 'function') {
        return ((...args: unknown[]) =>
          clientAny[c].call(client, ...args)) as unknown as T;
      }
    }
    return missing(verb) as unknown as T;
  };

  // The candidate names below are ordered by likelihood, then alphabetical.
  const cloneFn = pick<
    (
      profileId: string,
      baseUrl: string,
      req: CloneRequest,
      signal: AbortSignal,
    ) => Promise<CloneResponse>
  >(
    ['cloneFilamentProfile', 'cloneSingleProfile', 'postCloneProfile'],
    'cloneFilamentProfile',
  );
  const submitFn = pick<
    (
      profileId: string,
      baseUrl: string,
      req: SubmitRequest,
      signal: AbortSignal,
    ) => Promise<SubmitResponse>
  >(
    ['submitCalibrationSlice', 'submitSlice', 'postSlice'],
    'submitCalibrationSlice',
  );
  const statusFn = pick<
    (
      profileId: string,
      baseUrl: string,
      jobId: string,
      signal: AbortSignal,
    ) => Promise<SliceStatus>
  >(['getSliceJobStatus', 'getSliceJob', 'getSlice'], 'getSliceJobStatus');
  const sendFn = pick<
    (
      profileId: string,
      baseUrl: string,
      jobId: string,
      req: SendToPrinterRequest,
      signal: AbortSignal,
    ) => Promise<SendToPrinterResponse>
  >(
    ['sendSliceToPrinter', 'sendToPrinter', 'postSendToPrinter'],
    'sendSliceToPrinter',
  );
  const updateFn = pick<
    (
      profileId: string,
      baseUrl: string,
      id: string,
      req: UpdateCustomRequest,
      signal: AbortSignal,
    ) => Promise<UpdateCustomResponse>
  >(['updateCustomProfile', 'putCustomProfile'], 'updateCustomProfile');

  return {
    cloneFilamentProfile: (req) => cloneFn(PROFILE_ID, BASE_URL, req, signal()),
    submitCalibrationSlice: (req) =>
      submitFn(PROFILE_ID, BASE_URL, req, signal()),
    getSliceJobStatus: (jobId) =>
      statusFn(PROFILE_ID, BASE_URL, jobId, signal()),
    sendSliceToPrinter: (jobId, req) =>
      sendFn(PROFILE_ID, BASE_URL, jobId, req, signal()),
    updateCustomProfile: (id, req) =>
      updateFn(PROFILE_ID, BASE_URL, id, req, signal()),
  };
}

// ---------------------------------------------------------------------------
// The operator flow driver
// ---------------------------------------------------------------------------
//
// A minimal in-line orchestration of the OrcaSlicer-wiki workflow the owner
// described. The driver is deliberately small: the acceptance test is the
// gate, and the driver is only what the operator visibly does. The renderer
// UI Dallas is landing will drive the same seven verbs; the driver here is
// what a screen-reader-narrated walkthrough would produce.

interface OperatorFlowInputs {
  readonly server: FakeFilamentCalibrationServer;
  readonly bindings: OperatorBindings;
  readonly baseProfileId: string;
  readonly baseMachineName: string;
  readonly processProfileName: string;
  readonly newProfileName: string;
  readonly method: SupportedCalibrationMethod;
  /**
   * Whether the operator opted in to `startPrint` at the send-to-printer
   * step. The `startPrint` is operator-driven and MUST default false; the
   * "operator-driven" test drives both branches.
   */
  readonly startPrint: boolean;
  readonly measurement: number;
  /** Optional idempotency key for the submit-slice step. */
  readonly idempotencyKey?: string;
}

interface OperatorFlowResult {
  readonly clonedProfileId: string;
  readonly jobId: string;
  readonly finalStatus: SliceStatus['status'];
  readonly failureHint: string | null;
  readonly sendResponse: SendToPrinterResponse | null;
}

async function runOperatorFlow(
  input: OperatorFlowInputs,
): Promise<OperatorFlowResult> {
  // 1. Clone the picked base filament profile under the operator's new
  //    per-spool name. This is the "rename it to match the filament they
  //    are calibrating" step in the owner brief.
  const clone = await input.bindings.cloneFilamentProfile({
    sourceProfileId: input.baseProfileId,
    profileType: 'filament',
    name: input.newProfileName,
  });

  // 2. Submit the calibration-mode slice. Carries the machine/process/
  //    filament profile trio in `slicerProfileJson` and the wiki-step wire
  //    name in `calibration.method`. Explicitly OMITS every saga field —
  //    the raw JSON body will not contain those keys.
  const slicerProfileJson = JSON.stringify({
    machineProfileName: input.baseMachineName,
    processProfileName: input.processProfileName,
    filamentProfileName: input.newProfileName,
  });
  const submit = await input.bindings.submitCalibrationSlice({
    userId: USER_ID,
    printerId: PRINTER_ID,
    slicerProfileJson,
    method: input.method,
    idempotencyKey: input.idempotencyKey ?? null,
  });

  // 3. Poll to terminal outcome. A real poller has bounds; this driver caps
  //    at a modest attempt count so a runaway server would surface as a
  //    test-suite hang rather than a green pass.
  let last: SliceStatus | null = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    last = await input.bindings.getSliceJobStatus(submit.jobId);
    if (last.status === 'Completed' || last.status === 'Failed') {
      break;
    }
  }
  if (last === null) {
    throw new Error('poll returned no observations');
  }
  if (last.status === 'Failed') {
    return {
      clonedProfileId: clone.id,
      jobId: submit.jobId,
      finalStatus: 'Failed',
      failureHint: last.failureHint,
      sendResponse: null,
    };
  }

  // 4. Send to printer. `startPrint` is operator-driven — the driver
  //    threads the caller's explicit value through without defaulting.
  const send = await input.bindings.sendSliceToPrinter(submit.jobId, {
    printerId: PRINTER_ID,
    startPrint: input.startPrint,
  });

  // 5. Operator measures the print and provides a correction. In a real UI
  //    this is a form; here the driver applies the correction and writes
  //    it back onto the CLONED filament profile. NEVER the source.
  const clonedRecord = input.server.profileById(clone.id);
  if (clonedRecord === undefined) {
    throw new Error(`cloned profile ${clone.id} not found in server`);
  }
  const patchedRawJson = applyMeasurement(
    clonedRecord.rawJson,
    input.method,
    input.measurement,
  );
  await input.bindings.updateCustomProfile(clone.id, {
    rawJson: JSON.stringify(patchedRawJson),
    name: null,
  });

  return {
    clonedProfileId: clone.id,
    jobId: submit.jobId,
    finalStatus: last.status,
    failureHint: null,
    sendResponse: send,
  };
}

/**
 * Apply a measurement to a filament profile JSON — the write-back the
 * operator does after "print and analyze". Matches the OrcaSlicer wire:
 * `filament_flow_ratio` and `nozzle_temperature` are arrays of string
 * numbers (`src/main/orcaProfileGenerator.ts` handles the same shape for
 * the retired generation path).
 */
function applyMeasurement(
  rawJson: Record<string, unknown>,
  method: SupportedCalibrationMethod,
  measurement: number,
): Record<string, unknown> {
  const next = { ...rawJson };
  if (method === 'flow_rate_pass_1' || method === 'flow_rate_pass_2') {
    next['filament_flow_ratio'] = [measurement.toFixed(3)];
    return next;
  }
  // temperature_tower
  const existing = next['nozzle_temperature'];
  const others = Array.isArray(existing)
    ? existing.slice(1).map((v) => String(v))
    : [];
  next['nozzle_temperature'] = [
    String(Math.round(measurement)),
    ...(others.length > 0 ? others : [String(Math.round(measurement))]),
  ];
  next['nozzle_temperature_initial_layer'] = [String(Math.round(measurement))];
  return next;
}

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function makeServer(
  opts: ConstructorParameters<typeof FakeFilamentCalibrationServer>[0] = {},
) {
  const server = new FakeFilamentCalibrationServer(opts);
  server.setNow(() => new Date('2026-08-24T14:00:00.000Z'));
  return server;
}

function makeClient(server: FakeFilamentCalibrationServer) {
  return new CalibrationHttpClient(stableTokens(), {
    fetch: server.fetch,
    timeoutMs: 30_000,
    connectTimeoutMs: 30_000,
    maxResponseBytes: 4 * 1024 * 1024,
    now: () => Date.now(),
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  });
}

interface HarnessedTest {
  server: FakeFilamentCalibrationServer;
  bindings: OperatorBindings;
  baseProfileId: string;
  baseMachineName: string;
  processProfileName: string;
}

function setupHarness(
  opts: ConstructorParameters<typeof FakeFilamentCalibrationServer>[0] = {},
): HarnessedTest {
  const server = makeServer(opts);
  const client = makeClient(server);
  const bindings = bindOperatorFlow(client);
  const baseSystemProfile = server.addSystemProfile(
    'Generic PLA @ K1 Max 0.4',
    'filament',
    sampleBaseFilamentProfile(),
  );
  const baseMachineName = 'K1 Max 0.4';
  const processProfileName = '0.20mm Standard @ K1 Max 0.4';
  return {
    server,
    bindings,
    baseProfileId: baseSystemProfile.id,
    baseMachineName,
    processProfileName,
  };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('Filament calibration — acceptance', () => {
  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------
  describe('the happy path — an operator can calibrate a spool', () => {
    it('the corrected flow ratio lands on the cloned filament profile', async () => {
      const h = setupHarness();
      const measurement = 1.02;
      const outcome = await runOperatorFlow({
        server: h.server,
        bindings: h.bindings,
        baseProfileId: h.baseProfileId,
        baseMachineName: h.baseMachineName,
        processProfileName: h.processProfileName,
        newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
        method: 'flow_rate_pass_1',
        startPrint: false,
        measurement,
      });

      expect(outcome.finalStatus).toBe('Completed');

      // Observable outcome #1: the cloned profile's `filament_flow_ratio`
      // is the corrected value.
      const clone = h.server.profileById(outcome.clonedProfileId);
      expect(clone).toBeDefined();
      const correctedFlow = (clone as FakeProfileRecord).rawJson[
        'filament_flow_ratio'
      ];
      expect(Array.isArray(correctedFlow)).toBe(true);
      expect((correctedFlow as unknown[])[0]).toBe('1.020');

      // Observable outcome #2: the print was sent to the printer.
      expect(h.server.printSubmissions()).toHaveLength(1);
      expect(h.server.printSubmissions()[0]?.printerId).toBe(PRINTER_ID);
    });

    it('control: the same predicate reports the WRONG value when the write-back does not land', async () => {
      // Empirical proof that the assertion above discriminates the
      // absent-behaviour case. Set up an identical harness, run the
      // driver up to the write-back, and then read the profile back —
      // the untouched clone must still read `0.98`, not the corrected
      // `1.020`. If the assertion did not discriminate, this control
      // would pass with the corrected value as well.
      const h = setupHarness();
      const clone = await h.bindings.cloneFilamentProfile({
        sourceProfileId: h.baseProfileId,
        profileType: 'filament',
        name: 'MyBrand Silky PLA (K1 Max 0.4)',
      });
      // Deliberately do NOT invoke updateCustomProfile — this is the
      // absent-behaviour case.
      const clonedRecord = h.server.profileById(clone.id);
      const untouched = (clonedRecord as FakeProfileRecord).rawJson[
        'filament_flow_ratio'
      ];
      expect(Array.isArray(untouched)).toBe(true);
      expect((untouched as unknown[])[0]).toBe('0.98');
      // The paired assertion in the happy path reads `1.020`; this control
      // reading `0.98` is the opposite result on the same predicate.
    });
  });

  // -------------------------------------------------------------------------
  // 2. Clone-isolation — the source is never mutated
  // -------------------------------------------------------------------------
  describe('the clone is what gets modified — never the source', () => {
    it('the source profile is byte-identical after the write-back', async () => {
      const h = setupHarness();
      const initialSourceSha = h.server.initialShaOf(h.baseProfileId);
      expect(initialSourceSha).toBeDefined();

      await runOperatorFlow({
        server: h.server,
        bindings: h.bindings,
        baseProfileId: h.baseProfileId,
        baseMachineName: h.baseMachineName,
        processProfileName: h.processProfileName,
        newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
        method: 'flow_rate_pass_1',
        startPrint: false,
        measurement: 1.02,
      });

      // Observable outcome: read the source profile back and confirm it
      // still hashes to its initial content. A shallow-clone bug in the
      // desktop would silently mutate this row.
      const sourceAfter = h.server.profileById(h.baseProfileId);
      expect(sourceAfter).toBeDefined();
      expect((sourceAfter as FakeProfileRecord).contentSha256).toBe(
        initialSourceSha,
      );
      expect((sourceAfter as FakeProfileRecord).isSystem).toBe(true);

      // A cloned custom profile exists distinct from the source.
      const customs = h.server
        .allProfiles()
        .filter((p) => p.isSystem === false);
      expect(customs).toHaveLength(1);
      expect(customs[0]?.id).not.toBe(h.baseProfileId);
    });

    it('control: the same predicate reports MUTATED when the clone accidentally references the source', async () => {
      // Empirical proof of discrimination. The fake server can be
      // switched to a mode where the clone endpoint returns the source
      // id. A driver that then writes the correction targets the source
      // row directly. This test asserts that the SAME predicate — read
      // the source sha256 back, compare against initial — catches the
      // mutation. If it did not, the clone-isolation guarantee would be
      // an assertion the desktop could quietly break with no CI signal.
      const h = setupHarness();
      const initialSourceSha = h.server.initialShaOf(h.baseProfileId);
      h.server.setDiscriminationMode('clone-returns-source-id');

      // Run only through the write-back step; the flow's other assertions
      // do not need to reach the print submission here.
      const clone = await h.bindings.cloneFilamentProfile({
        sourceProfileId: h.baseProfileId,
        profileType: 'filament',
        name: 'MyBrand Silky PLA (K1 Max 0.4)',
      });
      const patched = applyMeasurement(
        sampleBaseFilamentProfile(),
        'flow_rate_pass_1',
        1.02,
      );
      // Server refuses to update a system profile via the custom
      // endpoint in `faithful` mode. Flip to the "update mutates
      // source" mode to complete the discrimination proof: this is the
      // pathological branch where a shallow-clone bug would land.
      h.server.setDiscriminationMode('update-mutates-source');
      await h.bindings.updateCustomProfile(clone.id, {
        rawJson: JSON.stringify(patched),
        name: null,
      });

      // Same predicate as the positive test above, opposite data (the
      // deliberately-broken driver): reads MUTATED sha256, so the
      // assertion catches the drift.
      const sourceAfter = h.server.profileById(h.baseProfileId);
      expect((sourceAfter as FakeProfileRecord).contentSha256).not.toBe(
        initialSourceSha,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Unsupported method: actionable, not a generic slice failure
  // -------------------------------------------------------------------------
  describe('unsupported_calibration_method is actionable', () => {
    it('the operator sees the supported-method list, not a generic slice error', async () => {
      const h = setupHarness();
      // No matter what the desktop's client is called, an unknown method
      // must be refused at the API boundary — not silently downgraded to
      // an ordinary slice, and not surfaced as a poll-time failure.
      let caught: unknown = null;
      try {
        await h.bindings.submitCalibrationSlice({
          userId: USER_ID,
          printerId: PRINTER_ID,
          slicerProfileJson: JSON.stringify({
            machineProfileName: h.baseMachineName,
            processProfileName: h.processProfileName,
            filamentProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
          }),
          // Deliberately unsupported — PA Pattern / PA Line are
          // documented as intentionally out of scope for PR #1952.
          method: 'pa_pattern' as unknown as SupportedCalibrationMethod,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      // Observable outcome: the error's actionable string names the
      // wire-supported set. Reading the specific error code out of the
      // desktop's error hierarchy is coupled to Bishop's error mapping,
      // so this assertion reads the operator-facing message text, which
      // is what actually appears in the wizard.
      const message =
        caught instanceof Error
          ? caught.message
          : typeof caught === 'string'
            ? caught
            : String(caught);
      for (const method of SUPPORTED_CALIBRATION_METHODS) {
        expect(message).toContain(method);
      }
      // And: no slice job was created for the bad submission — the
      // failure did not enter the polling loop.
      expect(h.server.sliceJobsList()).toHaveLength(0);
    });

    it('control: the same predicate reports the message DOES contain the wire names for a supported method', async () => {
      // Same predicate — search the error / message for wire names —
      // against the opposite data (a supported method that succeeds
      // through). Silently, this test also proves that a happy-path
      // submission's return value is NOT an error object whose message
      // happens to contain the wire names — otherwise every test would
      // pass this assertion vacuously.
      const h = setupHarness();
      const submit = await h.bindings.submitCalibrationSlice({
        userId: USER_ID,
        printerId: PRINTER_ID,
        slicerProfileJson: '{"machineProfileName":"K1 Max 0.4"}',
        method: 'flow_rate_pass_1',
      });
      // The response payload is NOT an error. Reading the same substring
      // predicate against `JSON.stringify(submit)` must NOT find the
      // three-method inventory — because there is no error to catalog.
      const serialised = JSON.stringify(submit);
      const containsAll = SUPPORTED_CALIBRATION_METHODS.every((m) =>
        serialised.includes(m),
      );
      expect(containsAll).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Terminal slice failure surfaces (not an infinite poll)
  // -------------------------------------------------------------------------
  describe('a terminal slice failure surfaces an actionable error', () => {
    it('the operator sees Failed with a hint, not an infinite poll', async () => {
      const h = setupHarness();
      // Prime the next job to fail on its first poll.
      h.server.failNextJob({
        failureReason: 'SlicingEngineRejectedModel',
        failureHint:
          'The slicing engine could not process this calibration model. ' +
          'Confirm the printer profile matches the loaded filament.',
        errorMessage: '(worker-local diagnostic, never returned to the client)',
      });
      const outcome = await runOperatorFlow({
        server: h.server,
        bindings: h.bindings,
        baseProfileId: h.baseProfileId,
        baseMachineName: h.baseMachineName,
        processProfileName: h.processProfileName,
        newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
        method: 'flow_rate_pass_1',
        startPrint: false,
        measurement: 1.02,
      });

      expect(outcome.finalStatus).toBe('Failed');
      // Observable outcome: the operator sees the actionable server-
      // classified hint, not the worker-local diagnostic.
      expect(outcome.failureHint).toContain('slicing engine');
      // The send-to-printer step never runs on a failed slice.
      expect(h.server.printSubmissions()).toHaveLength(0);
    });

    it('control: the same predicate reports Completed on a job that is not failed', async () => {
      const h = setupHarness();
      const outcome = await runOperatorFlow({
        server: h.server,
        bindings: h.bindings,
        baseProfileId: h.baseProfileId,
        baseMachineName: h.baseMachineName,
        processProfileName: h.processProfileName,
        newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
        method: 'flow_rate_pass_1',
        startPrint: false,
        measurement: 1.02,
      });
      // Same predicate — read `finalStatus`, read `failureHint`,
      // read the print submissions count — against the opposite data
      // (a healthy job). Discriminates.
      expect(outcome.finalStatus).toBe('Completed');
      expect(outcome.failureHint).toBeNull();
      expect(h.server.printSubmissions()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 5. No saga identifiers on the wire
  // -------------------------------------------------------------------------
  describe('no calibration-projects saga identifiers reach the wire', () => {
    it('the wire body contains none of the three saga keys', async () => {
      const h = setupHarness();
      await runOperatorFlow({
        server: h.server,
        bindings: h.bindings,
        baseProfileId: h.baseProfileId,
        baseMachineName: h.baseMachineName,
        processProfileName: h.processProfileName,
        newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
        method: 'flow_rate_pass_1',
        startPrint: false,
        measurement: 1.02,
      });

      const jobs = h.server.sliceJobsList();
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      expect(job).toBeDefined();
      // Observable outcome: `Object.prototype.hasOwnProperty` on the
      // parsed body — a key with `null` value would still register as
      // present. Absence, not falsiness, is the property.
      expect(job?.calibrationProjectIdPresent).toBe(false);
      expect(job?.calibrationAttemptIdPresent).toBe(false);
      expect(job?.calibrationOrchestrationIdPresent).toBe(false);
      // Sanity: the raw request text also has no matches for the three
      // keys. A substring scan complements the parsed-key check because
      // `hasOwnProperty` cannot distinguish a `null` value from an
      // absent key when the two go through a permissive serialiser.
      expect(job?.rawRequest.rawJson).not.toContain('calibrationProjectId');
      expect(job?.rawRequest.rawJson).not.toContain('calibrationAttemptId');
      expect(job?.rawRequest.rawJson).not.toContain(
        'calibrationOrchestrationId',
      );
    });

    it('control: the same predicate reports PRESENT for the calibration block', async () => {
      // Same predicate — `hasOwnProperty` / substring — against the
      // opposite data (the `calibration` block, which MUST be present).
      // Proves the predicate can register presence at all; a predicate
      // that always returned `absent` would look identical to the
      // positive test and provide no evidence.
      const h = setupHarness();
      await runOperatorFlow({
        server: h.server,
        bindings: h.bindings,
        baseProfileId: h.baseProfileId,
        baseMachineName: h.baseMachineName,
        processProfileName: h.processProfileName,
        newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
        method: 'flow_rate_pass_1',
        startPrint: false,
        measurement: 1.02,
      });
      const job = h.server.sliceJobsList()[0];
      expect(job).toBeDefined();
      expect(job?.rawRequest.rawJson).toContain('calibration');
      // The reciprocal predicate: `hasOwnProperty` on the parsed body
      // for `calibration` (via a re-parse of the raw text — the parsed
      // form on the record is what the server saw).
      const reparsed = JSON.parse(job?.rawRequest.rawJson ?? '{}') as Record<
        string,
        unknown
      >;
      expect(
        Object.prototype.hasOwnProperty.call(reparsed, 'calibration'),
      ).toBe(true);
    });

    it('a calibration request with saga IDs is refused at the boundary', async () => {
      // A different guarantee, verified by the same server: even if the
      // desktop somehow attaches a saga id, the API rejects. This is the
      // upstream-side of the guarantee — the presence of the guard is
      // what makes the client-side `absence` a defence-in-depth property
      // and not the only defence.
      const h = setupHarness();
      // Bypass the driver and post the request directly with a saga id.
      const res = await h.server.fetch(`${BASE_URL}/api/slice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: USER_ID,
          printerId: PRINTER_ID,
          slicerEngine: 'OrcaSlicer',
          slicerProfileJson: '{}',
          calibration: { method: 'flow_rate_pass_1' },
          calibrationProjectId: '99999999-9999-4999-8999-999999999999',
        }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['errorCode']).toBe(
        'calibration_mode_conflicts_with_saga_ids',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. `startPrint` is operator-driven — never defaulted `true`
  // -------------------------------------------------------------------------
  describe('startPrint is operator-driven', () => {
    it('the default flow sends startPrint=false (upload only)', async () => {
      const h = setupHarness();
      await runOperatorFlow({
        server: h.server,
        bindings: h.bindings,
        baseProfileId: h.baseProfileId,
        baseMachineName: h.baseMachineName,
        processProfileName: h.processProfileName,
        newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
        method: 'flow_rate_pass_1',
        startPrint: false,
        measurement: 1.02,
      });
      const submissions = h.server.printSubmissions();
      expect(submissions).toHaveLength(1);
      const parsedBody = submissions[0]?.rawRequest.parsed;
      // Observable outcome: the wire body carries `startPrint === false`
      // when the operator has NOT opted in.
      expect(parsedBody?.['startPrint']).toBe(false);
      // The response's `printStarted` echoes the request; the server
      // never lies about whether a print started.
      expect(submissions[0]?.startPrint).toBe(false);
    });

    it('control: the same predicate reports true when the operator DID opt in', async () => {
      // Same predicate — read `startPrint` off the wire body — against
      // the opposite data. Two distinct submissions can be told apart
      // by this predicate; that is what proves the predicate is
      // discriminating.
      const h = setupHarness();
      await runOperatorFlow({
        server: h.server,
        bindings: h.bindings,
        baseProfileId: h.baseProfileId,
        baseMachineName: h.baseMachineName,
        processProfileName: h.processProfileName,
        newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
        method: 'flow_rate_pass_1',
        startPrint: true,
        measurement: 1.02,
      });
      const submissions = h.server.printSubmissions();
      expect(submissions).toHaveLength(1);
      const parsedBody = submissions[0]?.rawRequest.parsed;
      expect(parsedBody?.['startPrint']).toBe(true);
      expect(submissions[0]?.startPrint).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Step sequencing — next step uses the updated profile
  // -------------------------------------------------------------------------
  describe('step sequencing carries the updated profile forward', () => {
    it('a second step reads the corrected value the first step wrote back', async () => {
      const h = setupHarness();
      // Step 1: flow rate pass 1. Correct the flow ratio from 0.98 to
      // 1.02.
      const step1 = await runOperatorFlow({
        server: h.server,
        bindings: h.bindings,
        baseProfileId: h.baseProfileId,
        baseMachineName: h.baseMachineName,
        processProfileName: h.processProfileName,
        newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
        method: 'flow_rate_pass_1',
        startPrint: false,
        measurement: 1.02,
      });
      expect(step1.finalStatus).toBe('Completed');

      // Between steps, read the cloned profile back — this is what the
      // wizard does when it advances the operator to the next step.
      const afterStep1 = h.server.profileById(step1.clonedProfileId);
      expect(afterStep1).toBeDefined();
      expect(
        (
          (afterStep1 as FakeProfileRecord).rawJson[
            'filament_flow_ratio'
          ] as unknown[]
        )[0],
      ).toBe('1.020');

      // Step 2 is a temperature tower against the SAME cloned profile.
      // The wizard should reuse the clone id, not re-clone from source.
      // The measurement here is a temperature.
      const step2Measurement = 210;
      const step2Result = await singleStepAgainstClone(
        h,
        step1.clonedProfileId,
        'temperature_tower',
        step2Measurement,
      );
      expect(step2Result.finalStatus).toBe('Completed');

      // Observable outcome: after step 2, the clone still has the step-1
      // flow-ratio correction AND the new temperature. Nothing overwrote
      // step 1's work.
      const afterStep2 = h.server.profileById(step1.clonedProfileId);
      expect(afterStep2).toBeDefined();
      const flowAfter2 = (afterStep2 as FakeProfileRecord).rawJson[
        'filament_flow_ratio'
      ];
      expect((flowAfter2 as unknown[])[0]).toBe('1.020');
      const tempsAfter2 = (afterStep2 as FakeProfileRecord).rawJson[
        'nozzle_temperature'
      ];
      expect((tempsAfter2 as unknown[])[0]).toBe('210');
    });

    it('control: the same predicate reports the STALE value when step 2 is fed a re-cloned-from-source profile', async () => {
      // Discriminating control: if the wizard were to re-clone from the
      // source between steps, step 2's write-back would land on a NEW
      // clone whose starting `filament_flow_ratio` is the original
      // `0.98`, not the corrected `1.020`. The same predicate — read
      // the clone's flow-ratio after step 2 — reads `0.98` in that
      // pathological case.
      const h = setupHarness();
      const step1 = await runOperatorFlow({
        server: h.server,
        bindings: h.bindings,
        baseProfileId: h.baseProfileId,
        baseMachineName: h.baseMachineName,
        processProfileName: h.processProfileName,
        newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
        method: 'flow_rate_pass_1',
        startPrint: false,
        measurement: 1.02,
      });
      // Simulate the buggy wizard: re-clone from source for step 2.
      const badClone = await h.bindings.cloneFilamentProfile({
        sourceProfileId: h.baseProfileId,
        profileType: 'filament',
        name: 'MyBrand Silky PLA (K1 Max 0.4) [BAD RE-CLONE]',
      });
      // Only apply the temperature — do not carry the flow ratio.
      const rawJson = h.server.profileById(badClone.id) as FakeProfileRecord;
      const patched = applyMeasurement(
        rawJson.rawJson,
        'temperature_tower',
        210,
      );
      await h.bindings.updateCustomProfile(badClone.id, {
        rawJson: JSON.stringify(patched),
        name: null,
      });

      // Same predicate as the positive test — read the flow ratio on
      // the profile that step 2 landed on — reads STALE `0.98`. Proves
      // the discriminating power.
      const step1Ratio = (
        h.server.profileById(step1.clonedProfileId) as FakeProfileRecord
      ).rawJson['filament_flow_ratio'];
      const step2Ratio = (
        h.server.profileById(badClone.id) as FakeProfileRecord
      ).rawJson['filament_flow_ratio'];
      expect((step1Ratio as unknown[])[0]).toBe('1.020');
      expect((step2Ratio as unknown[])[0]).toBe('0.98');
    });
  });

  // -------------------------------------------------------------------------
  // 8. Idempotency — no duplicate jobs or duplicate physical prints
  // -------------------------------------------------------------------------
  describe('idempotency: a resubmit does not duplicate jobs or prints', () => {
    it('a repeated submit with the same idempotency key returns the same jobId', async () => {
      const h = setupHarness();
      const clone = await h.bindings.cloneFilamentProfile({
        sourceProfileId: h.baseProfileId,
        profileType: 'filament',
        name: 'MyBrand Silky PLA (K1 Max 0.4)',
      });
      void clone;
      const key = '77777777-7777-4777-8777-777777777777';
      const first = await h.bindings.submitCalibrationSlice({
        userId: USER_ID,
        printerId: PRINTER_ID,
        slicerProfileJson: '{"machineProfileName":"K1 Max 0.4"}',
        method: 'flow_rate_pass_1',
        idempotencyKey: key,
      });
      const second = await h.bindings.submitCalibrationSlice({
        userId: USER_ID,
        printerId: PRINTER_ID,
        slicerProfileJson: '{"machineProfileName":"K1 Max 0.4"}',
        method: 'flow_rate_pass_1',
        idempotencyKey: key,
      });
      // Observable outcome: only one job exists in the server, and both
      // submissions return the same jobId. Physical prints are guarded
      // by this same idempotency: no duplicate slice → no duplicate
      // gcode → no duplicate print.
      expect(first.jobId).toBe(second.jobId);
      expect(h.server.sliceJobsList()).toHaveLength(1);
      expect(h.server.idempotencyRegistrations()).toBe(1);
    });

    it('control: the same predicate reports TWO jobs when idempotency keys differ', async () => {
      // Same predicate — count `sliceJobsList()` — on the opposite data.
      // If the idempotency check were vacuous, this test would pass with
      // one job too, and the positive test's `.toBe(1)` would tell us
      // nothing.
      const h = setupHarness();
      await h.bindings.submitCalibrationSlice({
        userId: USER_ID,
        printerId: PRINTER_ID,
        slicerProfileJson: '{"machineProfileName":"K1 Max 0.4"}',
        method: 'flow_rate_pass_1',
        idempotencyKey: '77777777-7777-4777-8777-777777777777',
      });
      await h.bindings.submitCalibrationSlice({
        userId: USER_ID,
        printerId: PRINTER_ID,
        slicerProfileJson: '{"machineProfileName":"K1 Max 0.4"}',
        method: 'flow_rate_pass_1',
        idempotencyKey: '88888888-8888-4888-8888-888888888888',
      });
      expect(h.server.sliceJobsList()).toHaveLength(2);
      expect(h.server.idempotencyRegistrations()).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Wire canonicalisation sanity (the fake server's own guarantees)
  // -------------------------------------------------------------------------
  //
  // These tests don't depend on Bishop's channels landing — they exercise
  // the fake server directly. Their role is to prove the fake server is a
  // faithful contract before the other tests use it as a discriminator. If
  // one of these ever fails, the acceptance suite is silently invalidated
  // even when it passes.
  describe('fake-server contract sanity (no client dependencies)', () => {
    let server: FakeFilamentCalibrationServer;
    beforeEach(() => {
      server = makeServer();
    });

    it('canonicalJson sorts nested keys deterministically', () => {
      // Same predicate — string equality after canonicalisation.
      const a = canonicalJson({ z: [1, 2, 3], a: { c: 1, b: 2 } });
      const b = canonicalJson({ a: { b: 2, c: 1 }, z: [1, 2, 3] });
      expect(a).toBe(b);
      // Control: two DIFFERENT semantic values must NOT collide.
      const c = canonicalJson({ a: { b: 2, c: 2 }, z: [1, 2, 3] });
      expect(a).not.toBe(c);
    });

    it('a bare POST /api/slice with no calibration block is refused', async () => {
      const res = await server.fetch(`${BASE_URL}/api/slice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, printerId: PRINTER_ID }),
      });
      expect(res.status).toBe(400);
    });

    it('directly PUTing a system profile through /custom returns 403 forbidden', async () => {
      const sys = server.addSystemProfile(
        'Generic PLA',
        'filament',
        sampleBaseFilamentProfile(),
      );
      const res = await server.fetch(
        `${BASE_URL}/api/slicer/profiles/custom/${sys.id}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rawJson: '{}' }),
        },
      );
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// Sequencing helper — used only by the step-sequencing test
// ---------------------------------------------------------------------------

/**
 * Run one calibration step against a pre-existing clone (does NOT re-clone
 * from source). This is the shape the wizard uses when advancing to the
 * next step: reuse the same custom profile so successive corrections
 * accumulate rather than reset.
 */
async function singleStepAgainstClone(
  h: HarnessedTest,
  clonedProfileId: string,
  method: SupportedCalibrationMethod,
  measurement: number,
): Promise<OperatorFlowResult> {
  const submit = await h.bindings.submitCalibrationSlice({
    userId: USER_ID,
    printerId: PRINTER_ID,
    slicerProfileJson: JSON.stringify({
      machineProfileName: h.baseMachineName,
      processProfileName: h.processProfileName,
      filamentProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
    }),
    method,
  });
  let last: SliceStatus | null = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    last = await h.bindings.getSliceJobStatus(submit.jobId);
    if (last.status === 'Completed' || last.status === 'Failed') break;
  }
  if (last === null) throw new Error('no observations');
  if (last.status === 'Failed') {
    return {
      clonedProfileId,
      jobId: submit.jobId,
      finalStatus: 'Failed',
      failureHint: last.failureHint,
      sendResponse: null,
    };
  }
  const send = await h.bindings.sendSliceToPrinter(submit.jobId, {
    printerId: PRINTER_ID,
    startPrint: false,
  });
  const clone = h.server.profileById(clonedProfileId);
  if (clone === undefined) throw new Error('clone missing');
  const patched = applyMeasurement(clone.rawJson, method, measurement);
  await h.bindings.updateCustomProfile(clonedProfileId, {
    rawJson: JSON.stringify(patched),
    name: null,
  });
  return {
    clonedProfileId,
    jobId: submit.jobId,
    finalStatus: last.status,
    failureHint: null,
    sendResponse: send,
  };
}

// ---------------------------------------------------------------------------
// Empirical discrimination proof (runs TODAY without Bishop's channels)
// ---------------------------------------------------------------------------
//
// The 16 "blocked on Bishop" tests above all die at the first client-verb
// call, so they cannot themselves demonstrate that their assertions catch
// drift. That would leave the discipline in the assignment — "prove your
// tests discriminate" — unmet. This block fills that gap.
//
// The proofs below drive the SAME fake server through the SAME operator
// flow but via a raw-`fetch` client that bypasses `CalibrationHttpClient`
// entirely. Assertions are IDENTICAL to the blocked tests' assertions;
// the driver works today. Running the flow once faithfully and once in a
// discrimination mode proves the assertions catch drift.
//
// These proofs pass today. When Bishop's channels land, the sixteen
// blocked tests join them and the whole gate turns green together.

async function runOperatorFlowRaw(
  server: FakeFilamentCalibrationServer,
  input: {
    baseProfileId: string;
    baseMachineName: string;
    processProfileName: string;
    newProfileName: string;
    method: SupportedCalibrationMethod;
    startPrint: boolean;
    measurement: number;
    idempotencyKey?: string;
  },
): Promise<OperatorFlowResult> {
  // 1. Clone
  const cloneRes = await server.fetch(`${BASE_URL}/api/slicer/profiles/clone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceProfileId: input.baseProfileId,
      profileType: 'filament',
      name: input.newProfileName,
    }),
  });
  const cloneBody = (await cloneRes.json()) as { id: string };
  // 2. Submit slice — deliberately OMIT saga fields entirely
  const slicerProfileJson = JSON.stringify({
    machineProfileName: input.baseMachineName,
    processProfileName: input.processProfileName,
    filamentProfileName: input.newProfileName,
  });
  const submitHeaders: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (input.idempotencyKey !== undefined) {
    submitHeaders['idempotency-key'] = input.idempotencyKey;
  }
  const submitRes = await server.fetch(`${BASE_URL}/api/slice`, {
    method: 'POST',
    headers: submitHeaders,
    body: JSON.stringify({
      userId: USER_ID,
      printerId: PRINTER_ID,
      slicerEngine: 'OrcaSlicer',
      slicerProfileJson,
      calibration: { method: input.method },
    }),
  });
  const submitBody = (await submitRes.json()) as { jobId: string };
  // 3. Poll
  let last: SliceStatus | null = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const statusRes = await server.fetch(
      `${BASE_URL}/api/slice/${submitBody.jobId}`,
    );
    last = (await statusRes.json()) as SliceStatus;
    if (last.status === 'Completed' || last.status === 'Failed') break;
  }
  if (last === null) throw new Error('no observations');
  if (last.status === 'Failed') {
    return {
      clonedProfileId: cloneBody.id,
      jobId: submitBody.jobId,
      finalStatus: 'Failed',
      failureHint: last.failureHint,
      sendResponse: null,
    };
  }
  // 4. Send to printer
  const sendRes = await server.fetch(
    `${BASE_URL}/api/slice/${submitBody.jobId}/send-to-printer`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        printerId: PRINTER_ID,
        startPrint: input.startPrint,
      }),
    },
  );
  const sendBody = (await sendRes.json()) as SendToPrinterResponse;
  // 5. Write measurement back to the clone
  const cloneRecord = server.profileById(cloneBody.id);
  if (cloneRecord === undefined) throw new Error('clone missing');
  const patched = applyMeasurement(
    cloneRecord.rawJson,
    input.method,
    input.measurement,
  );
  await server.fetch(`${BASE_URL}/api/slicer/profiles/custom/${cloneBody.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rawJson: JSON.stringify(patched) }),
  });
  return {
    clonedProfileId: cloneBody.id,
    jobId: submitBody.jobId,
    finalStatus: last.status,
    failureHint: null,
    sendResponse: sendBody,
  };
}

describe('Empirical discrimination proof — the assertions catch drift', () => {
  it('happy-path predicate reads corrected value under faithful and STALE when write-back is skipped', async () => {
    // Case A: faithful — the identical predicate the blocked happy-path
    // test uses reads the corrected `1.020`.
    const serverA = makeServer();
    const baseA = serverA.addSystemProfile(
      'Generic PLA @ K1 Max 0.4',
      'filament',
      sampleBaseFilamentProfile(),
    );
    const outcomeA = await runOperatorFlowRaw(serverA, {
      baseProfileId: baseA.id,
      baseMachineName: 'K1 Max 0.4',
      processProfileName: '0.20mm Standard @ K1 Max 0.4',
      newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
      method: 'flow_rate_pass_1',
      startPrint: false,
      measurement: 1.02,
    });
    const cloneA = serverA.profileById(outcomeA.clonedProfileId);
    expect(
      (
        (cloneA as FakeProfileRecord).rawJson[
          'filament_flow_ratio'
        ] as unknown[]
      )[0],
    ).toBe('1.020');

    // Case B: same predicate, opposite data — the driver deliberately
    // stops before the write-back. The clone still reads `0.98`.
    const serverB = makeServer();
    const baseB = serverB.addSystemProfile(
      'Generic PLA @ K1 Max 0.4',
      'filament',
      sampleBaseFilamentProfile(),
    );
    const cloneRes = await serverB.fetch(
      `${BASE_URL}/api/slicer/profiles/clone`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceProfileId: baseB.id,
          profileType: 'filament',
          name: 'MyBrand Silky PLA (K1 Max 0.4)',
        }),
      },
    );
    const cloneBody = (await cloneRes.json()) as { id: string };
    const cloneB = serverB.profileById(cloneBody.id);
    expect(
      (
        (cloneB as FakeProfileRecord).rawJson[
          'filament_flow_ratio'
        ] as unknown[]
      )[0],
    ).toBe('0.98');
    // Case A: '1.020'. Case B: '0.98'. Same predicate, opposite results.
  });

  it('clone-isolation predicate reads sha unchanged under faithful and MUTATED under `update-mutates-source`', async () => {
    // Case A: faithful.
    const serverA = makeServer();
    const baseA = serverA.addSystemProfile(
      'Generic PLA @ K1 Max 0.4',
      'filament',
      sampleBaseFilamentProfile(),
    );
    const initialShaA = serverA.initialShaOf(baseA.id);
    expect(initialShaA).toBeDefined();
    await runOperatorFlowRaw(serverA, {
      baseProfileId: baseA.id,
      baseMachineName: 'K1 Max 0.4',
      processProfileName: '0.20mm Standard @ K1 Max 0.4',
      newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
      method: 'flow_rate_pass_1',
      startPrint: false,
      measurement: 1.02,
    });
    const sourceAfterA = serverA.profileById(baseA.id);
    expect((sourceAfterA as FakeProfileRecord).contentSha256).toBe(initialShaA);

    // Case B: same predicate — read source sha, compare to initial — but
    // server is primed with the shallow-clone bug AND the mutate-source
    // permission, matching a desktop that (buggily) targeted the source
    // id at write-back.
    const serverB = makeServer();
    const baseB = serverB.addSystemProfile(
      'Generic PLA @ K1 Max 0.4',
      'filament',
      sampleBaseFilamentProfile(),
    );
    const initialShaB = serverB.initialShaOf(baseB.id);
    serverB.primeCloneReturnsSourceIdOnce();
    serverB.setDiscriminationMode('update-mutates-source');
    await runOperatorFlowRaw(serverB, {
      baseProfileId: baseB.id,
      baseMachineName: 'K1 Max 0.4',
      processProfileName: '0.20mm Standard @ K1 Max 0.4',
      newProfileName: 'MyBrand Silky PLA (K1 Max 0.4)',
      method: 'flow_rate_pass_1',
      startPrint: false,
      measurement: 1.02,
    });
    const sourceAfterB = serverB.profileById(baseB.id);
    expect((sourceAfterB as FakeProfileRecord).contentSha256).not.toBe(
      initialShaB,
    );
    // Predicate reads EQUAL in case A, NOT-EQUAL in case B.
  });

  it('no-saga-ids predicate reads `hasOwnProperty` as absent under faithful and PRESENT under a null-valued key', async () => {
    // Case A: faithful — the raw-fetch driver omits the three saga keys
    // entirely. `hasOwnProperty` reads them as absent.
    const serverA = makeServer();
    const baseA = serverA.addSystemProfile(
      'Generic PLA',
      'filament',
      sampleBaseFilamentProfile(),
    );
    await runOperatorFlowRaw(serverA, {
      baseProfileId: baseA.id,
      baseMachineName: 'K1 Max 0.4',
      processProfileName: '0.20mm Standard @ K1 Max 0.4',
      newProfileName: 'MyBrand Silky PLA',
      method: 'flow_rate_pass_1',
      startPrint: false,
      measurement: 1.02,
    });
    const jobsA = serverA.sliceJobsList();
    expect(jobsA[0]?.calibrationProjectIdPresent).toBe(false);

    // Case B: hand-craft a request with a null-valued saga id. Upstream's
    // `is not null` guard passes it (fake server accepts, 202), but the
    // KEY is present. Same predicate, opposite result — proving that
    // asserting on ABSENCE (not `!= null`) discriminates a client that
    // sends null-valued saga fields.
    const serverB = makeServer();
    void serverB.addSystemProfile(
      'Generic PLA',
      'filament',
      sampleBaseFilamentProfile(),
    );
    const nullSagaRes = await serverB.fetch(`${BASE_URL}/api/slice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: USER_ID,
        printerId: PRINTER_ID,
        slicerEngine: 'OrcaSlicer',
        slicerProfileJson: '{}',
        calibration: { method: 'flow_rate_pass_1' },
        calibrationProjectId: null,
      }),
    });
    expect(nullSagaRes.status).toBe(202);
    const jobsB = serverB.sliceJobsList();
    expect(jobsB[0]?.calibrationProjectIdPresent).toBe(true);
  });
});
