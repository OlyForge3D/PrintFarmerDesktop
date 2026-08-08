// Positive-control fixture for tests/checkTestNarrowing.test.ts: the SAME
// narrowing as narrowed.vitest.config.ts, but written with a computed key
// (`['testName' + 'Pattern']`) rather than a literal one. #518's history
// (see the note above `DESCRIBE_TITLE` in
// tests/retargetSweepRealContention.test.ts) records two reviewers defeating
// a source-text-matching gate with exactly this spelling. This gate resolves
// the module instead of pattern-matching its source, so this fixture must be
// caught identically to the literal form -- that equivalence is the
// assertion this fixture exists to make.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    ['testName' + 'Pattern']: 'only this one arm',
  },
});
