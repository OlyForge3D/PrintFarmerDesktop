# Release trust chain

Official tag builds create complete Forge package output before decoding any
private signing material. Rust builds, Vite, Forge hooks, compliance generation,
dependency scripts, and archive makers run without certificate passwords,
notarization credentials, or prepared key material. Dedicated scrubbed
processes separately sign Windows PE/Squirrel artifacts, sign the universal
macOS sidecar before the outer app, and notarize the signed app. Local and
package-smoke builds remain unsigned and do not enable the production update
channel.

The Windows install boundary holds a no-write/no-delete-sharing handle from
hashing through `Process.Start`. The macOS staging server validates and streams
one open descriptor. Neither platform reopens an attacker-replaceable pathname
after validation.

The in-app updater trusts detached Ed25519 signatures over exact
`latest.json` bytes, then enforces the signed artifact size and SHA-256 digest.
Active journal state retains those exact signed metadata bytes and signature so
a recovered candidate can be re-authenticated and rebound to its artifact.
Fresh signed metadata may supersede an intact recovered candidate only when its
version is higher.

The installed application version remains the durable rollback floor. The
authenticated staged-candidate comparison resists a lower network replay while
that candidate and its signed envelope remain intact; it is not a permanent
highest-seen watermark. A same-user attacker can delete or replay the journal
and artifacts, so no stronger monotonic guarantee is claimed.
