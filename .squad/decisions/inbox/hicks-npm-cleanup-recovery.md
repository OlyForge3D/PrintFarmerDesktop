# NPM cleanup recovery is bounded, durable, and justified

**By:** Hicks

**Decision:** On Windows, `npm-ci-strict` may retry only the directories npm
itself named inside the recorded `EPERM`/`rmdir` block, bounded to
`node_modules`, and must then run the existing production-tree validation. An
unrecoverable cleanup failure is uploaded as an artifact and recorded on issue
#274 by a trusted `workflow_run` handler. A rerun is authorized only through the
manual NPM cleanup recovery workflow, which requires a justification, verifies
every failed job failed only at `Install dependencies` and contains
`could not finish removing node_modules`, records the authorization before
rerunning, and refuses mixed failures.

**Why:** The deterministic failing subtree is a darwin-only optional dependency
that npm removes on Windows. Retrying that removal addresses the measured
`EPERM` without changing the lockfile or omitting optional dependencies.
Overriding `color-convert` would cross a breaking API boundary in the macOS DMG
path. Direct reruns make the failed attempt unreachable from ordinary commit
queries and can also retry unrelated policy failures; the durable comment and
all-failed-jobs classification close both gaps.
