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

The workflow decodes certificates only into the runner's temporary directory.
The Apple certificate is imported into a temporary keychain. Passwords and
notarization credentials are scoped to the individual preparation, signing, or
packaging step that consumes them; they are never exported through
`GITHUB_ENV`. Cleanup runs even after failed builds. Private material is never
written into the repository or uploaded as an artifact.

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

1. The Windows job builds the Rust sidecar, signs the packaged application and
   Squirrel installer with SHA-256 and an RFC 3161 timestamp, then verifies both
   signatures and timestamp certificates with `Get-AuthenticodeSignature`.
2. The macOS job builds `model-core` for `x86_64-apple-darwin` and
   `aarch64-apple-darwin`, combines them with `lipo`, and signs that universal
   sidecar before Electron Forge signs the outer universal app.
3. Electron Forge submits the signed macOS app for notarization. CI verifies the
   sidecar and app signatures, universal architectures, stapled notarization
   ticket, and Gatekeeper assessment.
4. After both jobs pass, the publish job hashes the Windows installer and
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
a recovery candidate but can never authorize an installation or set the
rollback floor. Every startup refreshes and verifies signed metadata, rebinds a
cached candidate to the signed version, file name, size, and digest, and hashes
the artifact again at the staging or execution boundary. An interrupted
download removes the partial file. An interrupted install is retried only after
that fresh signed-metadata validation; otherwise it is discarded. A successful
upgraded launch clears the old artifact and journal state.

## Local packaging

`npm run make` remains unsigned unless `PRINTFARMER_REQUIRE_SIGNING=1` is set.
This preserves local and package-smoke builds. Setting that flag without the
platform credentials or update public key is an error; release contexts never
silently fall back to unsigned output.

The cryptographic configuration and release ordering are testable without
credentials. A real tag is still required to exercise the external
Authenticode timestamp service, Apple notarization service, certificate trust
chains, stapling, and GitHub Release publication end to end.
