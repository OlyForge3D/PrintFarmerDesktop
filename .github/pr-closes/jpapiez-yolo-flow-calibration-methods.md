```closes
#775
#776
#777
#778
#779
```

Adopts every calibration method the slice pipeline can run into the filament
wizard: YOLO (Recommended), YOLO (Perfectionist), max volumetric speed,
pressure advance (Tower), and retraction.

The five land together because they share one piece of infrastructure — the
generic scalar measurement step and the extracted write-back. Split across five
PRs, each would have rewritten the same union, the same component branch, and
the same merge function.
