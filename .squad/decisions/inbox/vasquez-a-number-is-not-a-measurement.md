# A number that reads like a measurement is not one until you know what it counts

**By:** Vasquez — from PR #561, with Ripley, who caught it. Recorded because it is
my own instrument fault, found by someone else, and the generalisation is worth
more than the correction.

## The rule

**Before a number becomes evidence, establish that it could have come out
differently. A measurement that returns the same value in the state you are
diagnosing and in the state where your diagnosis is false has not measured
anything — it has agreed with you.**

## How it arose

Reviewing a path-containment guard, I reported that `validateRemovalTarget` took
no filesystem resolver and therefore ran its registry-membership test on an
unresolved path — the root cause of a Windows 8.3 failure and a macOS
`/var` → `/private/var` failure on the same commit. The conclusion was correct
and the fix confirmed it.

Part of the evidence offered for it was the function's arity, reported as `2`.

`Function.length` **excludes every parameter that has a default value**, and
excludes rest parameters. Measured across the defect and its fix:

```
31d7d52e  Function.length = 2
          toString()      = (target, worktrees, platform = process.platform)
          realpathImpl present? false

9991065e  Function.length = 2
          toString()      = (target, worktrees, platform = process.platform,
                             realpathImpl = filesystemRealpath(platform))
          realpathImpl present? true
```

Same number on both sides of the change it was cited to establish:

```
.length   equal across the fix?  true   -> cannot discriminate
toString() equal across the fix?  false  -> discriminates
```

Every parameter that carries a resolver, a platform, or an injection seam is
exactly the kind that has a default. So `.length` is blindest precisely where
dependency injection lives, which is where this class of review looks.

## Why this is worse than an absence test, not milder

An absence claim — "no failures found" — fails open, and the danger is that
nothing appears. This is different and sharper: it produced a **positive,
specific, confident claim about a function signature**, from a number that does
not mean what its name suggests. It reads like the strongest kind of evidence.
Had the parameter been present and working, it would have reported `2` and I
would have declared it missing.

The conclusion survived only because the source text also supported it. The
instrument contributed nothing and could not have contradicted me.

## The generalisation

This is one level above the thing it resembles. A test can be non-vacuous,
correctly asserted, mutation-sensitive, and still not aimed at the defect it
exists for. The same is true of a **measurement**: `.length` is real, documented,
deterministic and returns an honest count — of a set that is not the set the
sentence built on it describes.

So the check is not "is this number correct?" It is: **what set does this number
count, and is that the set my claim is about?**

## The operational form

- For a signature claim, read `toString()` or the source. Never `Function.length`.
- Before citing any number, name the state in which it would have come out
  differently. If you cannot, it is not evidence yet.
- Prefer a measurement run across **both** sides of the change: the defect and
  the fix. A figure that is identical across a change cannot support a claim
  about that change.
- Applies beyond arity: `length` on a sparse array, a match count that counts
  call sites rather than blocks, a duration during an outage, a check-run rollup
  of zero. Each is an honest count of the wrong set.
- When someone else catches your instrument, file the generalisation rather than
  the correction. The correction repairs one claim; the generalisation is what
  keeps.
