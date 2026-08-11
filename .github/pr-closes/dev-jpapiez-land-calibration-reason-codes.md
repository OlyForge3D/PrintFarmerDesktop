# Closing-reference declaration

This PR lands the calibration reason-code contract fix: `rejectionReasonCodes`
is validated against the catalogue PrintFarmer can actually emit rather than
accepting any short string, and a server response that declares a printer
eligible while supplying reasons it is not is surfaced as an explicit
contradiction instead of being flattened into an ordinary refusal.

It is a follow-up to #715, which merged before these review fixes landed. No
tracked issue exists for it, so the empty block below is a deliberate
declaration that this PR closes nothing, per `.github/pr-closes/README.md`.

```closes

```
