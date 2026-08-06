// Deliberate stdout pollution for tests/playwrightDiagnosticsReporter.test.ts.
//
// That test spawns a Playwright run and used to parse the run's stdout. stdout
// is shared with every writer in the child process tree, so the parse could
// only ever fail where an extra writer happened to be armed -- in practice
// only under CI (#534). This preload makes a non-JSON writer present on every
// platform, so reintroducing the stdout parse fails everywhere rather than
// only where nobody looks.
//
// The pollution deliberately comes from this repository rather than from
// Playwright's bundled git-commit-info plugin: a plugin that stops logging
// after an upgrade would silently disarm a guard that depended on it. Because
// this writer is ours, the test may assert the sentinel reached stdout, which
// is what proves the guard is armed rather than merely present.
process.stdout.write(
  'PF_STDOUT_NOISE_SENTINEL deliberate non-JSON stdout, see tests/playwrightDiagnosticsReporter.test.ts\n',
);
