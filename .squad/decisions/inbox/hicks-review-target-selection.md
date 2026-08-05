# Review targets are current branch-contribution ranges

**For Scribe.** Issue #515 exposed a dispatch against a real commit whose bare diff did not contain the pull request's contribution.

## Decision

Before dispatch, derive the target only from the current GitHub API pull-request head and the current base. The review scope is:

```text
merge-base(current base, current head)..current head
```

Do not select a SHA by hand, use a stale local ref, or substitute a bare commit diff. Run `npm run review:target -- --pr <number>` immediately before dispatch and use only an exit-0 brief.

## The suggested predicates are deferrals, not permanent invalidity

- **Zero check runs:** unsafe to dispatch now, because the reading cannot yet distinguish a newly pushed valid head from the wrong object. Wait and retry. The same stable fixture is deferred at zero and accepted when one run appears.
- **More than one parent:** not a rejection. A merge commit can be the real current branch head. The compare API's merge base preserves the branch contribution while a first-parent commit diff can show the trunk sync instead.
- **Head or base movement during derivation:** discard the whole brief and retry. No range derived from the first read is emitted.
- **CLI, API, empty-output, or malformed-count failure:** indeterminate, never zero. Exit 2 is distinct from the transient exit 1.

The command re-reads the mutable head and base before emitting. It cannot freeze either after it exits, so the brief must not be cached, and the reviewer still re-reads the API head before returning a verdict.

## Enforcement boundary

The executable guard makes an unsafe brief unreturnable through `review:target`. This repository cannot intercept the app's session-dispatch API, so manually bypassing the command remains a process breach rather than a mechanically impossible action.
