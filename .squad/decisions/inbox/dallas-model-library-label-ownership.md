# 2026-07-24: Model library label ownership

**By:** Dallas

**What:** Kept `aria-label="Model library"` on the top-level `<main>` library region and renamed the nested `ModelGrid` list to `aria-label="Model grid"`.

**Why:** Playwright's packaged smoke test exposed a real accessibility collision: both the landmark region and the nested list shared the same accessible name. The region owns the broader workspace label; the inner list still benefits from its own distinct name without shadowing the landmark.
