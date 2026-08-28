```closes

```

This PR closes no issue. It repairs the server-contract snapshot provenance
guard (which was validating the working tree instead of the pinned commit) and
re-pins the snapshots to PrintFarmer `678d339`.
