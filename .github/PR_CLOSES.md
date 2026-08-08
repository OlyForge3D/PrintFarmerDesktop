# Closing-reference declaration (legacy, migration fallback)

This file is the pinned-to-commit half of the closing-reference check
(`scripts/check-closing-references.mjs`). It replaces the PR-body fenced
`closes` block that check used to read.

**#622: new PRs should declare in `.github/pr-closes/<branch-slug>.md`
instead of here.** This file was a single slot shared by every open PR,
which meant any two PRs open at once were guaranteed to conflict on it. It
is kept only so PRs opened before #622 keep working unmigrated: a PR is read
from here only when it has no file of its own under `.github/pr-closes/`.
See `.github/pr-closes/README.md` for the new format and migration details.

## Why this file exists instead of a PR-body block (#415)

A PR body is mutable independently of the commit graph: it can be edited
after a check has already reported green on a given head SHA, with no new
commit and no re-run of any required context. A green "Closing-reference
declaration" check pinned to SHA `X` therefore said nothing about the body in
place when it ran, or the body in place at merge time -- #400 merged with
seven green contexts, every one of which had judged a body that had since
been replaced twice.

This file lives in the commit tree, so it changes only when a commit changes
it. `synchronize` -- an event every required-context workflow already
receives -- re-runs the check whenever this file's content changes on the
head commit. Editing only the PR body can no longer affect this half of the
check at all.

GitHub's own closing-keyword parser (which decides `closingIssuesReferences`,
the _armed_ half this check compares against) still reads the PR body --
that part is GitHub's, not ours to relocate. So arming still happens from the
body; only the declaration of _intended_ arming moved here.

## Format

List every issue this PR is intended to close, one bare `#<number>` per
line, inside a fenced block whose info string is exactly `closes`:

```closes
#464
```

An empty block (`\`\`\`closes`immediately followed by`\`\`\``) is a valid,
meaningful declaration: it asserts this PR closes nothing. No block at all
means nothing was declared, which the check treats as a fail-closed "declares
nothing" -- any armed closure is then reported as a mismatch.
