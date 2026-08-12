# Closing-reference declaration

Keyed to the publication ref `dev/jpapiez/candidate-parse-isolation-r2`.

The ref name is deliberately **not** derived from a commit SHA. Earlier rounds
named each backup ref after its head (`…-backup-<sha>`), which makes the
declaration impossible to satisfy: the check keys on the head branch slug, so
the file must name the ref, but adding the file changes the head — and with it
the ref name — so the slug never matches its own commit. A fixed name breaks
that circle, and this file stays valid for every future push to it.

Supersedes closed PRs #720 and #722, both closed under the
publish-only-when-ready policy rather than rejected.

No tracked issue exists for this work, so the empty block below is a deliberate
declaration that this PR closes nothing, per `.github/pr-closes/README.md`.

```closes

```
