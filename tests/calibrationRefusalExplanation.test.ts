/**
 * The refusal-explanation path used to be a first-class surface: PrintFarmer's
 * `/api/printers/calibration-candidates` explained every refusal with a code
 * per unmet precondition, and the wizard read them out via
 * `candidateEligibilityBlockers` / `contextEligibilityBlockers`.
 *
 * `OlyForge3D/PrintFarmer#1943` retired the eligibility gate together with
 * that route. Under Path D every enabled, non-maintenance printer is a
 * candidate; there is nothing left for the server to refuse, and the wizard
 * no longer receives `rejectionReasonCodes` / `missingInputs` /
 * `firmwareCompatible` / `eligibility` on a candidate. The renderer-side
 * message maps that lived in `refusalMessages` are still exported (a follow-up
 * cleanup can retire them if `NewCalibrationProject` is also retired), but
 * the two behavioural surfaces this file exercised — candidate refusal
 * explanation and context refusal explanation — no longer receive data.
 *
 * The tests below are `describe.skip` stubs so the intent of each case is
 * preserved in git history and rediscoverable if the shape ever returns.
 */

import { describe, it } from 'vitest';

describe.skip('refusal wording (Path D: eligibility gate retired)', () => {
  it('has a distinct sentence for every code the renderer can receive', () => {});
  it('says which fields PrintFarmer is still waiting on', () => {});
  it('admits when a field name could not be carried', () => {});
});

describe.skip('candidate eligibility blockers (Path D: eligibility gate retired)', () => {
  it("reads out the server's reasons rather than a generic refusal", () => {});
  it('still refuses, and still explains, when the reason list is empty', () => {});
  it('names offline separately from the refusal itself', () => {});
  it('blocks an eligible-but-offline printer without inventing a reason', () => {});
  it('reports a self-contradicting server as a server defect', () => {});
});

describe.skip('context eligibility blockers (Path D: eligibility gate retired)', () => {
  it("reads out the server's profile-level reasons", () => {});
  it('keeps its own structural checks alongside them', () => {});
});
