## 2026-08-09: A line-number citation into an unmerged file is not durable — it keeps resolving and points somewhere else

**By:** Bishop, filed as #199. Adjacent to #186 (uncitable constraints) and #197 (aimed positive controls), distinct from both.

---

**The claim.** This repo's citation rule is sound: a correction carries a file, a line, an issue — something greppable — or it is a preference. **But a line number into a file that is not on `development` is not a durable citation.** It is a pointer into a branch that will be rebased, squashed, or amended before it lands, and the number will change without anything announcing it. Worse, it **keeps resolving**: the file still exists, the line still has content, and the content is now a different paragraph. The citation does not break, it lies.

This is the same failure shape as a commit-pinned URL serving a superseded document (`.squad/decisions/inbox/ripley-go-and-look.md`), except the pointer here is *more* fragile: a line number is invalidated by any edit above it, not only by a rewrite of the whole object.

**The instance.** `.squad/decisions/inbox/ripley-go-and-look.md` was, at the time of citation, in open PR #163 and not on `development`. It was cited as `ripley-go-and-look.md:37` for the rule *"never reconstruct an identifier — copy it from the tool that emitted it."* Read at the object, on PR #163's head:

```
 37: **The remedy is not "two sources."** An earlier version of this note said …
 45: **Never valid — no reading was ever taken.** … Remedy: **never reconstruct
     an identifier — copy it from the tool that emitted it.**
```

Line 37 is a different rule entirely. The wording quoted alongside the number was exact, which is what made the citation persuasive — **an accurate quotation with an inaccurate pointer reads as more verified than either alone.** The citation was propagated through two hands before anyone opened the file, and was caught only because the session receiving it went and read the source instead of trusting the chain.

**Why it is worth a rule.** Line numbers in unmerged files will keep being produced, because while working in a branch the line number is the most natural and most precise thing to hand. The defect is invisible from where the citation is written — the author's checkout genuinely has the rule at that line. And the decay is silent in the direction that preserves confidence: the reference still points somewhere, so a reader who follows it lands on real prose and has no signal that they are in the wrong place unless they already know what they were looking for.

**Rule adopted** (see `.squad/fact-checker/policy.md` Hard Rules, and the decisions.md entry recording it):

- When citing a file **not yet on the default branch**, cite the **heading or a quoted phrase**, not a line number — headings survive rebases and are greppable, which is the property the citation rule actually wants.
- Name the **PR** that carries the file, so the reader knows the target is provisional.
- If a line number genuinely helps, mark it as of a specific commit and expect it to rot.
- For files already on `development`, line numbers are fine and remain preferred.

**Corollary, stated separately because it is easy to lose:** an exact quotation does not validate the pointer attached to it. Quote and location are independent claims and both need checking; a correct quote makes a wrong line number harder to spot, not easier.

**Scope.** Documentation and protocol only. No production code, no test changes, no new mechanical check — the existing `scripts/check-citation-reachability.mjs` machinery targets commit-SHA reachability for `.squad/fact-checker/{policy,audit-trail}.md` and is a different, already-solved problem (an object either exists for a reader or it does not). A line number into a still-open PR resolves to *something* for every reader regardless of correctness, which is exactly why it cannot be caught mechanically the same way and is a convention/practice fix instead.
