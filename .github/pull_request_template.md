<!--
CLOSING AN ISSUE FROM THIS PR? Read this first -- `check-closing-references`
is a required check, and it enforces a contract that is easy to get wrong
because two different-looking forms below are silently inert.

There are TWO separate declarations, and both must agree:

1. IN THIS BODY, a bare, unfenced closing keyword line, e.g.:

     Closes #123

   This is what GitHub's own parser reads to actually close #123 when this
   PR merges, and it is also the half `check-closing-references` reads back
   as "armed". Only the bare form works. The exact same words, fenced or in
   inline code, do NOT arm anything -- GitHub does not scan code for closing
   keywords, so both of these are INERT and close nothing:

     ```closes
     Closes #123
     ```

     `Closes #123`

   This isn't a limitation to work around, it's the escape hatch: put a
   reference in a fence or inline code exactly when you want to talk about an
   issue in this PR -- "follow-up to #123", "same root cause as #123" --
   without closing it. Bare = closes it. Fenced or inline = discusses it.

2. A DECLARATION FILE at `.github/pr-closes/<branch-slug>.md` (slug derived
   from this PR's head branch name -- see `.github/pr-closes/README.md`),
   containing a fenced block whose info string is exactly `closes`, one bare
   `#<number>` per line -- reusing the fenced syntax here is fine, since this
   file isn't the PR body and GitHub's keyword parser never reads it:

     ```closes
     #123
     ```

   An empty block there is a valid declaration meaning "closes nothing" --
   that's the default this template leaves you with if you don't touch it.

`check-closing-references` fails the PR when bullet 1 (what GitHub armed) and
bullet 2 (what the declaration file lists) disagree. Declaring in the file
without a matching bare line in the body, or vice versa, is exactly the
mismatch it exists to catch.

Delete this comment block once you've done both, then fill in the sections
below. If this PR closes an issue, replace the placeholder line under
"Closes" with a real bare reference (e.g. `Closes #123`); otherwise delete
that line entirely -- don't leave a bare `Closes #` with no number, since that
declares nothing on either side and is not itself an error, just a no-op.
-->

Closes #

## What changed

## Why

## Testing
