# Querying GitHub Actions runs by commit

Do not pass a displayed or copied SHA directly to
`actions/runs?head_sha=...`. That endpoint treats `head_sha` as an exact-match
filter and returns `total_count: 0` with exit code 0 for all of these:

- a valid short prefix of a commit that has runs;
- a nonexistent 40-character hexadecimal value;
- a malformed string.

Those inputs are indistinguishable from a commit that genuinely has no runs.
Historical zeroes are not evidence unless the caller also established that the
queried value resolved to that repository's full commit SHA.

Use the repository command instead:

```powershell
npm run actions:runs-for-sha -- --sha 6f27bba
```

Pass `--repo owner/name` when querying a repository other than the current one.
The command first dereferences the input through `commits/<sha>`, validates that
GitHub returned a full 40-character SHA, and only then calls
`actions/runs?head_sha=<full-sha>`.

Successful output names the resolved SHA and the count:

```text
resolved_sha=6f27bbade3930f032d70370458023dbef89c7be6
total_count=0
```

`total_count=0` with exit code 0 is a true zero from a resolved commit. Invalid,
ambiguous, nonexistent, or otherwise unusable input exits 2 and never reaches
the Actions query.
