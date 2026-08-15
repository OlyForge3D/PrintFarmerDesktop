---
name: release-drop
description: Drop a PrintFarmer Desktop beta prerelease or GA release. Use when asked to cut, drop, ship, publish, or tag a release — beta or stable. Covers the version-bump PR, the tag push that actually triggers the build, and the post-publish verification that the release and its platform artifacts exist.
---

# Dropping a release

`.github/workflows/release.yml` is the only thing that publishes. It triggers on
`push: tags: ['v*']` and on `workflow_dispatch` (dry run only).

**Merging the version-bump PR publishes nothing.** The bump and the tag are two
separate acts, and the tag is the one that builds. A release that stops after the
merge leaves `package.json` claiming a version that was never shipped. This has
now happened twice: `0.1.0-beta.3` landed on `development` in #713 and sat
unreleased until the tag was pushed by hand a day later, and `0.1.0-beta.4`
landed in #727 and sat for three days — the second time with this warning
already written above it.

Since the second occurrence, `.github/workflows/release-tagged.yml` reports the
gap on a schedule rather than waiting for someone to notice: it fails when
`development` has claimed a version for longer than a grace window with no tag
naming it. Run it against your own checkout at any point:

```sh
npm run check:release-tagged
```

That guard is a backstop, not a substitute for step 4 — it tells you the release
did not happen; it cannot push the tag for you.

Do not consider the job done until [Verify the release published](#5-verify-the-release-published)
passes.

## Versioning

The beta line counts toward a fixed GA. `0.1.0-beta.N` increments until `0.1.0`
ships; features landing during the beta do **not** advance the minor. Read the
last shipped version from the tags, not from `package.json`:

```sh
gh release list --limit 5
git tag --sort=-v:refname | head -5
```

Tag and package version must match exactly, and the workflow enforces it. Tag
`v1.2.3-beta.4` requires `package.json` version `1.2.3-beta.4`.

A tag containing `-` is a beta (`IS_BETA_RELEASE`); a tag without one is stable
(`IS_STABLE_RELEASE`). That single character decides whether signing credentials
are reachable, so never hand-write a tag name.

## 1. Pick the release commit

Betas cut from `development`. Confirm it is green first — the tag build repeats
these checks and cutting from red only wastes a matrix build:

```sh
gh run list --branch development --limit 8 \
  --json name,conclusion,headSha,createdAt
```

## 2. Open the version-bump PR

```sh
git switch -c dev/<user>/release-v<X>-<Y>-<Z>-beta-<N> development
npm version <X>.<Y>.<Z>-beta.<N> --no-git-tag-version
```

`npm version` updates both `package.json` and `package-lock.json`. Both must be
committed: the release build runs `git diff --exit-code -- native/Cargo.lock
package-lock.json` and fails if the lockfile drifts.

`Closing-reference declaration` is a required check, so add a declaration file
named after the slugified branch (see `.github/pr-closes/README.md`). A release
PR closes nothing, so an empty block is the correct, meaningful declaration:

````
.github/pr-closes/dev-<user>-release-v<X>-<Y>-<Z>-beta-<N>.md

```closes

```
````

Run `npm run format` before pushing. The formatter runs as a `Format check` step
inside the `Desktop` job, so a formatting failure surfaces as a failing
`Desktop (windows-latest)` / `Desktop (macos-latest)` required check rather than
as anything named "format". An unformatted file inherited from `development`
fails the release PR even though the PR did not cause it — exactly what happened
in #713, which had to re-run prettier on a file #712 had left unformatted.

Required checks on `development`: `Desktop (windows-latest)`,
`Desktop (macos-latest)`, `Sidecar (windows-latest)`, `Sidecar (macos-latest)`,
`Release package (windows-latest)`, `Release package (macos-latest)`,
`Dependency advisories`, `Closing-reference declaration`.

## 3. Merge, then read back the merge commit

Merges are squash, so the SHA on `development` is **not** the SHA on the PR
branch. Tagging the branch commit tags something that is not on `development`:

```sh
git fetch origin
git log --oneline -3 origin/development
```

Take the SHA of the release commit. Title it
`chore(release): set version to <version>` — #713 used that wording and #727
used `chore(release): prepare v<version>`, so a step that says "find the commit
titled X" has already failed once for someone reading it. The title is a
convenience; the fact that decides the SHA is the version in the tree, so
confirm rather than recognise:

```sh
git show <sha>:package.json | grep '"version"'
```

That must print the exact version you are about to tag. The tag build enforces
the same equality and fails on a mismatch, but it does so forty minutes later.

## 4. Push the tag

Tags are not protected; this push needs no special permission.

```sh
git tag v<X>.<Y>.<Z>-beta.<N> <merge-sha>
git push origin v<X>.<Y>.<Z>-beta.<N>
```

Confirm the workflow actually picked it up. If no run appears, the tag did not
match `v*` or the push did not land:

```sh
gh run list --workflow=release.yml --limit 3 \
  --json databaseId,status,headBranch,event
gh run watch <run-id> --exit-status --interval 30
```

The matrix builds Windows and macOS, so expect roughly 20–40 minutes.

## 5. Verify the release published

The build passing is not the same as the release existing. Check both, and check
that every platform artifact is attached — `fail_on_unmatched_files: true` should
catch a missing artifact, but confirm rather than assume:

```sh
gh release view v<X>.<Y>.<Z>-beta.<N> --json name,isPrerelease,assets \
  --jq '{name, isPrerelease, assets: [.assets[].name]}'
```

A beta must report `isPrerelease: true` and carry four assets:

- `PrintFarmer.Desktop-<version>.Setup.exe`
- `PrintFarmer.Desktop-win32-x64-<version>.zip`
- `PrintFarmer.Desktop-<version>-universal.dmg`
- `PrintFarmer.Desktop-darwin-universal-<version>.zip`

A beta must **not** publish `latest.json`. The workflow fails closed if one
appears, because GA update metadata served from a prerelease would be unsigned.

## GA releases

Same five steps, with a tag carrying no `-` (`v0.1.0`). The differences are all
consequences of `IS_STABLE_RELEASE`:

- Every signing, notarization, and update-signing secret listed in
  `docs/RELEASES.md` must be present. The job **fails closed** if any is
  missing, mid-build, after the matrix has already run.
- Windows artifacts get Authenticode signatures; the macOS app and its nested
  Rust sidecar are signed, notarized, and stapled.
- The publish job additionally emits `latest.json` and `latest.json.sig`. These
  are what installed apps read to self-update, so verify both are attached and
  that `latest.json` names the version just shipped.
- Verify with `isPrerelease: false` and six assets (the four above plus the two
  metadata files).

Because GA is the only path that touches credentials and the only path that can
push an update to installed apps, confirm the signing secrets are configured
_before_ opening the bump PR rather than discovering it after a 40-minute build.

## Related

- `docs/RELEASES.md` — signing architecture, secret inventory, update-trust model
- `.github/workflows/release.yml` — the workflow itself
- `.github/workflows/release-tagged.yml` — the scheduled guard that reports a
  bump which never became a release (`npm run check:release-tagged`)
- `.github/pr-closes/README.md` — closing-reference declaration format
