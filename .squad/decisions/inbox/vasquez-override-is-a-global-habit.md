# An override is a local exemption bought with a global habit

Every guard we add comes with a way past it, because a guard with no override
stops being a guard and becomes an outage. The override is not the problem. The
problem is that we account for it in the wrong units: we ask whether _this_
refusal was correct, one refusal at a time, while what the override actually
costs is spent somewhere else entirely. **The check a refusal buys is local to
one push. The habit its remedy teaches is global to every push that follows,
including the ones aimed at a different control.**

This is the reason "fails toward more refusals, therefore safe" is not sound,
and that sentence was load-bearing in this repository's push guard for four
rounds before it was measured. **More refusals is only conservative when the
extra refusals are correct.** A false alarm does not add caution; it spends
credibility, and it spends it from a pool the next control has to draw on.

## Four instances from one control

The push guard produced all of these, and the sequence matters more than any
one of them.

The reachability proxy asked _"do I still hold some commit of session X"_ when
the question was _"did session X's work originate here"_. Measured, with whether
any of their work is carried forward as the only variable:

```
rewind over all of their work  -> foreign-session, names them
keep ONE of their commits      -> unacknowledged-discard, silent
```

Keeping one of their commits put their id into the reachable set and silenced
the foreign claim for every other commit the push destroyed — including one
titled _"never read by me"_. **That state is reached by following the guard's
own printed advice**, which says to rebase onto their work rather than over it;
rebasing onto _part_ of it is the ordinary outcome when some is obsolete. A
control whose documented remedy disables it is not a control.

The same proxy failed in the opposite direction on a solo total rollback, where
nothing of the pusher's survives to be reachable: **one writer, told to
acknowledge themselves as a second writer, and handed an override naming their
own session id.** One quantity, two opposite failures, so no threshold fixes it.

The remedy script then punished a _correct_ rebase — the exact action the
guard's refusal asks the operator to produce — and the only way out it offered
was `--yes`. The operator is told to run that script _by_ the guard, under time
pressure. **A remedy that refuses the correct action and then teaches that the
override is how you proceed is worse than no remedy**, because it converts the
override from an exceptional act into the normal one.

And the session trailer the guard reads to identify a foreign writer is not
unique per session: one value carries 74 commits spanning 37 hours, which no
single session does. Measured against the decision function with the other
writer's trailer as the only variable:

```
distinct trailer, no ack    -> REFUSE  push-guard.foreign-session
distinct trailer, ACK=live  -> REFUSE  push-guard.foreign-session
SHARED trailer,  no ack     -> REFUSE  push-guard.unacknowledged-discard
SHARED trailer,  ACK=live   -> ALLOW   push-guard.acknowledged-discard
```

## The discriminator this yields, which is not "how often does it fire"

Row two is the one worth keeping. With distinct ids the strong refusal **cannot
be cleared by the ordinary remedy at all** — acknowledging the live tip is not
enough; you must name the specific session id whose work you are destroying,
which you cannot do without having looked at it. With a shared id that property
is gone and `--yes` suffices.

So the useful question about a refusal is not how noisy it is. It is:

> **What does clearing this require the operator to have done?**

An override that requires transcribing a value you had to read is a control. An
override that requires a flag is a speed bump, and one you are already in the
habit of passing. The two look identical in the code — both are a conditional
and an environment variable — and they differ only in whether the value is
derivable without reading anything.

This is the same distinction as _a commitment is not a control_, moved from
prose into the exit path: **the override is where a control quietly reverts to a
commitment**, because from that line onward the only thing standing between the
operator and the destructive act is their intention to have read.

## What this must not be read as saying

It is not an argument for fewer refusals, and it is not an argument for removing
overrides. A guard with no way past it gets disabled wholesale — usually by
`--no-verify`, which is the global habit in its purest form, since it exempts
every hook at once and is learned from whichever one was most annoying.

It is also not an argument that a bypassed control is worthless. The record of
who overrode what is real evidence, and the printed list of what a push destroys
is read even when the operator proceeds. **The claim is narrower: the value of a
refusal should be scored net of the habit its remedy trains, and we have been
scoring only the gross.**

Nor does it license assuming the habit exists. It should be measured — the
author of this note ran the guard's own `--yes` path on the very branch that
shipped the guard, which is one data point and is offered as such.

## The general shape

A control's strength is usually estimated from its _trigger_ — what it catches,
how often, in which states. That is the visible half and it is the half tests
exercise. **But a control is only as strong as the cheapest thing that clears
it, and the cost of clearing it is paid in a currency that does not appear in
that control's own accounting.** Whenever a remedy can be satisfied without
acquiring the knowledge the refusal exists to force, the guard has been reduced
to a notification, and it will keep passing its own tests in that state.
