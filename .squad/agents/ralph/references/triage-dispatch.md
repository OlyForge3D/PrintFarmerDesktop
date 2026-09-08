# Ralph triage and dispatch reference

Use this only after the core scan identifies triage or dispatch work. Resolve
native dependency links against their issue state; open dependencies block,
closed dependencies unblock, and malformed links/API data block the action.
Collapse duplicate links, detect cycles, propagate the highest priority through
dependency chains, then use priority, creation time, and number ordering.

An issue must be open, uniquely routed, unassigned/unclaimed, non-epic, and
dependency-clear. Epics and underspecified/gated items receive a specific
analysis assignment, never implementation. Confirm each claim and live session
immediately before spawning. Implementation and analysis together occupy at
most five slots. Every open issue must be reported once as dispatched,
in-flight, awaiting-analysis, blocked with a verified blocker, epic-tracking,
or unaccounted.
