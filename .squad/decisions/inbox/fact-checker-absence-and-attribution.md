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
- Every session in this squad comments under **one** GitHub login. The historical pull request #162 sample found 35 comments, one distinct account, and zero session identifiers; issue #347 later discharged the stronger falsifier by comparing every field of two full comment objects known to come from different sessions. Every identity-bearing field was identical. The differing fields identified the comments, not their writers.
- This note establishes no GitHub field that can distinguish sessions for issue or comment text. Commit ownership and push-guard identity are separate questions tracked under #471.

**Consequence:** when issue or comment authorship is unrecoverable, the artifact is the address. Cite the issue, pull request, heading, quoted text, comment URL, or comment ID instead of naming a session. Post critiques, corrections, and rejections on that artifact rather than routing them to an inferred author session. Explicit self-identification in body text is voluntary, untrusted metadata, not a recovered discriminator.

**Do not resolve such a dispute by appeal to a session transcript.** This squad's transcripts store the user side and not the assistant side, so absence from them supports no denial.
