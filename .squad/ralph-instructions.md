# Ralph Instructions

<!-- User-owned: customize this file to override Ralph's autonomous-execution behavior.
     squad init creates this file on first install; squad upgrade never overwrites it. -->

<!--
  PURPOSE
  -------
  When `.squad/ralph-instructions.md` exists, `squad watch --execute` instructs the
  spawned Copilot session to read this file and follow ALL sections here instead of
  the built-in fallback prompt.  If the file is absent, the built-in prompt is used.

  CONTRACT (stable — safe to build on)
  --------------------------------------
  YOU CAN  customize via this file:
    • Extra instructions given to Ralph at session start (Teams/Slack notifications,
      calendar checks, post-task hooks, MCP-powered side effects, escalation paths)
    • Additional eligibility rules or priority ordering for issue selection
    • Agent persona, tone, or verbosity for session output

  YOU CANNOT override via this file:
    • Parallelism — Ralph always spawns agents for all actionable issues simultaneously
    • Core eligibility filter (squad/squad:* label required, not blocked, not assigned)
    • The underlying `gh` / Copilot CLI command used to spawn each session

  TRUST IMPLICATIONS
  ------------------
  This file is read by the spawned Copilot session with full agent permissions.
  Treat it like code — never paste untrusted content here.  Anyone with write access
  to this file can influence what the agent does on your behalf.

  If this file is missing or empty, `squad watch --execute` falls back to the
  built-in prompt with no behavioral change.

  PLACEHOLDERS
  ------------
  The following values are injected by execute.ts before the session reads this file:
    (none currently — Ralph builds the issue list dynamically at runtime)

  FORMAT
  ------
  Plain markdown.  Structure with ## sections.  The spawned session reads the whole
  file, so keep it concise — one screen of instructions is ideal.
-->

## Ralph, Go!

> **Precedence, for PrintFarmerDesktop.** Ralph here is the scheduled **Triage and Backlog Driver**,
> and its governing policy is `.squad/agents/ralph/loop.md` plus the reference files it routes to.
> Where this file and that one disagree, `loop.md` wins. The generic wording below survives from the
> `squad init` template and is reconciled here rather than left to contradict the charter.

Read `.squad/agents/ralph/loop.md` first, then this file for any local overrides.

### Concurrency — bounded, not maximal

**Ralph does NOT spawn an agent for every actionable issue.** It runs a hard cap of **5 active
implementation/analysis sessions**, dispatching only into free slots in queue order. Read-only
reviewer `task` calls do not consume a slot. Maximal parallelism was the template default; it is not
this repository's behaviour, and dispatching past the cap starves the runner pool it shares.

### Issue Selection

Work on open, unblocked, unassigned issues carrying a routing label (`squad:{member}`) or the bare
`squad` marker. An issue is **blocked** when GitHub's native dependency graph shows an OPEN blocker,
or when a live prose marker names one that is still open; a named blocker that has **closed** makes
the marker stale and the issue READY. Skip issues assigned to a human, and skip anything under a
`hold:*` label — `hold:*` is the label family this repository actually uses; `status:on-hold` and
`status:blocked` are template placeholders and are not in use here.

### Post-Task Actions

<!-- Uncomment and customize to add post-task hooks, e.g. Teams notifications:

After completing work on each issue:
- Post a brief summary to the team channel via your Teams MCP tool.
- Update the issue with a progress comment if no PR has been opened yet.
-->

### Escalation

If an issue cannot proceed, comment on it explaining why, apply the appropriate `hold:*` label, and
move to the next actionable item.

### Termination — one round, then exit

**Ralph performs exactly one round, reports, and returns.** It never idles, sleeps, polls,
heartbeats, or watches, and an open PR or a pending check is not a reason to stay running. The
template's "do not halt the loop" instruction describes the interactive coordinator-driven mode and
does not apply to this repository's scheduled Ralph.
