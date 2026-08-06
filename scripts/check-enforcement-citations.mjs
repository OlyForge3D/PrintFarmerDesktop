// A workflow comment that says a script enforces something must name the
// mechanism that runs it.
//
// The defect (#472). Five headers cite `scripts/check-merge-queue-contexts.mjs`
// as the thing enforcing required-context agreement. Three use the word
// *enforces*. No workflow runs it:
//
//   npm run check:merge-queue-contexts  in .github/workflows/  ->  0
//   CONTROL  npm run <anything>          in .github/workflows/  ->  30
//
// The control matches thirty times in the same corpus through the same
// instrument, so the invocation is absent rather than missed.
//
// Why the citations survived review is the interesting part, and it is why this
// check is not simply "cited implies invoked": the script has two halves and
// ONE OF THEM IS GENUINELY ENFORCED. Its pure classification exports are
// imported by tests/mergeQueueReadiness.test.ts and tests/liftSequencingHold.ts,
// which run under `npm run test` inside the required `Desktop` context. What
// never executes is the half that reads live branch protection over the
// network. So `lift-sequencing-hold.yml`'s "enforces the classification" is
// TRUE, and `pr-closure-scope.yml`'s "checks it against live branch protection"
// is false in CI and true only if a human types the command. A reader cannot
// tell which half a given header means, and every check a sceptical reader
// would run passes: the file exists, it is 505 lines, and it does exactly what
// the comment says WHEN INVOKED. The only failing check is the one nobody
// thinks to run.
//
// So the rule is: a citation must name the mechanism, and the mechanism must
// exist. Three ways to clear it —
//
//   run:      some workflow actually runs the script
//   tests:    the sentence names `npm run test` or a tests/ file, AND some test
//             really imports the script
//   by hand:  the sentence says so
//
// This is #313's remedy in its checkable form: cite the call site, not the
// claim. A line number is a perishable coordinate; a call site is a property of
// the tree.
//
// What this refuses to do: judge whether an enforcement is adequate. It cannot
// tell that the imported half omits the network comparison — only that the
// sentence names something that runs. Making the citations honest is cheaper
// than making them true, and is often the correct outcome; this check enforces
// honesty and takes no position on which remedy a given header should choose.
//
// No shebang: imported by tests/enforcementCitations.test.ts.

import { runCommandLines } from './check-script-reachability.mjs';

/** Verbs that assert something is being enforced rather than merely existing. */
export const ENFORCEMENT_VERBS =
  /\b(enforc\w*|checks?|checking|verif\w+|ensur\w+|guards?|gates?)\b/i;

/** An explicit statement that a human runs it. Always clears the citation. */
export const HAND_RUN_DISCLAIMER =
  /\b(run by hand|by hand|manually|not run in CI|nothing runs it|advisory only)\b/i;

/** A claim that the test suite carries it. Must be backed by a real import. */
export const TEST_MECHANISM = /`?npm run test`?|\btests\/[A-Za-z0-9._-]+/i;

const SCRIPT_REFERENCE = /scripts\/([A-Za-z0-9._-]+\.mjs)/g;

/**
 * Comment paragraphs, with the `#` markers stripped.
 *
 * Contiguous comment lines are joined before sentences are split, because the
 * claims wrap: "enforces that against live / branch protection rather than
 * leaving it to this comment" is one sentence across two lines, and a
 * line-anchored reader would see a verb with no object and an object with no
 * verb.
 */
export function commentParagraphs(contents) {
  const paragraphs = [];
  let current = [];
  for (const line of contents.split(/\r?\n/)) {
    const comment = /^\s*#\s?(.*)$/.exec(line);
    if (comment) {
      current.push(comment[1].trim());
      continue;
    }
    if (current.length > 0) {
      paragraphs.push(current.join(' ').replace(/\s+/g, ' ').trim());
      current = [];
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(' ').replace(/\s+/g, ' ').trim());
  }
  return paragraphs.filter(Boolean);
}

/** Sentences of a paragraph that name a script under scripts/. */
export function citationSentences(contents) {
  const found = [];
  for (const paragraph of commentParagraphs(contents)) {
    for (const sentence of paragraph.split(/(?<=\.)\s+/)) {
      const scripts = [
        ...new Set(
          [...sentence.matchAll(SCRIPT_REFERENCE)].map((match) => match[1]),
        ),
      ];
      if (scripts.length > 0)
        found.push({ sentence: sentence.trim(), scripts });
    }
  }
  return found;
}

/**
 * Paragraphs that name a script, with the script references stripped out of the
 * text used to detect a claim.
 *
 * Paragraph rather than sentence granularity, and that is a repair rather than
 * a preference. At sentence granularity this module had a surviving mutant:
 * rewriting a header to
 *
 *     scripts/x.mjs holds that classification. It is enforced.
 *
 * dropped the citation entirely, because the sentence naming the script carried
 * no verb and the sentence carrying the verb named no script. The check went
 * green on a header that asserts an enforcement and names nothing — the exact
 * false clean it exists to find. Splitting a claim across a full stop must not
 * be a way out.
 */
export function citationParagraphs(contents) {
  const stripper = new RegExp(SCRIPT_REFERENCE.source, 'g');
  return commentParagraphs(contents)
    .map((paragraph) => ({
      paragraph,
      claim: paragraph.replace(stripper, ' '),
      scripts: [
        ...new Set(
          [...paragraph.matchAll(SCRIPT_REFERENCE)].map((match) => match[1]),
        ),
      ],
    }))
    .filter(({ scripts }) => scripts.length > 0);
}

/** Script basenames any workflow actually runs. */
export function runInvokedScripts(workflows, npmScripts = {}) {
  const invoked = new Set();
  for (const { contents } of workflows) {
    for (const line of runCommandLines(contents)) {
      for (const match of line.matchAll(SCRIPT_REFERENCE))
        invoked.add(match[1]);
      for (const match of line.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
        const command = npmScripts[match[1]];
        if (typeof command !== 'string') continue;
        const resolved = new RegExp(SCRIPT_REFERENCE.source).exec(command);
        if (resolved) invoked.add(resolved[1]);
      }
    }
  }
  return invoked;
}

/** Script basenames some test file imports. */
export function testImportedScripts(testFiles) {
  const imported = new Set();
  for (const { contents } of testFiles) {
    for (const match of contents.matchAll(SCRIPT_REFERENCE)) {
      imported.add(match[1]);
    }
  }
  return imported;
}

/**
 * Which enforcement citations name no mechanism that runs.
 *
 * `citations` is returned so a caller can assert the scan saw any at all — a
 * zero over an empty corpus is the vacuous pass this class keeps producing.
 */
export function evaluateEnforcementCitations({
  documents,
  workflows,
  testFiles,
  npmScripts,
}) {
  const invoked = runInvokedScripts(workflows, npmScripts);
  const imported = testImportedScripts(testFiles);

  const findings = [];
  const honest = [];
  let citations = 0;

  for (const { path: documentPath, contents } of documents) {
    for (const { paragraph, claim, scripts } of citationParagraphs(contents)) {
      if (!ENFORCEMENT_VERBS.test(claim)) continue;
      citations += 1;

      for (const script of scripts) {
        const entry = { document: documentPath, script, sentence: paragraph };

        if (HAND_RUN_DISCLAIMER.test(paragraph)) {
          honest.push({ ...entry, mechanism: 'by hand' });
          continue;
        }
        if (invoked.has(script)) {
          honest.push({ ...entry, mechanism: 'run:' });
          continue;
        }
        if (TEST_MECHANISM.test(paragraph) && imported.has(script)) {
          honest.push({ ...entry, mechanism: 'tests' });
          continue;
        }

        findings.push({
          ...entry,
          available: [
            invoked.has(script) ? 'a workflow run:' : null,
            imported.has(script) ? 'a test import' : null,
          ].filter(Boolean),
        });
      }
    }
  }

  return { findings, honest, citations };
}

export function formatFindings(findings) {
  return findings.map(({ document, script, available }) => {
    const options =
      available.length > 0
        ? `It is reachable by ${available.join(' and ')} — name that mechanism in the sentence.`
        : 'Nothing runs it at all — say "run by hand", or wire it into a workflow.';
    return (
      `${document} asserts that ${script} enforces something, but the sentence ` +
      `names no mechanism that runs. ${options}`
    );
  });
}
