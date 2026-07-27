# Release trust chain

Official tag builds fail closed unless platform signing credentials and the
update public key are configured. Local and package-smoke builds remain
unsigned and do not enable the production update channel.

macOS releases build a universal Rust sidecar first, sign that nested binary,
then let Electron Forge sign and notarize the merged outer app. Release
publication waits for both platform jobs and their signature checks.

The in-app updater trusts detached Ed25519 signatures over exact
`latest.json` bytes, then enforces the signed artifact size and SHA-256 digest.
It persists the highest trusted version to reject replayed older metadata and
uses an atomic update journal to recover interrupted downloads and installs.
