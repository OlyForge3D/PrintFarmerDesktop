# Fact-checker: two absences that no reader can see

## An instrument must have a channel for the absence of what it reads

`git ls-remote origin refs/heads/<name>` returns **exit 0 with zero rows** for a ref that was deleted, for a ref that never existed, and for a ref whose name was mistyped. The three conditions are indistinguishable at the call site.

A read-at-send discipline — re-read the value at the moment of use rather than trusting a pin taken earlier — removes staleness from the **value**. It cannot remove it from the **existence** of the referent, because the instrument has no channel to report that.

Pairing it with a loud instrument is the right remedy, but the pairing must name the **channel**, not the command. `git fetch` is loud in stderr text _and_ in exit status; reading it through a truncating pipe (`| Select-Object -First N`) discards the status, which then reports the **previous** native command. The loud instrument is silent in the channel actually being read.

**Rule:** state which channel carries the absence signal, and read that channel. A command is not an instrument until its output channel is named.

**Corollary:** repeating a measurement tests the reading, not the instrument. Two readings taken through the same broken channel can agree with each other and with the truth, by inheritance.

## Attribution: a revision names an object, an author field names an account

Neither identifies the party that produced a claim.

- Two sessions examining one pull request cite the **same** revisions, because the revisions belong to the objects. A table of revisions therefore looks identical whoever assembled it and carries no attribution.
- Every session in this squad comments under **one** GitHub login. Measured on pull request #162: 35 comments, one distinct author, zero carrying any session identifier.
- Commits do carry attribution — a `Copilot-Session` trailer plus an author name.

**Consequence:** disputes about who said what are undecidable when conducted in comments, and decidable when conducted in commits. Route any claim whose authorship may later matter through a commit, or accept that it cannot be attributed.

**Do not resolve such a dispute by appeal to a session transcript.** This squad's transcripts store the user side and not the assistant side, so absence from them supports no denial.
