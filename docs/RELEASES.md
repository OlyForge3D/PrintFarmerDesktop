# Signed releases

Manual publication and official `v*` tag pushes run `.github/workflows/release.yml`. Both stable and
beta releases require Developer ID signing and notarization for macOS. Stable
releases additionally require Windows Authenticode and update-metadata signing.
Each release fails closed if a credential required for its channel is missing.
Manual runs default to unsigned, non-mutating dry runs. Set `dry_run=false` and
select a version to persist, tag, build, and publish a release directly from
`development`, without a version-bump PR.

## Manual release initiation

After confirming `development` is ready to ship, dispatch the release workflow
from **development**, enter the full version (for example `0.1.0-beta.10`), and
turn **dry_run off**:

```sh
gh workflow run release.yml --ref development -f dry_run=false -f version=0.1.0-beta.10
```

The preparation job validates canonical SemVer (no build metadata; core fields
at most 65535), refuses reused or older versions, and updates `package.json`
plus both root application-version fields in `package-lock.json`. It verifies
that no other manifest/lockfile content changed, commits those two tracked
files, and atomically pushes `development` plus a new annotated `v<version>`
tag on that exact commit. No force pushes, tag moves, dependency changes,
version-bump PRs, or build-only version stamps are used. The Rust workspace and
its lockfile have an independent sidecar version and are not changed. SBOM and
dependency-license outputs are generated during packaging, not versioned source.

If development moves after dispatch or before the atomic push, preparation
fails rather than silently releasing a different tree. Start a fresh run against
the new head. A simultaneous branch/tag update rejects the entire push.
The existing branch protections remain enabled and unchanged. The version-only
write deliberately uses the administrator exemption described below; normal PR
checks do not run before that direct commit is persisted.

Make and publish check out the **prepared commit SHA**, not the dispatch SHA.
The same run owns building, signing, and publication; it never relies on a
token-created tag triggering another workflow. Administrator-token tag pushes
do trigger a second tag run, but its preparation recognizes the annotated
`Release-Workflow-Run` marker and suppresses its build/publication. Manually
pushed, unmarked tags still follow the existing release path and must exactly
match the tracked package version. All release runs share a non-cancelling
concurrency group with `queue: max`: one run executes at a time and up to 100
pending runs are retained rather than replaced by later requests. Additional
runs are cancelled when that queue is full. Dispatch order is not guaranteed;
this is not a FIFO release-request contract. See
[GitHub's concurrency semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
Check that the intended dispatch actually starts. Queued manual publications
still fail if development has moved since dispatch; queueing does not rebase
them or bypass the stale-head check. Do not start a competing release while
another is in flight.

For packaging only, leave **dry_run on** and the version input blank. This uses
the checked-out tracked version, never commits or tags, and never needs the
administrator credential. A different version input is rejected rather than
silently ignored or stamped into uncommitted build files.

### User-managed release-push credential

Before the first manual publication, a repository administrator must create
and configure the dedicated Actions secret **`RELEASE_PUSH_TOKEN`**. No token
is provisioned by this change. Prefer an expiring fine-grained PAT restricted
to **OlyForge3D/PrintFarmerDesktop only**, with **Contents: read and write**
and the automatically required **Metadata: read**. Its owner must be an
administrator of this repository, with the existing administrator exemption
under current classic protection (`enforce_admins=false`). A normal write token
or `GITHUB_TOKEN` is not a substitute for that bypass capability. Organization
approval/SSO authorization may also be necessary.

Do not grant extra repository permissions or create a new protection bypass.
The fine-grained repository/Contents scope is the least privilege for this
version-only push, but the administrator identity can still bypass branch
checks: the credential itself is more powerful than the workflow's two-file
allowlist. Keep it dedicated, rotate it, and do not share an interactive
session token. The workflow exposes it only to trusted development manual
publication preparation, uses it only for the atomic push, never stores it in
Git configuration/remotes, and strips it before npm/git child operations other
than that push. Build, signing, and publication jobs never receive it.

### Failed builds and retries

Before the atomic push, failure leaves the remote branch and tag unchanged.
Afterward, the persisted version commit/tag are immutable even if a build fails.
Rerun the failed jobs of the **original dispatch run**; rerunning its preparation
also recognizes and validates its own tag, version, original parent, and run ID
instead of creating another commit. A fresh dispatch cannot reuse that version.
If a newer release has already published, the old run refuses to publish a
downgrade.

Publication uses create-only GitHub release operations, never edits an existing
release or replaces assets. If an upload partially succeeds, the remaining
release is reported as an error, not overwritten by an automatic retry. An
administrator must inspect that partial publication and choose explicit recovery
or a new version. Never move a tag or replace published artifacts to recover.
The scheduled `check:release-tagged` guard still reports an unpublished version.

## Required GitHub Actions secrets

| Secret                              | Purpose                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `RELEASE_PUSH_TOKEN`                | Dedicated administrator Contents-write token for manual preparation only |
| `WINDOWS_CERTIFICATE_P12_BASE64`    | Base64-encoded Authenticode PKCS#12 certificate                          |
| `WINDOWS_CERTIFICATE_PASSWORD`      | Password for the Windows PKCS#12 certificate                             |
| `APPLE_CERTIFICATE_P12_BASE64`      | Base64-encoded Developer ID Application PKCS#12 certificate              |
| `APPLE_CERTIFICATE_PASSWORD`        | Password for the Apple PKCS#12 certificate                               |
| `APPLE_SIGNING_IDENTITY`            | Full Developer ID Application identity                                   |
| `APPLE_ID`                          | Apple account used by the notarization service                           |
| `APPLE_APP_SPECIFIC_PASSWORD`       | App-specific password for notarization                                   |
| `APPLE_TEAM_ID`                     | Apple Developer team identifier                                          |
| `UPDATE_SIGNING_PRIVATE_KEY_BASE64` | Base64-encoded Ed25519 PKCS#8 private key                                |
| `UPDATE_SIGNING_PUBLIC_KEY_BASE64`  | Base64-encoded Ed25519 SPKI public key                                   |

The workflow installs dependencies, builds Rust sidecars, runs Vite and Forge
packaging hooks, and generates compliance resources before any private
credential is decoded. Those broad build processes receive only the public
update key.

Windows certificate material is decoded only inside the dedicated app-signing
and Squirrel-construction step. The signer runs in a scrubbed child environment
containing the certificate path and password plus the minimum Windows process
environment. macOS certificate material is imported into a temporary keychain
only for the dedicated sidecar/app signing process. The temporary keychain is
added to the front of the user keychain search list while preserving its prior
entries, allowing codesign to build the certificate chain; the prior list is
restored before the temporary keychain is deleted. Before signing, CI checks
that the configured identity is present and valid for code signing, but emits
only generic missing/invalid diagnostics rather than certificate identities or
fingerprints. Identity rows with trailing status annotations are still treated
as present; only the valid-identity query determines code-signing validity.
The signing child receives only the identity and temporary
keychain path, not the certificate bytes or password. A separate scrubbed
process receives only the Apple ID notarization credentials. The temporary
certificate and keychain are removed before ordinary archive makers run, and
any search-list or cleanup failure fails the release step. Credentials are
never exported through `GITHUB_ENV`, written into the repository, or uploaded
as artifacts.

The signing step replaces its Bash entry process with the helper via `exec`,
so runner cancellation reaches the helper rather than only its parent shell.
On normal `SIGINT`/`SIGTERM` cancellation the helper stops starting signing
work, forwards cancellation to its active signing child, waits for that child
to close, and runs the same restoration/removal path. Cleanup commands are
allowed to finish rather than being aborted by cancellation. `SIGKILL`,
runner termination, or a child that refuses to exit cannot guarantee cleanup.
PKCS#12 passwords are passed unchanged, including significant whitespace.

Generate the detached update-signing key pair on a trusted offline machine:

```sh
openssl genpkey -algorithm ED25519 -out update-private.pem
openssl pkey -in update-private.pem -pubout -out update-public.pem
```

Base64-encode each complete PEM file, including its header and footer, before
storing it in the corresponding GitHub secret. Keep the private key offline
outside GitHub as a recovery backup. The metadata generator derives the public
key from the private key and refuses to publish if it does not match the public
key embedded into the release build.

## Release sequence

Before a tagged macOS release build, CI checks that all six required Apple
secrets are present. This presence-only preflight does not decode or pass their
values to the build processes.

1. Each platform builds its Rust sidecar and runs `electron-forge package`
   without signing or notarization credentials. The resulting application
   already contains the generated compliance resources and embedded public
   update key.
2. The Windows signing process recursively signs the packaged PE files with
   `@electron/windows-sign`, then constructs and signs Squirrel artifacts with
   `electron-winstaller`'s modern `windowsSign` path. Both use SHA-256 and an
   RFC 3161 timestamp. A later secretless Forge maker creates the portable ZIP.
3. The macOS job builds `model-core` for `x86_64-apple-darwin` and
   `aarch64-apple-darwin`, combines them with `lipo`, signs the packaged
   universal sidecar first, and then signs the outer app. A separate process
   submits the signed app for notarization and staples the ticket. Only after
   those credentials are gone do secretless Forge ZIP and DMG makers run.
4. CI verifies Windows signatures and timestamps, the universal sidecar and
   outer macOS signatures, architectures, stapled ticket, Gatekeeper
   assessment, packaged resources, and reproducible compliance outputs. It
   also runs `scripts/check-sidecar-dylibs.mjs`, which rejects any sidecar
   slice linking a dylib outside `/usr/lib` or `/System/Library`. The sidecar
   bundles no libraries, so any other dependency resolves to whatever exists
   on the user's machine. In beta.8 that was Homebrew's liblzma, which
   hardened-runtime library validation rejected for its foreign signing team,
   killing the sidecar at launch (#828). The check is deliberately stricter
   than library validation.
5. After both jobs pass, the publish job publishes the platform artifacts.
   Stable releases also hash the Windows installer and universal macOS ZIP into
   `latest.json`, sign those exact bytes with Ed25519, and publish
   `latest.json.sig`. Beta releases do not publish update metadata.

Before upload, CI normalizes every artifact name to the
`[A-Za-z0-9._-]` set. Metadata generation rejects any other name so GitHub
cannot rewrite a signed asset name and leave its download URL pointing at a
nonexistent file.

The package version must exactly match the tag (`package.json` version `1.2.3`
requires tag `v1.2.3`).

## Beta prereleases

A semver prerelease tag (`v1.2.3-beta.1`, matched by the `-` in the tag name)
publishes a GitHub prerelease with signed and notarized macOS artifacts.
The macOS job uses the same isolated signing and notarization processes as
stable releases and requires all six `APPLE_*` secrets in the table above.
Missing credentials, rejected notarization, invalid signatures, or a failed
stapled-ticket/Gatekeeper check fail the build and prevent publication; there
is no unsigned macOS beta fallback. Windows Authenticode and update-metadata
signing remain stable-only. Betas ship:

| Platform | Artifacts                                      | Trust state                                     |
| -------- | ---------------------------------------------- | ----------------------------------------------- |
| Windows  | Unsigned Squirrel `Setup.exe` and portable ZIP | No Authenticode signature, so SmartScreen warns |
| macOS    | Universal ZIP and DMG                          | Developer ID signed, notarized, and stapled     |

This policy applies to new tags built with this workflow. Previously published
unsigned betas are unchanged; publish a new beta version rather than replacing
or retagging existing release artifacts.

`package.json` must carry the prerelease version too, so tag `v1.2.3-beta.1`
requires version `1.2.3-beta.1`.

A beta never publishes `latest.json`, and the publish job fails if one is
present. GitHub excludes prereleases from `releases/latest`, which is the URL
the app reads, so a beta is never offered as an automatic update. Beta builds
still embed the update public key when it is configured, so an installed beta
upgrades itself once the next stable release is published. Because a beta signs
no update metadata, the publish job verifies the private key still matches that
embedded public key when both keys are configured, rather than leaving a
mismatched pair to surface at the next stable release.

## In-app update trust and recovery

Release builds embed only the Ed25519 public key. On startup the main process
downloads `latest.json` and `latest.json.sig`, bounds both responses while
streaming, verifies the detached signature, requires trusted GitHub release
URLs, rejects versions below the trusted running app version, and verifies the
selected artifact's signed size and SHA-256 digest before staging it.

Downloads use a `.part` file and an atomically replaced state journal under
`userData/updates`. The journal is untrusted operational state: it can identify
a recovery candidate but cannot forge authority or set the installed-version
floor. Active state retains the exact metadata payload and detached signature.
On recovery the app re-verifies that signature with its embedded public key,
selects the platform artifact from the recovered signed metadata, and binds the
cached file to its signed version, name, size, and digest. Freshly verified
metadata cannot replace that authenticated staged candidate unless its version
is higher.

The trusted running app version is the durable rollback floor. The staged
candidate comparison prevents a network replay from replacing an intact newer
download, but it is not a permanent highest-seen watermark: a same-user
attacker who can delete or replay the journal and artifacts can also remove
that evidence. No stronger monotonic guarantee is claimed.

At macOS staging, one open file descriptor is checked for regular-file type,
signed size, and SHA-256, rewound, and streamed from that same descriptor to
Squirrel. On Windows, an encoded in-memory script is launched from system
PowerShell. It opens the installer with `FileShare.Read`, denying write and
delete sharing, hashes and size-checks that handle, resolves the canonical
filesystem path with `GetFinalPathNameByHandleW`, and starts only that resolved
target while retaining the handle. The installer is shell-launched from the
fixed canonical executable path and fixed `--silent` argument so it cannot
inherit the helper's protocol handles. The helper has a bounded lifetime, and
the app quits promptly after its exact `STARTED:<pid>` transcript confirms child
creation rather than waiting for the installer to exit.
An interrupted download removes the partial file, and a successful upgraded
launch clears the old artifact and journal state.

## Local packaging

`npm run package` and `npm run make` are always unsigned. This preserves local
and package-smoke builds and prevents Forge or its hooks from becoming a
credential-bearing signing path. The packaged macOS app is ad-hoc signed after
packaging so Apple Silicon can execute it; the universal build cannot be ad-hoc
signed per architecture because that leaves `_CodeSignature` in the arm64 build
only and aborts the universal merge. Official tagged jobs invoke the dedicated
platform signing scripts after secretless package output exists and fail closed
if any required credential is missing.

The cryptographic configuration and release ordering are testable without
credentials. A real tag is still required to exercise the external
Authenticode timestamp service, Apple notarization service, certificate trust
chains, stapling, and GitHub Release publication end to end.
