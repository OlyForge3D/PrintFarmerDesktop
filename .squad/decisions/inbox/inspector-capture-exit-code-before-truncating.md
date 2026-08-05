# `Select-Object -First` severs a native command before its exit code is recorded

**By:** Inspector — from review of PR #149, measured jointly with Ripley.

This is a PowerShell fact that silently corrupts any check of the form *"run a
command, look at the first few lines, decide whether it passed."* Several
measurements in this repository were published from harnesses carrying it. It is
cheap to avoid and impossible to notice, because the failure produces a
plausible number rather than an error.

## The finding

`Select-Object -First N` stops the upstream pipeline as soon as it has N items.
When the upstream is a native command that is still streaming, the pipeline is
severed **before the process exit status is recorded**, and `$LASTEXITCODE` is
never written for that command.

Measured, five arms, `cmd /c "for /L %i in (1,1,10) do @echo l%i & exit /b 3"`:

```
direct pipe          cmd | Select -First 1        -> $LASTEXITCODE 0    WRONG
function wrapper     Emit | Select -First 1       -> $LASTEXITCODE 0    WRONG
parenthesised       (cmd) | Select -First 1       -> $LASTEXITCODE 3    correct
assigned first      $o = cmd ; $o | Select …      -> $LASTEXITCODE 3    correct
CONTROL no truncate  cmd | Out-Null               -> $LASTEXITCODE 3    correct
```

The separating variable is **streaming versus collected**, not `N`, not the
number of lines emitted, and not the enclosing scope. Parenthesising or
assigning forces the command to run to completion first, so the status exists
before anything truncates.

## The value that leaks is not zero

`$LASTEXITCODE` is not set to `0` by the severed pipeline. It **retains whatever
it already held**, which is the exit code of the previous command:

```
primed 7, truncated command exits 0   ->  7    reports FAILURE for a success
primed 0, truncated command exits 5   ->  0    reports SUCCESS for a failure
primed 9, truncated command exits 5   ->  9    reports a code from an unrelated command
```

This matters more than the defect itself. Every description of this bug written
before the third arm was run called it *"converts a failure into a success, in
the reassuring direction."* That is only true in a fresh shell, where the prior
value happens to be `0`.

**The leak is not biased toward success. It is biased toward whatever you ran
most recently, which is exactly why the wrong value looks plausible** — it is
usually a code you have seen in the last minute.

The asymmetry that follows is the reason this is worth a file: alarming
instances get investigated and reassuring ones do not, so **the population of
these failures that survives review is precisely the false-clean one.**

## The rule

**Capture the exit code before you truncate.**

```powershell
$output = cmd /c "…"          # runs to completion
$code   = $LASTEXITCODE       # capture immediately, before anything else
$head   = $output | Select-Object -First 5
```

Stated as a prohibition on truncation the rule gets violated by the first person
who legitimately needs the first five lines of something. Stated as an ordering
constraint it survives, because it forbids nothing anyone wants to do.

Any interposed command — including `Write-Host`, a comparison, or another native
call — overwrites `$LASTEXITCODE`. "Immediately" is literal.

## Why this is filed as a document rather than left as an issue comment

Not because comments are fragile. They are not: a squash-merge rewrites git
history and cannot touch GitHub comment objects. #162 was squash-merged and its
35 issue comments and 17 reviews are all still retrievable; what that squash
destroyed was the **commit** `d64704d7`, and therefore every citation that named
it by SHA.

The reason is narrower and worth stating correctly, because the wrong reason
would send someone re-filing durable comments for no benefit:

**A remedy that lives only in a comment is not on the path of anyone who is
about to make the mistake.** It is found by searching for a defect you do not
yet know you have. A file in this directory is read by people adopting the
squad's conventions, which is the moment the ordering constraint is cheap to
learn and free to apply.
