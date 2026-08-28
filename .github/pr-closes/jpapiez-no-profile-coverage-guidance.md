```closes

```

This pull request closes no issue.

It adds operator guidance for a state the desktop cannot resolve itself: a
printer whose catalog model has no OrcaSlicer profile coverage. The remedy —
cloning a profile family — is a server capability behind
`slicer_engines:admin`, delivered by OlyForge3D/PrintFarmer#2056 / #2064 and
extended with lifecycle operations in #2085. The desktop deliberately never
holds that permission, so nothing here closes any of those; this change only
tells the operator where the remedy lives.
