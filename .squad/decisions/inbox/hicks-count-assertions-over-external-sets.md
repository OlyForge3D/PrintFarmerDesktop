# Count assertions over externally-evolving sets

A count assertion is not fragile because it is a count. It is fragile when it
counts a set derived from a file that legitimately evolves outside the test's
control. Where the set and the count move in the same diff, the count is the
boundary under test and must stay. Where the set is read from a real repository
file that unrelated work is expected to change, the count converts "someone
made a correct change elsewhere" into a red build, and the property the test
exists to enforce should be asserted directly instead.

A sweep of `tests/` found 133 count assertions across 33 files. Only three files
read real repository files rather than fixtures they define themselves:
`supplyChainPolicy.test.ts`, `supplyChain.test.ts`, and `licensing.test.ts`.
The remaining 130 counts are fixture-local and safe by this rule. The class is
narrow; applying the rule indiscriminately would remove working controls.

`supplyChainPolicy.test.ts` produced the one live instance.
`requireLockedWorkspaceCargoCommands` returned the workspace cargo invocations
found in the CI workflow and the test asserted `toHaveLength(8)`. Adding two
legitimate cargo steps made it 10 and turned both Desktop jobs red on a correct
change. The assertion that carries the safety is not the count: the helper
throws on any invocation missing `--locked` before it returns, and a control
immediately below strips the flag to prove that throw fires. The count added no
safety over either. It has been replaced with a non-emptiness assertion, which
keeps the one thing the count did carry — that the helper was not silently
handed an empty list.

The replacement first proposed for it was worse than the count, and the failure
is worth recording because it is easy to repeat. Asserting
`commands.every((c) => /--locked/.test(c))` over the helper's return value
cannot fail: the helper filters on the identical regex and throws before
returning, so every element is already known to match. It is a tautology
wearing a property check's clothes, and unlike the count it would never have
failed at all. A property assertion placed downstream of the code that enforces
the property asserts nothing. Check what the assertion could observe failing
before preferring it to the thing it replaces.

`supplyChain.test.ts` carries the pattern to copy. It asserts
`baseline.components.length + 1` rather than an absolute figure, so it states
the relationship the test is about — one component added — and is inert to the
baseline growing underneath it.

Counts that came from reading the source of truth stay. The `toHaveLength(90)`
and `toHaveLength(89)` pair in `supplyChainPolicy.test.ts` was verified by
reading the manifests: 8 npm workspaces plus 1 native workspace plus 81 locally
declared crates. That difference of one is the boundary under test, not an
incidental tally, and replacing it with a property would delete the control.
