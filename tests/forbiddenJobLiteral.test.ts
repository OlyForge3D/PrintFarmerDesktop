import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * #152's acceptance criterion was `git grep -i "<name>"` returns zero. Until
 * #265 that criterion was enforced by a manual grep at review time, which is
 * indistinguishable from no criterion at all once the reviewer moves on -- and
 * it had already regressed once, in #246, and been fixed once, in #258, without
 * anything being added to stop the third occurrence.
 *
 * What the name is matters, because it decides what this guard is for. It is
 * not a fabrication. `7f31829` establishes that the job was real in `ci.yml`
 * from `97518ce` until `d20aa73` renamed it -- to `Release package`, which
 * supplies two of the seven required contexts today. The citations that named
 * it were accurate the day they were written; the rename landed in an unrelated
 * 24-file commit and orphaned them.
 *
 * #152 recorded the cause as fabrication, and that framing propagated into the
 * durable artefacts before being corrected. It is worth resisting here for a
 * concrete reason: fabrication implies "check your facts", which is advice to a
 * careless author, and there is no careless author in this story. A rename
 * implies a join between an emitting artefact and everything that cites it,
 * which is a mechanism -- and it is also why the string keeps coming back.
 * People write it because it was once true, which no amount of care prevents.
 *
 * So this scanner is not guarding against invention. It is the missing half of
 * that join, standing in for the one nobody has built: a citation does not have
 * to be wrong when written to be wrong now.
 *
 * The regression is not carelessness, which is why vigilance is the wrong
 * instrument. The string is most likely to be written by someone documenting
 * why it must not appear: #246 introduced it inside a comment explaining the
 * guard it was adding. In context the occurrence always looks justified, so
 * code review is systematically the worst place to catch it.
 *
 * That applies to this file first. The name is never spelled here -- it is
 * assembled at runtime -- because a scanner that reads the whole repository
 * reads its own source too, and the two available escapes are both worse than
 * the disease: exempting this file removes the guard from the file most likely
 * to contain the string, and weakening the match to avoid a self-hit narrows
 * what the criterion means. Assembling it costs one line and keeps the scan
 * total.
 *
 * What assembling costs is discoverability, and it is named here rather than
 * left for the next reader to hit. Grepping the forbidden name returns zero
 * whether this guard exists or not, so that query cannot tell an enforced
 * criterion from an unenforced one -- and a reader who runs it may reasonably
 * conclude the tree is unguarded. The queries that do separate those two cases
 * are `git grep -il 152 tests/`, which returns this file, and this file's own
 * name. Spelling the name here would make the literal query work, at the price
 * of making #152's criterion -- zero hits, tree-wide -- false by construction,
 * which is the criterion a reviewer actually runs. So the guard is made
 * findable by the question it answers rather than by the string it forbids.
 */
const forbiddenJobName = ['Package', 'smoke'].join(' ');

/**
 * The control strings are assembled for the same reason, and this file is the
 * evidence that the reason is real rather than tidy. Both controls were spelled
 * literally in the first draft, and it passed -- because it was still untracked,
 * so `git ls-files` did not show it to itself. The first run after committing
 * went red: the scanner found the known-absent control in its own source and
 * correctly reported it as present.
 *
 * The repair then failed the same way a second time, and the second failure is
 * the one worth recording: the comment you are reading explained the problem by
 * quoting the string, which put it straight back into the file. That is #246's
 * mechanism exactly -- the literal introduced by someone documenting why it must
 * not appear -- reproduced here by the author of the guard against it, inside
 * the guard, minutes after writing that review is the wrong instrument for it.
 *
 * A self-reading scanner is a member of the population it measures, and it joins
 * that population at `git add`, not at the moment it is written. So the green in
 * between was a property of the file's tracking state, not of the repository.
 */
const presentControl = ['Release', 'package'].join(' ');
const absentControl = ['zzQQ', 'not', 'present', 'anywhere'].join('-');

// Read once. Every file is read as latin1 rather than utf8 so that no byte can
// be replaced by U+FFFD on the way in: a lossy decode is a scanner that reports
// "absent" about bytes it could not represent, and the needle is pure ASCII, so
// latin1 is both lossless and sufficient here.
const trackedContents = (): Map<string, string> => {
  const listing = execFileSync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries = new Map<string, string>();
  for (const relative of listing.split('\0')) {
    if (relative === '') continue;
    // Deliberately not wrapped in try/catch. A file git lists but cannot be
    // read is the instrument going blind on exactly one path, and a caught
    // error here would be reported as a clean absence for that file.
    entries.set(
      relative,
      readFileSync(path.join(repositoryRoot, relative), 'latin1'),
    );
  }
  return entries;
};

const filesContaining = (contents: Map<string, string>, needle: string) => {
  const lowered = needle.toLowerCase();
  return [...contents]
    .filter(([, body]) => body.toLowerCase().includes(lowered))
    .map(([relative]) => relative)
    .sort();
};

describe("#152's forbidden job name stays out of the tree", () => {
  const contents = trackedContents();

  // Three controls, because the assertion below passes identically against a
  // scanner that read nothing, a scanner that can never match, and a scanner
  // that matches everything. None of those is visible from the result.
  it('reads a repository, and matches present and absent strings correctly', () => {
    expect(contents.size).toBeGreaterThan(100);
    // Known present: shares a word with the forbidden name, so a match here
    // also shows the scan is not stopping at the first token. Assembled, so
    // this file cannot satisfy its own positive control.
    expect(filesContaining(contents, presentControl).length).toBeGreaterThan(0);
    // Known absent: a scanner returning every file would satisfy the positive
    // control above and the real assertion would then be unfalsifiable.
    expect(filesContaining(contents, absentControl)).toEqual([]);
  });

  // The needle itself needs pinning. Assembling it at runtime buys the total
  // scan, but it also means a typo produces a string that is absent for the
  // wrong reason, and the assertion below would pass. An empty needle fails
  // safe -- it matches every file -- but a misspelled one does not.
  it('looks for the name #152 forbids, not merely for some absent string', () => {
    expect(forbiddenJobName).toHaveLength(13);
    expect(forbiddenJobName.split(' ')).toEqual(['Package', 'smoke']);
  });

  it('appears in no tracked file, this one included', () => {
    expect(filesContaining(contents, forbiddenJobName)).toEqual([]);
  });
});
