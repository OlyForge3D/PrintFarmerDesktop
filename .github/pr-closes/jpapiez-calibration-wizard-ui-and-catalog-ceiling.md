```closes

```

This pull request closes no issue.

Its two issue-adjacent changes are deliberately partial, so neither is claimed:

- The profile-catalog response ceiling is an interim client-side workaround.
  The actual fix is a lightweight server-side projection, requested as
  OlyForge3D/PrintFarmer#2049; this branch only stops the desktop being
  blocked while that lands.
- The calibration method ordering fix corrects the sequence but leaves the
  hard-coded 3-method count in place, which is what
  OlyForge3D/PrintFarmerDesktop#771 tracks — including the `.max(3)` ceiling
  on `completedMethods` that fails at save time rather than at selection.
