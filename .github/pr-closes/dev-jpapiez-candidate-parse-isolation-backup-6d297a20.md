# Closing-reference declaration

This PR supersedes closed Draft #720 under the publish-only-when-ready policy.
It is published from an append-only backup ref, so it needs its own declaration
keyed to that branch slug — without one the check falls back to the legacy
shared file and reports a closure this PR never armed.

No tracked issue exists for this work, so the empty block below is a deliberate
declaration that this PR closes nothing, per `.github/pr-closes/README.md`.

```closes

```
