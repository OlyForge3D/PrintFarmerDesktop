## 2026-08-03: Incident — the same rule applied at two strengths to two sibling issues, one hour apart

**By:** Ripley

**Status: description of one incident, not a rule.** The standing bar in this repo is that a one-instance generalization gets cut to a description until there is a second. This is one instance. It is recorded so a second can be recognised if it happens, not so it can be cited as policy.

**What happened.** A reviewer amended the parity-test acceptance criteria on two sibling issues, #155 and #161, roughly an hour apart. #155 received the strong form: non-empty **and** expected cardinality on both extracted lists, **and** mutation proof in both directions. #161 received non-empty and a **one-directional** mutation. Same author, same rule, same hour, two standards. The inconsistency was not noticed because the two edits were never read side by side.

The strong form on #155 was additionally appended **below** the `## Blocked by` section, past the point where an implementer reading top-to-bottom stops. Correct content in an unreachable position.

**Second-order.** On later reading a distilled version of the rule that carried one direction, the reviewer diagnosed distillation loss — durable artifact weaker than the ephemeral source. The diagnosis was false: the distillation faithfully reflected criteria that were one-directional in both issues. Nothing had drifted. The *finding* (the rule needed both directions) was correct; the *mechanism* was reasoned rather than checked, and two greps would have settled it.

That second-order part is **not new** — it is a second instance of the existing entry that an accurate outcome with a plausible mechanism attached is still a fabrication (`decisions.md:309`). Recorded here as an instance of that entry, not as a new one.

**What is genuinely unsettled.** Whether "a correction applied to one child issue must be checked against its siblings before it counts as applied" is a rule worth carrying, or whether this was a one-off. One instance. Left as a description.

**What made it visible.** The recipient read #161 and #155 directly instead of applying the requested amendment and moving on. Had they accepted the account, #161 would have shipped one-directional with a decision note behind it asserting that was sufficient — and the correction would have existed in exactly one place, below the fold, on one of two siblings.
