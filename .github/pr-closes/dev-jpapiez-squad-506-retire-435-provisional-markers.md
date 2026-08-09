# Closing-reference declaration

This PR retires the `provisional`/`#435` markers in
`tests/calibrationMaliciousInputCorpus.test.ts` now that #435 is closed. It
closes #506 only. Per this issue's own constraint, it does **not** use a
closing keyword for #57 or #42 — those are release gates that close only
when all their children are done.

```closes
#506
```
