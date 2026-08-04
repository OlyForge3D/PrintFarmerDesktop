# Disagreement between derivations is evidence the value was passed in

Four instruments were tried to answer one question — which URL will this push
actually reach. `git ls-remote --push`, `git ls-remote --get-url`, `git remote
get-url --push`, and `--get-url --all` as a fourth candidate that was drafted
and not shipped. Three of the four were written, merged, and reverted in turn.
Each was replaced because it was wrong in a configuration the previous one had
not been tested against, and each replacement was chosen by reading
documentation about how git resolves `pushurl` and `pushInsteadOf`.

The answer was an argument the caller had already been handed. Git passes the
remote name **and its URL** to a `pre-push` hook as `$1` and `$2`, and the hook
was forwarding `"$@"` the entire time. Nothing needed to be derived.

That is worth stating as a signal rather than as an anecdote, because the
thrashing was legible long before the fix was:

> **When several instruments disagree about a value, check whether the caller
> was handed it. Sustained disagreement between derivations is evidence that
> you are deriving something that was passed in.**

Disagreement between two derivations of a genuinely derived value is a bug in
one of them and converges once it is found. Disagreement that survives three
replacements is a different shape: it means the value depends on state the
deriving code cannot see, which is usually true precisely because some other
layer already resolved it and moved on.

## The narrow claim, which is the part worth keeping

The retraction that accompanied this fix was that _"there is no longer a
configuration in which the push URL is ambiguous"_ — over-general, drawn from
two sampled configurations, and the same defect as the note being written in
the same breath. A verified instance is not a validated category.

But the retraction swallowed a true and narrower statement that a reader
actually needs, and which is still load-bearing on trunk:

> **The ambiguity does not exist at the layer the hook runs at.** Git has
> already resolved `pushurl`, `pushInsteadOf`, and multi-URL remotes by the time
> it invokes the hook, and it invokes the hook **once per URL** with that URL in
> `$2`. So a hook-invoked guard has no resolution problem to solve.

That is not the same as saying no configuration is ambiguous, and the
distinction is visible in the shipped code:

```
const target = location.trim() || readPushUrl(remote);
```

The derivation is still there and still reachable, because the guard can be
called directly rather than as a hook, and that caller has no `$2` to pass. So
`readPushUrl` still has to be correct — the argument removed the ambiguity from
the hook path only. Anyone who read the bare withdrawal and concluded the
function was now dead weight would be wrong.

## Why the qualifier has to be filed and not just the retraction

A retraction is socially unchallengeable. It reads as humility, so nobody audits
it — which means a withdrawal is the least-reviewed statement anyone makes, at
exactly the moment their reasoning has been shown to be unreliable. That
combination has already destroyed a true result elsewhere in this repository:
a session retracted a finding that was correct and the retraction went
unexamined because withdrawing looks like rigour.

So the discipline is not _withdraw less_. It is:

> **A withdrawal must state what survives it.** Retracting the over-general
> claim without recording the narrow true one leaves the next person to
> re-derive ground that was already established — and they will re-derive it
> from the same documentation that produced three wrong answers the first time.

## The method underneath, which generalises past push URLs

The fix was not found by reading more carefully about `pushurl` resolution. It
was found by probing what git actually hands the hook. That is the same move as
taking conflict ids out of the writer rather than asserting literals in a test,
and as running `git rev-parse` before making a claim about a ref:

> **Ask the system what it did; do not reconstruct what it should have done.**

Reconstruction fails silently and confidently, because a reconstruction is
self-consistent by construction — it agrees with itself no matter which
configuration you are actually in, and the configuration you are in is invisible
to you by default.
