# Runbook — stuck orchestration

A generation orchestration was accepted by the server and stopped advancing.

> **Not rehearsed live.** The server-side steps below are performed against a
> running PrintFarmer server. They have been written and reviewed against the
> desktop contract and the emitted records; live rehearsal belongs to #138.

## Trigger

- The user reports generation "spinning" for far longer than a normal run.
- Repeated `orchestration.polled` records for one `correlationId` show the same
  `currentStep` over a long interval.
- `retryCount` climbing with no change in `currentStep`.

## Diagnose

1. Find the flow. `generation.submitted` carries both the `correlationId` and the
   `orchestrationId`; every later poll of that orchestration resolves the same
   `correlationId`.
2. Read the most recent `orchestration.polled` record and the orchestration
   payload it reported:
   - `currentStep` — the free-form step name from the saga. Compare across polls.
   - `stepStartedAtUtc` — how long the current step has been running. This, not
     `updatedAtUtc`, is the age that matters.
   - `retryCount` and `nextRetryAtUtc` — a scheduled retry means the server knows
     it is stuck and intends to move; wait for `nextRetryAtUtc` before acting.
   - `lastErrorCode` — the server's own typed reason for the last failure.
   - `workerId` — null means nothing has claimed it.
3. Check whether the poll itself is failing rather than the orchestration:
   an `orchestration.polled` record with `outcome` failed carries `errorCode` and
   `httpStatus`, and in that case the orchestration may be fine while the desktop
   cannot see it.
4. **Check `correlationOrigin` on the polls.** A value of `resumed` on an
   `orchestration.polled` record means this stage could not resolve the flow and
   minted a new `correlationId` — after an app restart, on a job this desktop
   never generated, or after the correlation registry evicted the flow's bindings
   under its 512-binding bound. Records before and after that point belong to the
   same flow but no longer share an ID. Bridge them on `orchestrationId`.

## Recover

1. If `nextRetryAtUtc` is in the future, **wait**. Intervening turns a recoverable
   retry into a duplicate.
2. If `retryCount` has stopped climbing and `stepStartedAtUtc` is old, the saga is
   not going to move on its own. Escalate to the server team to inspect or
   cancel the orchestration; PFD cannot cancel a server-side saga.
3. If the orchestration is abandoned server-side, the user starts a new
   generation. This mints a **new** `operationId`, so it is not an idempotent
   replay of the stuck one and will not be collapsed into it.
4. If polling was the failure rather than the orchestration, resolve connectivity
   and re-poll; the orchestration state is server-held and nothing was lost.

## Verify

1. Poll again and confirm `currentStep` has changed, or that the orchestration
   reached a terminal state with a non-null `completedAtUtc`.
2. Confirm the `orchestration.polled` records now carry `correlationOrigin`
   `continued` rather than `resumed`, which shows the flow is correlating again.
3. If generation completed, confirm the orchestration reports a non-null
   `gcodeFileId` — that is the promoted G-code the print will use.

## If this fails

Escalate with the `orchestrationId`, the `operationId` from the most recent
successful poll (the server echoes the one that started the orchestration), the
`correlationId`, `currentStep`, `retryCount`, `stepStartedAtUtc` and
`lastErrorCode`. Include `statusRoute` from the orchestration payload so the
server team can address the same resource. Do not expect a server error message
in the desktop records; `message` is catalogued text only.
