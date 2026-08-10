# An absence at head is not a removal unless the base says it was there

**By:** Ripley — #516, derived while reviewing #409 and while working the
citation-checker design on #421. Neither is a parent; this rule outlives both
and does not depend on either being merged or closed. Filed separately because
it was living only in issue comments that nobody would find.

## The rule

Any checker that reports a reference, symbol, or path as **missing** by
observing only the current head cannot tell a real removal from something that
never existed. Distinguishing the two requires reading the base as well, and no
amount of additional probing at head substitutes for it — the distinguishing
evidence lives at a ref the checker never reads.

```
base   head    cause
 ✓      ✓      unchanged      — reference is fine
 ✓      ✗      REMOVED        — the reference has rotted
 ✗      ✓      ADDED          — added by the change under review, reference is fine
 ✗      ✗      NEVER EXISTED  — typo, rename, or wrong repository
```

A head-only checker observes two outcomes: present and absent. It therefore
merges `{removed, never existed}` into one "absent" cell and `{unchanged,
added}` into one "present" cell. **Two pairs of causes with opposite remedies
land in the same cell.** This is a property of the observation space, not a
bug in any particular script — it cannot be patched out by making the head-side
check smarter, only by reading a second ref.

## The measured instance

`findFirstDuplicateKey`, removed in `3fa31338`, counted as files containing the
symbol:

```
at base (3fa31338^)   2
at that commit        1
at trunk              1
```

A head-only check reports "present" (1 file) and the removal is invisible. Only
reading base shows two definition sites became one. Conversely, a checker that
saw only `absent` at head for some other symbol could not tell whether the
reference had rotted or was pointing at something the change under review had
just added — both are `1` count-of-zero results with no way to separate them.

## The removal-line shortcut is also wrong

The tempting substitute for reading base is to key the alarm on removal lines
in the diff (`-export function X`). Measured over 300 commits of
`origin/development` on `*.ts`, taking every distinct symbol named on a removal
line:

```
distinct symbols named on a removal line          = 7
  still present at trunk                          = 4
  extraction artifact ("that" from prose)         = 1
  apparently gone under `function X`              = 2
    of those, still present under a broader query = 1  (findFirstDuplicateKey)
```

At most one of seven was a clean removal; the rest were signature changes,
moves, or rename-in-place. **A removal line is a statement about text; symbol
existence is a question about a symbol, and the two are only loosely
coupled.** An alarm keyed on removal lines would have fired on six of seven.

## Acceptance, stated so it can be tested

A checker satisfies this rule only if:

1. It reads the reference at **both** base and head and reports the 2×2 cell,
   not a boolean.
2. The four cells map to distinct reported outcomes; in particular `absent at
base, absent at head` is reported differently from `present at base, absent
at head`.
3. The removal fixture asserts symbol **absence at head against symbol
   presence at base** — never against the presence of a removal line in the
   diff, per the six-of-seven measurement above.
4. Every fixture ships a positive control drawn from the corpus under test, run
   in the same execution (per
   `.squad/decisions/inbox/vasquez-same-run-negative-control.md` and
   `vasquez-absence-claims-need-adjacent-positive.md` — this is the same shape
   applied to the base/head axis specifically).
5. Existence queries are form-agnostic — verified by a case where the symbol
   changes form (signature, wrapping) without being removed. A query anchored
   to one syntactic form (`function X`) undercounts, per the `findFirstDuplicateKey`
   false-removal case above.

## Scope

This says nothing about whether a reference is _correct_ — only about whether
an absence has been correctly diagnosed. A checker satisfying all five points
still reports nothing about whether a resolvable reference points at the thing
its surrounding prose claims. That is a separate question, tracked where each
citation checker already tracks it.

## Relationship to existing catalogues

This is the base/head instance of the general family in
`.squad/known-lying-commands.md` (a predicate that answers a neighbouring
question with no visible sign it did so) and of
`.squad/decisions/inbox/ripley-absence-never-strengthens-a-claim.md` (absence
must never license a stronger claim than the evidence supports — here, "absent
at head" alone must never be strengthened to "removed"). It is distinct from
`.squad/decisions/inbox/dallas-ancestry-is-not-content.md`, which is about
commit-ancestry after a squash merge, not about symbol/path presence across two
refs.
