// Reap stub -- see #756.
//
// The original harness read `docs/printer-calibration-admin-guide.md`
// (`GUIDE_PATH`) and enforced `ADMIN_GUIDE_CITATION_FLOOR` on the
// machine-resolvable `line@commit` citations in its section 10. Both the
// guide and the citation surface it audited were reaped with the
// printer-calibration saga in #756. What is left in the tree is a
// passing no-op with the surface the citation-reachability workflow
// still calls and the citation-reachability test still asserts on, so
// removing the workflow step and its wiring can happen in a follow-up
// PR with `workflow` OAuth scope. That follow-up should delete this
// file, the `check:admin-guide-citations` npm script, the step in
// `.github/workflows/citation-reachability.yml`, and the two
// admin-guide clauses in `tests/citationReachability.test.ts` in one
// coordinated change.
//
// Kept as a real ES module (not `exit 0` in npm), because
// `tests/citationReachability.test.ts` matches on the constants and
// call shape below, and it MUST continue to prove that whatever is
// invoked from the workflow either does its job or, as here, has been
// deliberately reaped -- not silently drifted to matching nothing.

export const GUIDE_PATH = 'docs/printer-calibration-admin-guide.md';
export const SERVER_REPOSITORY = 'OlyForge3D/PrintFarmer';
export const ADMIN_GUIDE_CITATION_FLOOR = 0;

// The `#756-reap` sentinel makes the reap intent grep-visible from CI
// logs and from the citation-reachability workflow output; a reader
// looking at a green step sees why it is green rather than assuming the
// original guard fired.
console.log('check-admin-guide-citations: #756-reap stub (no-op).');
process.exit(0);
