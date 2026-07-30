# Signed releases

Official `v*` tags run `.github/workflows/release.yml`. A tagged release fails
closed unless all platform signing, notarization, and update-signing credentials
are available. Manual workflow runs remain unsigned dry runs so contributors can
exercise packaging without production credentials.

## Required GitHub Actions secrets

| Secret                              | Purpose                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| `WINDOWS_CERTIFICATE_P12_BASE64`    | Base64-encoded Authenticode PKCS#12 certificate             |
| `WINDOWS_CERTIFICATE_PASSWORD`      | Password for the Windows PKCS#12 certificate                |
| `APPLE_CERTIFICATE_P12_BASE64`      | Base64-encoded Developer ID Application PKCS#12 certificate |
| `APPLE_CERTIFICATE_PASSWORD`        | Password for the Apple PKCS#12 certificate                  |
| `APPLE_SIGNING_IDENTITY`            | Full Developer ID Application identity                      |
| `APPLE_ID`                          | Apple account used by the notarization service              |
| `APPLE_APP_SPECIFIC_PASSWORD`       | App-specific password for notarization                      |
| `APPLE_TEAM_ID`                     | Apple Developer team identifier                             |
| `UPDATE_SIGNING_PRIVATE_KEY_BASE64` | Base64-encoded Ed25519 PKCS#8 private key                   |
| `UPDATE_SIGNING_PUBLIC_KEY_BASE64`  | Base64-encoded Ed25519 SPKI public key                      |

The workflow installs dependencies, builds Rust sidecars, runs Vite and Forge
packaging hooks, and generates compliance resources before any private
credential is decoded. Those broad build processes receive only the public
update key.

Windows certificate material is decoded only inside the dedicated app-signing
and Squirrel-construction step. The signer runs in a scrubbed child environment
containing the certificate path and password plus the minimum Windows process
environment. macOS certificate material is imported into a temporary keychain
only for the dedicated sidecar/app signing process. A separate scrubbed process
receives only the Apple ID notarization credentials. The temporary certificate
and keychain are removed by step-local `finally`/`trap` cleanup before ordinary
archive makers run. Credentials are never exported through `GITHUB_ENV`,
written into the repository, or uploaded as artifacts.

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
   assessment, packaged resources, and reproducible compliance outputs.
5. After both jobs pass, the publish job hashes the Windows installer and
   universal macOS ZIP into `latest.json`, signs those exact bytes with Ed25519,
   and publishes the artifacts with `latest.json.sig`.

Before upload, CI normalizes every artifact name to the
`[A-Za-z0-9._-]` set. Metadata generation rejects any other name so GitHub
cannot rewrite a signed asset name and leave its download URL pointing at a
nonexistent file.

The package version must exactly match the tag (`package.json` version `1.2.3`
requires tag `v1.2.3`).

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
credential-bearing signing path. Official tagged jobs invoke the dedicated
platform signing scripts after secretless package output exists and fail closed
if any required credential is missing.

The cryptographic configuration and release ordering are testable without
credentials. A real tag is still required to exercise the external
Authenticode timestamp service, Apple notarization service, certificate trust
chains, stapling, and GitHub Release publication end to end.
