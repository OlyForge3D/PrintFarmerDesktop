# An instrument that logs its initialisation in the vocabulary of its observations

A monitor that reports change works by comparing what it just read against what
it held before. On its first pass it holds nothing, so every subject it watches
differs from an empty memory and is written to the log with the same word used
for genuine movement. Every line is true. The instrument saw those values for the
first time, and recording them is correct. The defect is not in what was measured
or in how the measurement was consumed; it is that the record cannot afterwards
be read by anyone who does not already know which entries were the startup.

This sits downstream of the two failures that are easier to find. A coverage
failure means the instrument did not look. An adapter failure means it looked and
the result was mangled on the way to the reader. Here the looking is right and the
handling is right, and the artifact still defeats its only audience. A log is
written for the reader who was not present, and an entry that requires knowledge
of when the process started in order to be classified has quietly made presence a
precondition for reading it.

The cost is concentrated in one place and it runs in the expensive direction.
Initialisation entries frequently carry the instrument's own clean signals
alongside them — the sources agreed, no discrepancy observed — so they do not
read as noise to be filtered. They read as negative results. A log of ten
observations, three of which are the process meeting its subjects for the first
time, reports ten opportunities for a discrepancy where only seven existed. The
denominator inflates, the rate falls, and the conclusion drifts toward "the
problem is rarer than claimed" on the strength of observations that were never
observations. Noise invites scrutiny; a null result does not. Nobody re-examines
a finding that says nothing was wrong.

There is a second cost that only appears when someone tries to use the log. Any
count drawn from it must exclude the initialisation entries, and if the log does
not mark them, that exclusion is performed by hand — typically by noticing that
several subjects all changed within the same millisecond and inferring that no
real event does that. The resulting number can be entirely correct. It is still
unusable, because the method that produced it does not generalise and cannot be
stated in a way another person can repeat. A correct figure obtained by a
non-reproducible method is worse than an admitted gap, since it carries the
authority of a measurement and none of the properties of one. The author is
included in the set of people who cannot reproduce it, an hour later.

The underlying shape is familiar. The comparison has three outcomes, not two:
the value changed, the value did not change, and there was no previous value to
compare against. A differ that emits only the first two must route the third into
one of them, and it routes it into "changed", because an absent prior value is
unequal to everything. The third state is the one that carries the information
about the instrument's own history rather than about the subject, and it is lost
precisely because the interface was designed around the subject.

The remedy costs one word at write time and is unavailable at every later moment.
A distinct verb for first sight — recorded as a baseline rather than as a
movement — makes the classification a property of the record instead of a
property of the reader. No amount of post-hoc analysis recovers it, because the
information that distinguishes the two cases was never written down; it existed
only in the process's memory of whether it had run before. This is the general
form: state that is known at write time and expensive to reconstruct afterwards
must be written down at the point where it is free, and the fact that the author
can reconstruct it today is not evidence that it is recoverable.

Recorded from the reviewer's own instrument, not from anyone's code. A poller
comparing two sources of a branch tip logged its first sight of each subject with
the same verb it used for real pushes, and three such entries carried the
instrument's agreement signal, so they presented as clean negative observations.
The error was found while counting, by a reader who noticed that three subjects
had moved at an identical millisecond. The count that had already been reported
from that log happened to be right, and the direction of the correction is worth
keeping: excluding the initialisation entries made the reported rate smaller,
which is the direction a denominator moves when it is corrected honestly, and the
direction least likely to prompt anyone to check it.
