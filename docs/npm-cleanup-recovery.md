# NPM cleanup recovery

Use this runbook only when a failed job contains the exact diagnostic:

```text
could not finish removing node_modules
```

The step or script name is not evidence. `npm-ci-strict.mjs` appears in passing
jobs too.

## What happens automatically

On Windows, `npm-ci-strict` parses the directories in npm's cleanup warning,
rejects paths outside `node_modules`, and retries only the shallowest
npm-requested removals with Node's bounded `EPERM` retry support. It then runs
the same `npm ls --omit=dev --all --json` checks used by the SBOM path.

A successful removal retry does not waive integrity checks. If removal still
fails, or if the resulting tree is malformed, extraneous, invalid, or
unresolvable, the install step remains red.

An unrecoverable cleanup failure stages JSON evidence in the runner temp
directory. The next step uploads it as an artifact. A trusted `workflow_run`
handler on `development` posts it to issue #274 with the run id, attempt, head
SHA, job, runner, named directories, and exact anchor. This split also works for
fork and Dependabot runs, whose pull-request token cannot write issue comments.
The issue comment remains reachable after later pushes or reruns, unlike a
failed attempt discovered only through the current commit's checks.

## Authorized discharge

Do not click **Re-run failed jobs** directly. A maintainer runs the reviewed
workflow from `development`:

```powershell
gh workflow run npm-cleanup-recovery.yml `
  --repo OlyForge3D/PrintFarmerDesktop `
  --ref development `
  -f run_id=<failed-run-id> `
  -f head_sha=<full-40-character-sha> `
  -f justification='<specific reason the diagnosed cleanup failure may be rerun>'
```

The justification must contain at least 20 non-whitespace characters. The
workflow:

1. Requires the named run to be completed and failed at the exact SHA.
2. Requires every failed job's `Install dependencies` step to be the only
   failed step and reads that job's log from the latest attempt.
3. Refuses the whole discharge if any failed job lacks the exact anchor.
4. Posts the authorization, failed job ids, actor, SHA, anchor, and justification
   to issue #274.
5. Requests GitHub's failed-job rerun only after the durable comment succeeds.

The rerun executes the original workflow unchanged. Install integrity, tests,
SBOM completeness, licences, notices, and advisory controls remain enabled.
Failure to read logs, publish the record, or request the rerun is an explicit
workflow failure.

## Remedy choice

The lockfile shows the failing subtree is
`electron-installer-dmg -> appdmg (darwin only) -> parse-color@1.0.0 ->
color-convert@0.5.3`. Windows npm removes that os-mismatched optional subtree
after fetching it, and the recorded lock is on that removal.

- A `color-convert` override was rejected: `parse-color` expects the 0.5 API,
  while the hoisted 2.x package is a breaking change. The release workflow
  genuinely runs the DMG maker on macOS, so an override would risk the platform
  that consumes `appdmg`.
- `--omit=optional` was rejected: it changes the dependency tree and omits more
  than the darwin-only subtree.
- Bounded removal retry was selected: it preserves the lockfile and install
  inputs, addresses the measured Windows `EPERM` operation, and proceeds only
  after the existing structural validation passes.
