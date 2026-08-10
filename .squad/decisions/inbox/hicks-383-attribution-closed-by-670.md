# #383 is resolved by #670 — verified against artifacts, not against claims

**Verified on `dev/jpapiez/squad-383-attribution-channel`, based on `development` at
`670905f4`.** This is a re-verification, not a new proposal: the mechanism this issue
needed was already chosen, built, and merged as a child issue while #383 stayed open, and
what follows checks that claim against the actual repository state rather than repeating
it.

## What #383 measured

- `author` is constant: 177/177 (later 178/178) PRs authored by `jpapiez`.
- `reviewDecision` is constant _by construction_: self-approval 422s, so 0 `APPROVED`
  reviews repo-wide is not a review-discipline finding, it is a platform guarantee.
- The commit trailer collides: one `Copilot-Session` value covered 74 commits across
  39h33m (`.squad/decisions.md`, 2026-08-07) — longer than any one session's lifetime.
- The branch namespace is **not injective**: 171 distinct names across 177 PRs, 5 names
  carrying 12 PRs, concentrated in the auto-generated names nobody renames — and a later
  correction on this same issue ran the control that disproves "it's at least a working
  channel for the session that renamed its branch": 14 `ripley-` branches exist and that
  session could not determine which, if any, were its own. No field in this repository
  distinguishes "authored by session A" from "authored by session B posing as A."

## What was decided, and why the other two candidates were declined

Ripley's sign-off on this issue (2026-08-09) evaluated all three remedies the issue body
named and declined two of them for stated reasons, not by omission:

- **Branch-prefix enforcement** — declined. It hardens the exact property that failed: a
  self-reported, unauthenticated string. The `ripley-` control above is the direct
  evidence — enforcing a prefix format doesn't stop two sessions from writing the same
  prefix, and does nothing for the 12 PRs already collided under 5 names.
- **Per-session bot account** — declined _for now_. It is the only remedy that would make
  `author`/`reviewDecision` real signals again (GitHub-authenticated identity can't be
  spoofed by prompt text the way a branch name or trailer can), but this repo has zero
  bot-account infrastructure today, `enforce_admins` stays `false` with `jpapiez` as sole
  admin by a separately re-affirmed decision, and standing up bot infra is a
  disproportionately large project to justify from this issue alone. Not ruled out
  permanently.
- **Mechanize the existing trailer** — chosen. The trailer's defect was traced to
  provenance of the _value_, not the _scheme_: `git-workflow/SKILL.md` used to instruct
  agents to type `--trailer "Copilot-Session=<uuid>"` from a prompt, and the 74-commit
  collision was that hand-transcription going wrong, not a design flaw in having a
  trailer at all.

## What #670 actually shipped, checked against this branch, not against the issue thread

```
.githooks/prepare-commit-msg                    present
scripts/prepare-commit-msg.mjs                   present
scripts/check-copilot-session-trailers.mjs       present
scripts/check-copilot-session-collisions.mjs     present
.github/workflows/copilot-session-collisions.yml present
.squad/skills/git-workflow/SKILL.md              updated: "Do not type
                                                  --trailer Copilot-Session=... yourself"
```

The hook reads `COPILOT_AGENT_SESSION_ID` from the process environment at commit time —
a channel the CLI runtime sets, not a value in the agent's prompt — so the trailer can no
longer be hand-transcribed wrong the way the 74-commit collision happened. The companion
scheduled workflow (`copilot-session-collisions.yml`, not a `pull_request` check, because
a collision is a property of trailer history across many commits, not of one PR's diff)
audits `development` for malformed trailers and any value repeating across a span wider
than a session-lifetime bound, so a regression back to the old pattern is caught
mechanically rather than by another audit note.

Merge commit `d70e1233` ("Mechanize Copilot-Session trailer injection via git hook (#670)
(#675)") is on `development`, and this branch's own `git log` includes it.

## What remains explicitly unresolved, and why that's the right scope

`author` and `reviewDecision` on this repository are still constant, and will stay
constant until a per-session bot account exists — that gap is not fixed here and #383
correctly declined to force it. The branch namespace remains non-injective for the 12
PRs already collided; #670's acceptance criteria explicitly leave pre-existing history
alone rather than attempt an unfalsifiable retroactive fix. Neither omission is new
information — both were named and reasoned about in the sign-off this note verifies.

## Disposition

No further mechanism is warranted from this issue. Recommending #383 be closed with a
reference to #670/#675 as the shipped remedy, per Ralph's own note on this issue that a
second `needs-analysis` retriage arrived after the sign-off and after #670 had already
merged.
