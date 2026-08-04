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
