# Ancestry cannot tell you whether the code you verified is the code that shipped

We already have the rule that a green belongs to a tree and not to a diff. The
question that rule leaves open is how to check it, and the check almost everyone
reaches for is `git merge-base --is-ancestor <verified> <merged>`. Under a squash
merge that check is wrong, and it is wrong in the direction that is hardest to
notice: it reports that correctly verified content was never verified, for every
squash-merged pull request in the repository, without ever reporting an error.

The worked example is PR #272. Two heads of that branch passed all seven required
contexts, and only one of them is the content that shipped.

```
d9341c1   7/7 green    tree 1c2a0c0d8cdeaf96d16a183b1f0a0ce407b27d5d
b89390f   7/7 green    tree e0e9339381f494c48ee360b08b19997c7eefc0c2
9c5b867e  shipped      tree e0e9339381f494c48ee360b08b19997c7eefc0c2

git merge-base --is-ancestor d9341c1 9c5b867e   ->  exit 1
git merge-base --is-ancestor b89390f 9c5b867e   ->  exit 1
```

`d9341c1` was green, and the tree it was green against is not the tree that
shipped — a base sync landed on top of it afterwards. `b89390f` was green against
the exact tree that shipped, byte for byte. **These are two materially different
situations, and ancestry returns the same answer for both.** A check that returns
the same value for the case you care about and the case you do not has no
discriminating power, which is the same defect this repository has been
cataloguing in tests all week, sitting in the verification of the tests.

The reason is that `9c5b867e` is a squash. Its parent is `ddff515`, which is an
ancestor of the verified head rather than a descendant of it, so the branch's own
commits are not in the history of what shipped and never will be. Nothing is
broken; the merge is correct and the content is correct. The predicate is simply
answering a question about commit reachability that was never the question. What
was being asked is whether the bytes that passed CI are the bytes on the default
branch, and reachability is not a rendering of that.

The remedy is the tree. Two commits with the same tree object have identical
content by construction, and the comparison is a single equality between two
forty-character values rather than a computed diff:

```
git show -s --format=%T <verified>
git show -s --format=%T <merged>
```

An empty `git diff <verified> <merged>` establishes the same thing and is fine.
The tree read is preferable only because it cannot be weakened by accident —
there are no pathspecs to forget and no way to compare a subset of files while
believing you compared all of them, which is a mistake I made earlier in the same
investigation by diffing only the three files I had changed and concluding more
from it than that comparison supported.

What the rule must not overclaim is the failing case. Tree identity is decisive
when it holds: the verified content shipped, and no further argument is needed.
When it does not hold, it establishes only that the trees differ, which is the
ordinary outcome whenever the base moved between the last green and the merge. It
is then a prompt to ask what differs, not a finding that the code was untested.
The asymmetry matters because the tempting misreading of a failed tree comparison
is exactly the false alarm that ancestry produces unconditionally.

There is a second way to get this wrong, and it produced a false finding in this
repository within a day of the rule above being written. `--is-ancestor` does not
print an answer; it communicates through the exit status, and it exits **0 when
the answer is yes**. That is inverted relative to every truthiness intuition, and
a session reading `exit 0` as "not an ancestor" concluded that the squash commit
which landed a pull request is not reachable from the branch it landed on, and
circulated that to three others.

```
git merge-base --is-ancestor d70d38f origin/development   ->  exit 0
```

`d70d38f` is the commit that landed #203. It is an ancestor of `development`,
necessarily and unremarkably, and `exit 0` is the test saying so. The inverted
reading turns a correct instrument into a dramatic result, which is the direction
that gets repeated.

The rule above already contains its own antidote, and it costs one command. Ask
what the field would read if the thing you care about were different:

```
git merge-base --is-ancestor origin/development origin/development   ->  exit 0
git merge-base --is-ancestor origin/development <any earlier commit> ->  exit 1
```

A branch is trivially its own ancestor, so the first must read yes. If your
reading of the exit status makes that line say no, the reading is wrong and not
the repository. **Run the control in the same call as the measurement**, because
the failure here is silent, self-consistent, and survives being checked again by
the person who made it.

None of this rescues ancestry as a merge test — the section above stands, and the
remedy is still the tree. It is worth recording only because the wrong reading
argues _harder_ for the right conclusion, and a mistake that flatters the
argument it appears in is the one least likely to be examined.

## The operand is the whole distinction, and one live rule depends on it

The section above and `.squad/decisions.md:57` look like they contradict each
other, and they do not. They pass different commits to the same command:

| operand                                          | meaningful? |
| ------------------------------------------------ | ----------- |
| verified **branch head** vs the squash           | no          |
| the **squash merge commit** vs `origin/<branch>` | yes         |

The first is the question this note opens with, and ancestry cannot answer it —
the branch's commits are not in the squash's history and never will be. The
second is a different question entirely: _did the ref update actually land._ It
is answerable, ancestry answers it correctly, and the answer is `exit 0`.

That second form is load-bearing. It is the control recorded on 2026-07-25 after
two `gh pr merge` calls fired about three seconds apart both reported `MERGED`
while one merge commit was silently orphaned, taking roughly six thousand lines
of `native/model-core` off `development` for several hours with CI green
throughout, because the tests mocked the sidecar rather than exercising it.

**So the inverted reading does more than mislabel a commit.** Believed, it says
the check that catches that race returns a conviction for a healthy merge, and
the natural response is to stop trusting it — retiring a working control that
exists because the failure it detects already happened here once.

The general shape is worth stating separately, because this is the second form of
it seen in two days. A `head_sha`-pinned CI run stays green forever, so re-reading
it confirms a claim that has since gone stale — a durable fact answering a
perishable question. Ancestry under a squash is the inverse: a durable fact that
refutes a claim which is true. Both are correct values, both survive re-reading,
and neither can be caught by checking them again, because the error is not in the
value but in the match between the field and the question. The only thing that
exposes either one is asking what the field would read if the thing you care
about were different — and in the ancestry case the answer is that it would read
exactly the same.
