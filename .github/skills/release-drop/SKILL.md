---
name: release-drop
description: Drop a PrintFarmer Desktop beta prerelease or GA release using manual version selection, a persisted direct version commit and exact-SHA build, then verify the published artifacts.
---

# Dropping a release

`.github/workflows/release.yml` is the only publisher. The preferred path is a
manual dispatch from `development` with an explicit version and `dry_run=false`.
The workflow commits the tracked version, tags that exact commit, and builds and
publishes it in the same run. **Do not open a version-bump PR.**

## 1. Check readiness

Get the latest shipped version from GitHub Releases and tags, not only
`package.json`. The beta line increments `0.1.0-beta.N` until `0.1.0` ships;
features during beta do not advance the minor.

```sh
gh release list --limit 5
gh run list --branch development --limit 8 --json name,conclusion,headSha,createdAt
```

Confirm the intended development head is green and no release is already in
flight. Never move existing tags or replace published assets.

Manual publication needs the user-managed, repository-scoped
`RELEASE_PUSH_TOKEN` secret and the existing administrator exemption. It is not
configured by an agent. See `docs/RELEASES.md` for exact scope and setup.
Both beta and stable need all six Apple signing/notarization secrets; stable
also needs Windows Authenticode and update-signing credentials.

## 2. Dispatch the selected version

```sh
gh workflow run release.yml --ref development -f dry_run=false -f version=0.1.0-beta.10
```

Use the version actually authorized by the user, not the example. Canonical
SemVer is required, with no build metadata and core components at most 65535.
The version must be newer than the checkout and all published releases.

The workflow updates all three application version fields across
`package.json` and `package-lock.json`, checks that nothing else changed, then
atomically pushes the version commit to development and a new annotated tag.
If development or the tag changes concurrently, it refuses the whole push.
No force push or hidden rebase is permitted. The independently versioned Rust
workspace and native lockfile are unchanged.

The prepared SHA is passed explicitly to both platform builds and publication,
including signing-mode selection and updater metadata. The originating dispatch
owns publication; the automatically triggered tag run recognizes its run marker
and does not build/publish again. This does not depend on GITHUB_TOKEN pushes
triggering workflows.

To exercise packaging without releasing, leave `dry_run=true` and version blank.
Dry runs stay unsigned and do not commit, tag, or publish.

## 3. Watch the originating run

```sh
gh run list --workflow release.yml --limit 5 --json databaseId,status,headBranch,event
gh run watch <dispatch-run-id> --exit-status --interval 30
```

Watch the dispatch run, not the suppressed tag run. Windows x64 and macOS
universal typically take 20-40 minutes. A pending request can be replaced by
GitHub's concurrency scheduler; verify the intended run actually starts.

If preparation fails before its atomic push, no remote version change landed.
If builds fail afterward, rerun failed jobs of the original dispatch. Its
preparation can reuse only its own immutable tag/commit/run identity. A fresh
dispatch with that version is rejected. Existing/partial GitHub releases are
never overwritten; inspect partial publication and obtain a human recovery
decision. Never retag to recover.

## 4. Verify publication

The workflow checks the exact asset set after publishing; independently confirm:

```sh
gh release view v<version> --json name,isPrerelease,assets \
  --jq '{name,isPrerelease,assets:[.assets[].name]}'
```

A prerelease must have `isPrerelease:true` and exactly:

- `PrintFarmer.Desktop-<version>.Setup.exe`
- `PrintFarmer.Desktop-win32-x64-<version>.zip`
- `PrintFarmer.Desktop-<version>-universal.dmg`
- `PrintFarmer.Desktop-darwin-universal-<version>.zip`

Beta macOS apps and nested sidecars are Developer ID signed, notarized, and
stapled. Windows beta artifacts are unsigned. A beta must not publish
`latest.json` or its signature and is never an automatic update.

A stable release has `isPrerelease:false`, signed Windows artifacts, and the
same four assets plus `latest.json` and `latest.json.sig`. Verify metadata names
the selected version. Only stable releases deliver automatic updates.

Manually pushed unmarked `v*` tags remain supported for existing matching
version commits. Do not hand-author tags as part of the manual dispatch path.
`npm run check:release-tagged` remains a backstop for unpublished versions,
not proof that building or publication succeeded.

## Related

- `docs/RELEASES.md` - setup, signing isolation, recovery, update trust
- `.github/workflows/release.yml` - release execution
- `scripts/prepare-release.mjs` - version validation, commit/tag, exact-SHA checks
- `.github/workflows/release-tagged.yml` - unpublished-version guard
