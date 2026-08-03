# The fact-check consistency check is symmetric, and it has now been run

`.squad/fact-checker/policy.md` no longer scopes the cross-artifact check as
_"does `.squad/decisions.md` actually say what was claimed?"_. That scoping made the
decision log the authority and the other artifact the thing under test, so the check
could only fire when the other artifact disagreed with the log. It could not fire when
the log itself held the wrong rendering — which is a failure the log records having
happened.

The policy now carries two rows in place of one. The original one-directional form is
retained for its correct object, claims made _about_ the log. A second row covers two
or more artifacts rendering one incident, and points at a new
**Cross-Artifact Symmetric Diff** section that designates no authority.

What that section requires, for any agent running the check:

- Enumerate **every** rendering, not two. A pair-wise habit is how a third rendering
  survives a repair that fixed the other two.
- Publish the extraction rule and the head with the result, and run a control that can
  report non-empty.
- Report a disagreement against the **pair or the set**, never against whichever member
  is not the decision log.
- Establish that both artifacts fill the same slot before treating a difference as a
  defect. At document scope a difference is deductive; between test corpora or fixtures
  it is a lead to be measured.
- A clean result on a **dependent** pair is a false negative and is recorded ⚠️
  Unverified, never ✅ Verified. Independence must be established, not assumed.
- **A disagreement is discharged only by repairing every rendering** — not by explaining
  why the two differ, and not by repairing only the rendering whose author is nearest.
- Where a corrected figure disagrees with a source a reader will reach for, name the
  relationship and not only the number.

The corrected check has been run, and `.squad/fact-checker/audit-trail.md` is no longer
a single `n/a` entry. Five runs are recorded there: the two historical pairs in opposite
directions, one dependent pair whose clean result is graded ⚠️ rather than ✅, one
independent agreeing set graded ✅, and one live finding.

The live finding is the same diamond-DAG row count the log already records. Its repair
fixed `.squad/skills/test-discipline/SKILL.md` and left a third rendering in
`docs/security/THREAT_MODEL.md` § _T2.2 — Structurally valid input that reaches an
untested code path (A1)_ still reading `32,767 rows`. That rendering has been repaired
in the same change, because filing it and leaving it would have been the discharge
failure the new rule exists to prevent.

Governing entry, cited by heading: `.squad/decisions.md` →
**2026-07-26 — Diffing two renderings of one incident finds what neither rendering's own
review found**. This change is the remedy that entry names, and it was authored by the
fact-checker, so per that entry it must be reviewed by someone else.
