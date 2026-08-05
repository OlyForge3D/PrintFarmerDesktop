import { describe, expect, it } from 'vitest';

import {
  ADJUDICATED_LOSSES,
  EXIT_LANDED,
  EXIT_NOT_LANDED,
  EXIT_UNVERIFIABLE,
  VERDICT_ADJUDICATED,
  VERDICT_LANDED,
  VERDICT_NOT_LANDED,
  VERDICT_UNVERIFIABLE,
  classifyAdjudication,
  classifyAncestry,
  classifyFile,
  classifyMerge,
  evaluateSweep,
  formatSweep,
} from '../scripts/check-merge-landed.mjs';

const SHA = '1ececa0f35d6a577597dff5ba50651c8616e37fd';
const OTHER_SHA = 'beb86e4f35d6a577597dff5ba50651c8616e37fd';

const reached = { reached: true, reason: 'ok' };
const notReached = { reached: false, reason: 'no' };

function present(path: string) {
  return classifyFile({ path, status: 'modified', atHead: 0, atTarget: 0 });
}

function absent(path: string) {
  return classifyFile({ path, status: 'modified', atHead: 0, atTarget: 128 });
}

describe('reading git ancestry three-valued', () => {
  it('reads 0 as reached', () => {
    expect(classifyAncestry({ code: 0, subject: 'x' }).reached).toBe(true);
  });

  it('reads 1 as a real no', () => {
    expect(classifyAncestry({ code: 1, subject: 'x' }).reached).toBe(false);
  });

  // #315: `if (code !== 0)` collapses 128 into the same bucket as 1, and the
  // bucket it lands in is the one that reads as an answer.
  it('reads 128 as no answer at all, not as a no', () => {
    const reading = classifyAncestry({ code: 128, subject: 'x' });
    expect(reading.reached).toBeNull();
    expect(reading.reached).not.toBe(false);
  });

  it('reads 129 as no answer either, so an unknown flag cannot pass for a verdict', () => {
    expect(classifyAncestry({ code: 129, subject: 'x' }).reached).toBeNull();
  });
});

describe('a file absence must be earned', () => {
  it('reports a file that is on the target as present', () => {
    expect(present('a.ts').present).toBe(true);
  });

  it('reports a file missing from the target as absent', () => {
    expect(absent('a.ts').present).toBe(false);
  });

  // #391: "an absence assertion over a bad path passes for the wrong reason".
  // Measured: cat-file -e answers 128 both for a genuinely absent file and for
  // a path that was never right. The PR head is the positive control that
  // separates them, and it is checked FIRST.
  it('refuses to call a bad path an absence', () => {
    const reading = classifyFile({
      path: 'scripts/does-not-exist.mjs',
      status: 'modified',
      atHead: 128,
      atTarget: 128,
    });
    expect(reading.present).toBeNull();
    expect(reading.present).not.toBe(false);
    expect(reading.reason).toContain('path is wrong');
  });

  // NEGATIVE CONTROL for the arm above: the head check must not swallow a real
  // absence, or "refuses bad paths" would be satisfied by refusing everything.
  it('still calls a real absence an absence when the head has the file', () => {
    expect(
      classifyFile({
        path: 'scripts/check-protection-assumptions.mjs',
        status: 'modified',
        atHead: 0,
        atTarget: 128,
      }).present,
    ).toBe(false);
  });

  it('treats a deletion as evidence of nothing, because absence is its success', () => {
    expect(
      classifyFile({
        path: 'old.ts',
        status: 'removed',
        atHead: 128,
        atTarget: 128,
      }).present,
    ).toBeNull();
  });

  it('does not read an unexpected exit code as presence', () => {
    expect(
      classifyFile({ path: 'a.ts', status: 'added', atHead: 0, atTarget: 129 })
        .present,
    ).toBeNull();
  });
});

describe('classifying one merge', () => {
  it('passes a merge whose commit reached the target with its files present', () => {
    const result = classifyMerge({
      prNumber: 366,
      merged: true,
      mergeCommitSha: OTHER_SHA,
      baseRef: 'development',
      targetRef: 'origin/development',
      ancestry: reached,
      files: [present('a.ts'), present('b.ts')],
    });
    expect(result.verdict).toBe(VERDICT_LANDED);
  });

  // The #386 shape, exactly.
  it('refuses a merge that reports success and never reached the target', () => {
    const result = classifyMerge({
      prNumber: 386,
      merged: true,
      mergeCommitSha: SHA,
      baseRef: 'jpapiez-vasquez-merge-queue-credential',
      targetRef: 'origin/development',
      ancestry: notReached,
      files: [present('package.json'), absent('scripts/x.mjs')],
    });
    expect(result.verdict).toBe(VERDICT_NOT_LANDED);
    expect(result.reason).toContain('1ececa0f');
    expect(result.reason).toContain('jpapiez-vasquez-merge-queue-credential');
  });

  // A different animal from #386: the merge DID land and something after it
  // removed the content. Both mean the work is absent, so both refuse, but the
  // reason must keep them apart or the remedy is aimed at the wrong event.
  it('refuses a landed merge whose files are nonetheless absent, and says so differently', () => {
    const result = classifyMerge({
      prNumber: 400,
      merged: true,
      mergeCommitSha: OTHER_SHA,
      baseRef: 'development',
      targetRef: 'origin/development',
      ancestry: reached,
      files: [present('a.ts'), absent('scripts/gone.mjs')],
    });
    expect(result.verdict).toBe(VERDICT_NOT_LANDED);
    expect(result.reason).toContain('IS an ancestor');
    expect(result.reason).toContain('scripts/gone.mjs');
  });

  it('does not let a bad-path reading manufacture a refusal', () => {
    const result = classifyMerge({
      prNumber: 401,
      merged: true,
      mergeCommitSha: OTHER_SHA,
      targetRef: 'origin/development',
      ancestry: reached,
      files: [
        present('a.ts'),
        classifyFile({
          path: 'nope.ts',
          status: 'modified',
          atHead: 128,
          atTarget: 128,
        }),
      ],
    });
    expect(result.verdict).toBe(VERDICT_LANDED);
  });

  it('cannot verify a merge whose ancestry was never answered', () => {
    expect(
      classifyMerge({
        prNumber: 402,
        merged: true,
        mergeCommitSha: SHA,
        targetRef: 'origin/development',
        ancestry: classifyAncestry({ code: 128, subject: 'x' }),
        files: [],
      }).verdict,
    ).toBe(VERDICT_UNVERIFIABLE);
  });

  it('cannot verify a merge with no ancestry reading at all', () => {
    expect(
      classifyMerge({
        prNumber: 403,
        merged: true,
        mergeCommitSha: SHA,
        targetRef: 'origin/development',
      }).verdict,
    ).toBe(VERDICT_UNVERIFIABLE);
  });

  it('cannot verify a PR that is not merged', () => {
    expect(
      classifyMerge({ prNumber: 404, merged: false, mergeCommitSha: SHA })
        .verdict,
    ).toBe(VERDICT_UNVERIFIABLE);
  });

  // A merge_commit_sha that is absent, null, or a short sha must not be padded
  // or passed through: a 40-hex string invented from nothing survives
  // `rev-parse --verify`, so nothing downstream can be trusted to catch it.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a short sha', '1ececa0f'],
    ['a non-string', 12345],
    ['a 40-char non-hex string', 'z'.repeat(40)],
  ])('cannot verify a merge whose merge_commit_sha is %s', (_label, value) => {
    expect(
      classifyMerge({
        prNumber: 405,
        merged: true,
        mergeCommitSha: value,
        targetRef: 'origin/development',
        ancestry: reached,
      }).verdict,
    ).toBe(VERDICT_UNVERIFIABLE);
  });
});

describe('the sweep, which is the unit #391 needs', () => {
  const landed = classifyMerge({
    prNumber: 1,
    merged: true,
    mergeCommitSha: OTHER_SHA,
    targetRef: 't',
    ancestry: reached,
    files: [present('a.ts')],
  });
  const lost = classifyMerge({
    prNumber: 386,
    merged: true,
    mergeCommitSha: SHA,
    targetRef: 't',
    ancestry: notReached,
    files: [],
  });
  const unknown = classifyMerge({
    prNumber: 3,
    merged: true,
    mergeCommitSha: SHA,
    targetRef: 't',
    ancestry: classifyAncestry({ code: 128, subject: 'x' }),
  });

  it('passes a sweep in which every merge reached the target', () => {
    const sweep = evaluateSweep([landed, landed]);
    expect(sweep.exitCode).toBe(EXIT_LANDED);
    expect(sweep.verdict).toBe(VERDICT_LANDED);
  });

  it('finds the one loss among fourteen that landed', () => {
    const sweep = evaluateSweep([
      ...Array.from({ length: 14 }, () => landed),
      lost,
    ]);
    expect(sweep.exitCode).toBe(EXIT_NOT_LANDED);
    expect(sweep.notLanded).toHaveLength(1);
    expect(sweep.landed).toHaveLength(14);
  });

  it('reports unverifiable distinctly from landed', () => {
    expect(evaluateSweep([landed, unknown]).exitCode).toBe(EXIT_UNVERIFIABLE);
  });

  // This is the ranking that differs deliberately from mutation-harness.mjs,
  // where confounded OUTRANKS survived. There a confounded arm undermines its
  // own result; here an unverifiable PR says nothing about a different PR's
  // proven loss. Masking a confirmed loss behind an unrelated missing object
  // would be #391's own failure, committed by the tool built to catch it.
  it('does not let an unverifiable PR mask a different PR that provably did not land', () => {
    const sweep = evaluateSweep([unknown, lost, landed]);
    expect(sweep.exitCode).toBe(EXIT_NOT_LANDED);
    expect(sweep.notLanded).toHaveLength(1);
    expect(sweep.unverifiable).toHaveLength(1);
  });

  it('keeps the three exit codes distinct, so no caller can collapse them', () => {
    expect(
      new Set([EXIT_LANDED, EXIT_NOT_LANDED, EXIT_UNVERIFIABLE]).size,
    ).toBe(3);
  });

  it('names every unlanded PR in the output rather than only counting them', () => {
    const text = formatSweep(evaluateSweep([landed, lost]), {
      targetRef: 'origin/development',
    });
    expect(text).toContain('#386');
    expect(text).toContain('NOT LANDED');
    expect(text).toContain('origin/development');
  });

  it('says so plainly when there is nothing to report', () => {
    expect(formatSweep(evaluateSweep([landed]), { targetRef: 'x' })).toContain(
      'every merge in this set reached the target',
    );
  });

  it('reports unverifiable entries even when nothing failed outright', () => {
    expect(formatSweep(evaluateSweep([landed, unknown]), {})).toContain(
      'unverifiable',
    );
  });
});

describe('an adjudicated loss cannot outlive the repair it claims', () => {
  const entry = ADJUDICATED_LOSSES.find((item) => item.prNumber === 386);

  it('has #386 on record, because it is a true finding that can never be repaired in place', () => {
    // Its merge commit will never become an ancestor of trunk: the ref moved
    // past it and nothing undoes that. Without an adjudication the check is
    // permanently red on a true finding, and a permanently red check is one
    // whose remedy is to switch it off.
    expect(entry).toBeDefined();
    expect(entry?.restoredBy).toBe(390);
  });

  it('requires every entry to name a restoring PR, paths, and a reason', () => {
    for (const item of ADJUDICATED_LOSSES) {
      expect(typeof item.prNumber).toBe('number');
      expect(typeof item.restoredBy).toBe('number');
      expect(item.restoredPaths.length).toBeGreaterThan(0);
      expect(item.reason.trim()).not.toBe('');
    }
  });

  it('discharges the loss once every restored path is present on the target', () => {
    expect(classifyAdjudication({ entry, codes: [0, 0] }).discharged).toBe(
      true,
    );
  });

  // THE ROT CHECK. This is what stops the allowlist being a commitment: the
  // entry asserts a repair, and the repair is verified at run time. #390 is
  // still open as this ships, so this arm is the live one.
  it('refuses to discharge while the named restore has not landed', () => {
    const reading = classifyAdjudication({ entry, codes: [128, 128] });
    expect(reading.discharged).toBe(false);
    expect(reading.reason).toContain('has NOT landed');
  });

  it('refuses to discharge on a partial restore', () => {
    expect(classifyAdjudication({ entry, codes: [0, 128] }).discharged).toBe(
      false,
    );
  });

  it('refuses an adjudication that names no paths, which would assert nothing', () => {
    expect(
      classifyAdjudication({
        entry: { prNumber: 1, restoredBy: 2, restoredPaths: [], reason: 'x' },
        codes: [],
      }).discharged,
    ).toBe(false);
  });

  it('refuses an adjudication with an empty reason', () => {
    expect(
      classifyAdjudication({
        entry: {
          prNumber: 1,
          restoredBy: 2,
          restoredPaths: ['a'],
          reason: '  ',
        },
        codes: [0],
      }).discharged,
    ).toBe(false);
  });

  it('keeps a loss red when it is not adjudicated at all', () => {
    expect(classifyAdjudication({}).discharged).toBe(false);
  });

  it('turns a not-landed verdict into adjudicated only when discharged', () => {
    const base = {
      prNumber: 386,
      merged: true,
      mergeCommitSha: SHA,
      baseRef: 'other',
      targetRef: 'origin/development',
      ancestry: notReached,
      files: [],
    };
    expect(
      classifyMerge({
        ...base,
        adjudication: { discharged: true, reason: 'restored by #390' },
      }).verdict,
    ).toBe(VERDICT_ADJUDICATED);
    // NEGATIVE CONTROL: an undischarged adjudication must not soften anything.
    expect(
      classifyMerge({
        ...base,
        adjudication: { discharged: false, reason: 'restore has NOT landed' },
      }).verdict,
    ).toBe(VERDICT_NOT_LANDED);
  });

  it('does not let an adjudicated entry mask a different PR that did not land', () => {
    const adjudicated = classifyMerge({
      prNumber: 386,
      merged: true,
      mergeCommitSha: SHA,
      targetRef: 't',
      ancestry: notReached,
      adjudication: { discharged: true, reason: 'r' },
    });
    const other = classifyMerge({
      prNumber: 999,
      merged: true,
      mergeCommitSha: SHA,
      targetRef: 't',
      ancestry: notReached,
    });
    expect(evaluateSweep([adjudicated, other]).exitCode).toBe(EXIT_NOT_LANDED);
    expect(evaluateSweep([adjudicated]).exitCode).toBe(EXIT_LANDED);
  });

  it('still prints an adjudicated entry rather than hiding it', () => {
    const sweep = evaluateSweep([
      classifyMerge({
        prNumber: 386,
        merged: true,
        mergeCommitSha: SHA,
        targetRef: 't',
        ancestry: notReached,
        adjudication: { discharged: true, reason: 'discharged by #390' },
      }),
    ]);
    expect(formatSweep(sweep, {})).toContain('adjudicated');
    expect(formatSweep(sweep, {})).toContain('#390');
  });
});

describe('the subject of the ancestry question is the finding', () => {
  // Measured over the last 30 merged PRs in this repository:
  //   PR head          -> exit 1 for 9, of which 8 SHIPPED (squash merges)
  //   merge_commit_sha -> exit 1 for 1, which is #386
  // A squash discards the head, so head-ancestry cries loss on a quarter of
  // all healthy merges here and cannot separate its one true positive from its
  // eight false ones. This pins the classifier against the head reading.
  it('a squash-merged PR whose head is unreachable still counts as landed', () => {
    const squashed = classifyMerge({
      prNumber: 378,
      merged: true,
      // merge_commit_sha of a squash is the single-parent commit ON THE BASE,
      // and it IS an ancestor of the target even though the head is not.
      mergeCommitSha: OTHER_SHA,
      baseRef: 'development',
      targetRef: 'origin/development',
      ancestry: reached,
      files: [present('a.ts')],
    });
    expect(squashed.verdict).toBe(VERDICT_LANDED);
  });
});
