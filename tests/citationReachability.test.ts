import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const read = (...segments: string[]) =>
  readFileSync(path.join(repositoryRoot, ...segments), 'utf8');

/**
 * The branch list under a trigger arm, read in either YAML sequence form.
 *
 * An earlier form matched only the flow sequence (`branches: [development]`).
 * The block form
 *
 *   push:
 *     branches:
 *       - development
 *
 * is equally valid and means the same thing, and it failed the extraction
 * outright -- so the assertion reddened a correct workflow over a formatting
 * choice while reading as a claim about which branch the arm is subscribed to.
 * That is the false red this suite exists to avoid, inside this suite.
 */
const branchesOf = (workflow: string, event: string): string[] => {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^ {2}${event}:\\s*$`).test(line),
  );
  if (start < 0) return [];
  const arm: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    arm.push(line);
  }
  const at = arm.findIndex((line) => /^\s+branches:/.test(line));
  if (at < 0) return [];
  const inline = /^\s+branches:\s*\[([^\]]*)\]\s*$/.exec(arm[at] ?? '');
  const raw =
    inline === null
      ? arm.slice(at + 1).reduce<string[]>((names, line) => {
          const item = /^\s+-\s*(.+?)\s*$/.exec(line);
          if (item?.[1] !== undefined) names.push(item[1]);
          return names;
        }, [])
      : (inline[1] ?? '').split(',');
  return raw
    .map((name) => name.trim().replace(/^['"]|['"]$/g, ''))
    .filter((name) => name.length > 0);
};

/**
 * Every `if:` in the workflow, job-level and step-level alike.
 *
 * An earlier form asserted the absence of the single token
 * `github.event_name`. The property it meant to pin is "nothing here is
 * disabled on push", and there are several ways to write that which never
 * mention the event by name -- `github.event.pull_request != null`,
 * `startsWith(github.ref, 'refs/pull/')`, or the same guard on the one step
 * that invokes the harness. Each leaves every trigger armed and every
 * fallback expression intact and simply does nothing on push, and each passed.
 * The comment stated a property; the matcher tested a vocabulary.
 *
 * Collecting the conditions instead cannot be dodged by rephrasing. Its cost
 * is stated rather than hidden: it refuses a legitimate condition too. That is
 * the deliberate direction -- a condition added here should have to be
 * justified out loud, because the failure it guards against is a required
 * context that reports on push and never runs.
 */
const conditionsOf = (workflow: string): string[] =>
  workflow.split(/\r?\n/).reduce<string[]>((found, line) => {
    const match = /^\s+if:\s*(\S.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined) found.push(match[1]);
    return found;
  }, []);

/**
 * Evaluates the `${{ ... }}` expression subset this workflow actually uses, so
 * the fallbacks can be asserted as a PROPERTY rather than as a spelling.
 *
 * The previous assertions were `toContain('...base.ref || github.ref_name')`:
 * a literal substring of YAML. That pins one way of writing the fallback and
 * says nothing about what the fallback DOES. Measured, both directions of that
 * failure are real. A semantically identical rewrite (`github.sha` ->
 * `github.event.after`, the same value on push) turned them red; and when the
 * trunk copy of this workflow expressed the same intent as
 * `github.event_name == 'pull_request' && ... || 'development'`, they went red
 * against a workflow whose behaviour is correct on every subscribed event.
 *
 * A test that reddens on correct refactors is one a maintainer learns to edit
 * rather than heed, which is how the blind spot #428 describes gets restored.
 * So: evaluate, do not match. GitHub's `&&`/`||` are value-yielding with the
 * empty string falsy, which is precisely the semantics the fallback relies on.
 */
const evaluateExpression = (
  expression: string,
  context: Record<string, unknown>,
): unknown => {
  const tokens = expression.match(
    /'[^']*'|[A-Za-z_][\w.]*|==|!=|\(|\)|&&|\|\|/g,
  );
  if (tokens === null) throw new Error(`unparsable expression: ${expression}`);

  let cursor = 0;
  const peek = (): string | undefined => tokens[cursor];

  // GitHub's falsiness: '' and null/undefined and false are falsy. `0` is too,
  // but no expression here yields a number, so it is not special-cased.
  const truthy = (value: unknown): boolean =>
    value !== '' && value !== null && value !== undefined && value !== false;

  const primary = (): unknown => {
    const token = tokens[cursor++];
    if (token === undefined) throw new Error('unexpected end of expression');
    if (token === '(') {
      const inner = disjunction();
      if (tokens[cursor++] !== ')') throw new Error('unbalanced parenthesis');
      return inner;
    }
    if (token.startsWith("'")) return token.slice(1, -1);
    // A context path. An absent path yields '' - which is exactly what GitHub
    // renders for a null lookup, and the behaviour the fallback exists for.
    return (
      token
        .split('.')
        .reduce<unknown>(
          (node, key) =>
            node !== null && typeof node === 'object'
              ? (node as Record<string, unknown>)[key]
              : undefined,
          context,
        ) ?? ''
    );
  };

  const comparison = (): unknown => {
    let left = primary();
    while (peek() === '==' || peek() === '!=') {
      const operator = tokens[cursor++];
      const right = primary();
      left = operator === '==' ? left === right : left !== right;
    }
    return left;
  };

  const conjunction = (): unknown => {
    let left = comparison();
    while (peek() === '&&') {
      cursor++;
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  };

  function disjunction(): unknown {
    let left = conjunction();
    while (peek() === '||') {
      cursor++;
      const right = conjunction();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  return disjunction();
};

/** The `${{ ... }}` body assigned to `key`, wherever it sits in the file. */
const expressionFor = (workflow: string, key: string): string => {
  const match = new RegExp(
    `^\\s*${key}:\\s*\\$\\{\\{\\s*(.+?)\\s*\\}\\}\\s*$`,
    'm',
  ).exec(workflow);
  if (match?.[1] === undefined) {
    throw new Error(`no interpolated value for '${key}'`);
  }
  return match[1];
};

/**
 * The event names under `on:`. Read from the file so that adding an arm
 * without making its inputs resolve is a failure rather than an omission.
 */
const eventsOf = (workflow: string): string[] => {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start === -1) return [];
  const events: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}(\w+):/.exec(line);
    if (match?.[1] !== undefined) events.push(match[1]);
  }
  return events;
};

/** A synthetic payload for one event, shaped like the real `github` context. */ const contextFor =
  (eventName: string): Record<string, unknown> => ({
    github: {
      event_name: eventName,
      sha: 'f'.repeat(40),
      ref_name: eventName === 'pull_request' ? '428/merge' : 'development',
      event:
        eventName === 'pull_request'
          ? {
              pull_request: {
                head: { sha: 'a'.repeat(40) },
                base: { ref: 'development' },
              },
            }
          : // A real push payload carries `before`/`after`; `after` is the pushed
            // commit and equals `github.sha`. Modelled so that expressing the
            // fallback with it reads as the equivalent spelling it is, rather
            // than as a failure of this fixture to describe the event.
            eventName === 'push'
            ? { after: 'f'.repeat(40), before: 'b'.repeat(40) }
            : {},
    },
  });

const workflowsDir = path.join(repositoryRoot, '.github', 'workflows');

// The path the workflow was parked at while it could not be pushed. Named once
// so the denial case and the staleness case cannot drift apart, and asserted
// absent rather than assumed gone.
const stagedWorkflowPath = path.join(
  '.squad',
  'fact-checker',
  'citation-reachability.workflow.yml',
);
const liveWorkflows = readdirSync(workflowsDir)
  .filter((f) => f.endsWith('.yml'))
  .map((f) => ({
    file: f,
    text: readFileSync(path.join(workflowsDir, f), 'utf8'),
  }));

const HARNESS = 'scripts/check-citation-reachability.mjs';
// The refusal mechanism the harness imports. #421's cross-repository arm imports
// the same module with its own scan roots and its own floor: share the
// mechanism, never the number, because the two corpora are disjoint.
const CORPUS_MODULE = 'scripts/citation-corpus.mjs';
const SCRIPT_NAME = 'check:citation-reachability';

/**
 * A floor under every arm that spawns the harness into a fixture directory.
 *
 * Node exits **1** when a module fails to resolve, which is the same code the harness
 * uses for "these citations are broken". So an arm asserting a non-zero exit cannot
 * distinguish the check reporting a defect from the check being unable to start, and
 * an arm asserting the *absence* of a string is satisfied outright by a program that
 * printed nothing. ARM G held three assertions and a crash satisfied two of them; only
 * its demand for specific positive content failed, and that was luck rather than design.
 *
 * This is not the spawn failure `status === null` already covers - the spawn succeeded
 * and the process ran. It died at import, one layer further in, and reported it through
 * the verdict channel.
 */
const assertHarnessStarted = (out: string) => {
  if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(out))
    throw new Error(
      `the harness never loaded, so this arm tested nothing - its fixture is missing a file the harness imports:\n${out}`,
    );
};

const invokers = liveWorkflows.filter((w) =>
  w.text.includes(`npm run ${SCRIPT_NAME}`),
);
const enforcingWorkflow = invokers[0];
const isEnforced = enforcingWorkflow !== undefined;
// Read from the live workflow only. While the workflow was staged in `.squad/`,
// every case below fell back to the staged copy, so `isEnforced` was false in a
// working tree that had not yet merged the wiring commit and true in CI, whose
// `pull_request` checkout is a merge with the base - the same suite testing two
// different files at one commit and reporting one verdict. The two copies had
// already drifted by twenty lines when this was measured. An empty string here
// fails every matcher loudly rather than silently substituting another file.
const workflowText = enforcingWorkflow?.text ?? '';

/**
 * #121. The harness that checks citation reachability was landed complete,
 * controlled, and with zero call sites: no npm script, no workflow, no test,
 * and none of the check runs at that head was this one. It had executed exactly
 * once - on the author's machine, at authoring time, which is precisely the
 * position it exists to compensate for. A revision orphaned by a rebase keeps
 * resolving for whoever wrote the citation and resolves for no reader, so an
 * instrument aimed at the author's blind spot cannot be run only by the author.
 *
 * Three artifacts simultaneously asserted, in the present tense, that the check
 * was "Enforced by" that file. Those sentences were false, and nothing could
 * have reported them false: a green pull request reads identically whether a
 * check passed or was never invoked. The harness was correct, and correctness
 * is what made the omission invisible.
 *
 * The workflow could not be pushed from the branch that wrote the harness - that
 * token lacks the `workflow` OAuth scope, and the Contents API refuses the same
 * path - so it was staged in `.squad/` for a maintainer to move. A maintainer
 * has since moved it: `.github/workflows/citation-reachability.yml` is live and
 * runs `npm run check:citation-reachability` on every pull request, and the
 * live copy has since gained a step the staged one never had. The staged copy
 * is therefore removed rather than kept as a second source that can drift, and
 * its header - which asserted in the present tense that nothing enforced the
 * check - is removed with it. The final case below still revokes the licence to
 * claim enforcement automatically if the live workflow ever disappears.
 */
describe('the citation-reachability harness is invoked, not merely present', () => {
  it('is exposed as an npm script pointing at the harness', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts[SCRIPT_NAME]).toBe(`node ${HARNESS}`);
  });

  it('is enforced by a live workflow rather than a staged copy', () => {
    expect(isEnforced).toBe(true);
  });

  it('states a guarantee its own guards actually deliver', () => {
    // #481. Bind the claim in the designated header paragraph, not decorative
    // wording elsewhere in the workflow. The former header said the self-supplied
    // controls alone distinguished blindness from no orphans, even though those
    // controls stayed green when a renamed scan root produced an empty corpus.
    const guardContractOf = (workflow: string): string => {
      return (
        workflow.match(
          /^# The harness withholds its verdict[\s\S]*?(?=\r?\non:)/m,
        )?.[0] ?? ''
      );
    };
    const statesCurrentGuardContract = (contract: string): boolean =>
      [
        /classifier controls are\s+# necessary rather than sufficient:/,
        /three independent guard families:/,
        /classifier controls;/,
        /shallow-history refusal plus MAINLINE_FLOOR/,
        /scan-root preflights plus corpus-specific floors/,
        /local arm uses CITATION_FLOOR/,
        /cross-repository admin-guide arm\s+# below uses its own ADMIN_GUIDE_CITATION_FLOOR/,
        /none implies the others/,
      ].every((claim) => claim.test(contract));

    const guardContract = guardContractOf(workflowText);
    expect(statesCurrentGuardContract(guardContract)).toBe(true);

    // Mutation/negative control: restoring the stale sufficiency claim must fail
    // even if the corrected phrase is appended decoratively outside the header.
    const staleWorkflow =
      workflowText.replace(
        'necessary rather than sufficient:',
        'sufficient on their own:',
      ) + '\n# necessary rather than sufficient:\n';
    expect(staleWorkflow).not.toBe(workflowText);
    expect(statesCurrentGuardContract(guardContractOf(staleWorkflow))).toBe(
      false,
    );

    // Every named guard family must also exist where the header says it does.
    const harness = read(HARNESS);
    const corpus = read(CORPUS_MODULE);
    const adminGuideHarness = read('scripts/check-admin-guide-citations.mjs');

    // reader side - depth
    expect(workflowText).toMatch(/MAINLINE_FLOOR/);
    expect(harness).toContain('INCONCLUSIVE: this is a shallow clone');
    // corpus side - the two guards added for #481. Matched on the declaration and
    // the call rather than on the bare name: `toContain('CITATION_FLOOR')` is
    // satisfied by `CITATION_FLOOR_X`, so it survives a rename that removes the
    // guard. Measured - that mutation stayed green until these were tightened.
    expect(harness).toMatch(/const CITATION_FLOOR = \d+;/);
    expect(harness).toMatch(
      /requireCorpusFloor\(\{\s*count: cited\.size,\s*floor,?\s*\}\)/,
    );
    // Whitespace-tolerant: prettier reflows this ternary across lines, and a
    // formatter is a mutation operator this file does not control. Measured -
    // an exact-spacing version of the next assertion broke on `prettier --write`
    // with the guard entirely intact, which is a false positive, not a finding.
    expect(harness).toMatch(/floorArg\s*\?\s*Number\(floorArg\.slice/);
    expect(harness).toMatch(/:\s*CITATION_FLOOR;/);
    expect(harness).toMatch(/requireScanRoots\(loadCorpus\(FILES\)\)/);
    expect(corpus).toContain('a scan root is missing or unreadable');
    // classifier side
    expect(harness).toContain('CONTROL FAILED');

    // The floor must be stated by each caller, never by the shared mechanism.
    // #421's cross-repository corpus is disjoint and has its own calibrated floor.
    expect(corpus).not.toMatch(/const CITATION_FLOOR/);
    expect(adminGuideHarness).toMatch(
      /export const ADMIN_GUIDE_CITATION_FLOOR = \d+;/,
    );
    expect(adminGuideHarness).toMatch(
      /requireScanRoots\(loadCorpus\(\[GUIDE_PATH\]\)\)/,
    );
    expect(adminGuideHarness).toMatch(
      /requireCorpusFloor\(\{\s*count: parsed\.citations\.length,\s*floor: ADMIN_GUIDE_CITATION_FLOOR,/,
    );

    // `--floor` exists for synthetic fixtures whose ledger is built by hand. An
    // armed invocation must never pass it, or the guard is unarmed by the very
    // thing that runs it - and unlike an environment variable, a flag has to be
    // written here to take effect, so its absence is assertable.
    expect(read('package.json')).not.toContain('--floor');
    expect(workflowText).not.toContain('--floor');
    // Positive control: the flag is real and the harness does parse it, so the
    // two assertions above are absences of something that exists.
    expect(harness).toContain('--floor=');

    // Negative control: strings a reader might expect and these files do not
    // carry, so the assertions above are not passing on a substring of
    // something else.
    expect(harness).not.toContain('CORPUS_FLOOR');
    expect(adminGuideHarness).not.toMatch(/(?:^|\s)CITATION_FLOOR(?:\s|[=;,])/);
  });

  it('subscribes to pull_request, which carries the branch under review', () => {
    const workflow = workflowText;

    // `\r?` because the working tree is CRLF on Windows checkouts and LF in CI;
    // a regex that passes on one and fails on the other reports the platform
    // rather than the workflow. Found by the negative control, not by review.
    expect(workflow).toMatch(/^on:\r?\n\s+pull_request:/m);
    // synchronize is load-bearing: without it the check would run on a branch's
    // first commit and never again, so a citation orphaned by a later rebase -
    // the exact mechanism in scope - would never be examined.
    expect(workflow).toMatch(/types:\s*\[[^\]]*\bsynchronize\b[^\]]*\]/);
  });

  /**
   * #428, and the reason the case above no longer calls pull_request "the only
   * event carrying the branch to check". It is not the only one, and believing
   * it was is what left this check aimed away from its own defect.
   *
   * A pull_request run examines a head whose branch still exists, so a
   * self-citation is reachable and the harness exits 0. Squash-merging that
   * pull request and deleting the branch is the operation that orphans the
   * citation. So the check passed, the merge then falsified what it had passed,
   * and no event in the trigger set could ever observe the result. The failure
   * existed only on trunk, and the instrument only ever looked at branches.
   *
   * That is a stronger statement than "coverage was incomplete": a trigger set
   * confined to the side where the failure cannot exist is not a weak
   * instrument for this defect, it is a non-instrument, and its green is
   * uninformative rather than reassuring.
   */
  it('also fires after the merge, the operation that creates the failure', () => {
    const workflow = workflowText;

    const NON_PR_ARMS = /^\s{2}(?:push|schedule):/m;

    // The binding assertion. Narrowing the trigger set back to pull_request
    // alone - the likeliest edit, since every step here reads a pull_request
    // context - turns this red instead of silently restoring the blind spot.
    expect(workflow).toMatch(NON_PR_ARMS);

    // The branch is read out of the list and compared as an element, not
    // matched as a substring. `\bdevelopment\b` inside the list looked like it
    // pinned the branch and did not: `\b` matches at the hyphen, so
    // `[development-typo]` satisfied it while naming a branch that does not
    // exist, and the arm would never have fired on trunk.
    const branches = branchesOf(workflow, 'push');
    expect(branches).toContain('development');
    // Control on the extraction, in band: a parser that returned [] for
    // everything would satisfy nothing above, but one that returned the whole
    // list as a single string would satisfy `toContain` only by accident. This
    // pins that the near-miss names are absent as elements.
    expect(branches).not.toContain('development-typo');
    // And the reader is shown reading BOTH YAML sequence forms. Without these
    // the extraction could be satisfied by the shape this workflow happens to
    // be written in today, and reformatting it -- a change that alters nothing
    // about which branch is subscribed -- would turn this red.
    expect(
      branchesOf('on:\n  push:\n    branches: [development]\n', 'push'),
    ).toEqual(['development']);
    expect(
      branchesOf('on:\n  push:\n    branches:\n      - development\n', 'push'),
    ).toEqual(['development']);
    // Negative control: an arm carrying no branch list must read as empty
    // rather than as a pass, so a workflow that lost the list fails here.
    expect(branchesOf('on:\n  push:\n    tags: [v1]\n', 'push')).toEqual([]);

    // Control on the matcher, in band. Without it, a pattern that matched
    // everything would assert the arm is present for a workflow that lost it,
    // and this case would be the thing it is guarding against.
    expect('name: X\non:\n  pull_request:\n    types: [opened]\n').not.toMatch(
      NON_PR_ARMS,
    );

    // The push arm must not drag the check into a ruleset. It runs on the
    // branch a queue would gate, and a required context that reports on push
    // but not for a queued entry sits Pending forever - #122's deadlock.
    expect(workflow).toMatch(/^#\s*merge-queue:\s*advisory$/m);
    expect(workflow).not.toMatch(/^\s+merge_group:/m);
  });

  it('resolves its inputs on events that carry no pull_request object', () => {
    const workflow = workflowText;

    // A push arm whose steps only read `github.event.pull_request.*` is armed
    // in the trigger block and inert in the job: the expressions resolve to the
    // empty string, `ref:` quietly becomes the default, and the mainline
    // refspec becomes `+refs/heads/:refs/...`, which git rejects for a reason
    // that names neither this check nor the trigger. A red that misattributes
    // is worse here than no arm at all, because it gets the arm removed.
    // The property, not the spelling. Every event this workflow subscribes to
    // must resolve BOTH inputs to something non-empty; on a pull request the
    // ref must be the PR head rather than the synthetic merge commit, because
    // the twin index is built over the branch's own commits.
    //
    // `on:` is read from the workflow rather than listed here, so adding an arm
    // without making it resolve is a failure instead of an untested addition.
    const refExpression = expressionFor(workflow, 'ref');
    const mainlineExpression = /^\s*(?:BASE_REF|MAINLINE_REF):/m.test(workflow)
      ? expressionFor(workflow, '(?:BASE_REF|MAINLINE_REF)')
      : undefined;
    expect(mainlineExpression).toBeDefined();

    const subscribedEvents = eventsOf(workflow);
    // The collector found the arms at all; without this the loop is vacuous.
    expect(subscribedEvents).toContain('pull_request');
    expect(subscribedEvents).toContain('push');

    for (const eventName of subscribedEvents) {
      const context = contextFor(eventName);
      const ref = evaluateExpression(refExpression, context);
      const mainline = evaluateExpression(mainlineExpression!, context);
      // Non-empty is the whole point: an empty ref silently becomes "the
      // default", and an empty mainline name builds `+refs/heads/:refs/...`,
      // which git rejects with a message naming neither this check nor the
      // trigger. A red that misattributes is worse than a missing arm here,
      // because it is the arm that gets deleted.
      expect(ref, `ref on ${eventName}`).not.toBe('');
      expect(mainline, `mainline ref on ${eventName}`).not.toBe('');
      expect(typeof ref, `ref on ${eventName}`).toBe('string');
      expect(typeof mainline, `mainline on ${eventName}`).toBe('string');
    }

    // On a pull request the ref is the PR head, not `github.sha` (the merge).
    expect(evaluateExpression(refExpression, contextFor('pull_request'))).toBe(
      'a'.repeat(40),
    );
    // Off a pull request it is the pushed/scheduled commit.
    expect(evaluateExpression(refExpression, contextFor('push'))).toBe(
      'f'.repeat(40),
    );

    // Controls on the evaluator, in band. Without these an evaluator that
    // returned a non-empty constant would satisfy every assertion above, and
    // this case would be the thing it is guarding against. Each control is the
    // pre-#428 spelling: correct on a pull request, empty on push - which is
    // the defect, reproduced here so the evaluator is shown detecting it.
    expect(
      evaluateExpression(
        'github.event.pull_request.head.sha',
        contextFor('push'),
      ),
    ).toBe('');
    expect(
      evaluateExpression(
        'github.event.pull_request.base.ref',
        contextFor('schedule'),
      ),
    ).toBe('');
    // And it agrees with GitHub on the two spellings actually in use, so the
    // property is not being satisfied by a quirk of the parser.
    expect(
      evaluateExpression(
        "github.event_name == 'pull_request' && github.event.pull_request.base.ref || 'development'",
        contextFor('push'),
      ),
    ).toBe('development');
    expect(
      evaluateExpression(
        'github.event.pull_request.base.ref || github.ref_name',
        contextFor('push'),
      ),
    ).toBe('development');

    // The job name is load-bearing outside this file: it is the check-run
    // display name, the string a branch ruleset would name, and the string
    // scripts/check-merge-queue-contexts.mjs matches against live branch
    // protection. It was unguarded - changing it broke nothing - so it is
    // pinned here.
    const jobName = /^\s{4}name:\s*(\S.*?)\s*$/m.exec(workflow)?.[1];
    expect(jobName).toBe('Citation reachability');
    const refusals = workflow
      .split(/\r?\n/)
      .filter((line) => line.includes('::error::'));
    // The workflow refuses somewhere at all. Without this, anything said about
    // the refusals below is vacuously true of a workflow that refuses nowhere.
    expect(refusals.length).toBeGreaterThan(0);

    // NOT asserted here, deliberately: that every refusal names the check it
    // comes from. The workflow's header argues that a red naming the wrong
    // thing "would be read as this check being broken rather than as the
    // trigger being wrong", and its two `::error::` messages name the
    // condition while never naming the check - so the one attribution the
    // argument turns on is the one missing. The fix is two words per message.
    //
    // It is a maintainer patch rather than a change here, for the same reason
    // recorded above for the header wording: `.github/workflows/` cannot be
    // written by this branch's token, which lacks the `workflow` OAuth scope.
    // Asserting the corrected wording now would make this suite fail until a
    // human acts, which reports the token rather than the workflow - and a
    // suite that is red for a reason it does not name is the exact failure
    // this file exists to argue against. Restore the loop
    //
    //   for (const refusal of refusals) expect(refusal).toContain(jobName);
    //
    // in the same commit that prefixes both messages with `${jobName}: `.

    // The expression pins above cannot see the cheaper form of the same
    // inertness. A job- or step-level `if:` that excludes push leaves every
    // trigger armed and every fallback expression intact, and simply never runs
    // the job on the event the arm exists for -- the workflow is subscribed to
    // push and does nothing on push. Nothing about the expressions changes, so
    // asserting on them is green either way.
    expect(conditionsOf(workflow)).toEqual([]);
    // Controls on the collector, in band, one per way of writing the guard.
    // The form this replaced keyed on the token `github.event_name` and so was
    // blind to the other three, each of which disables the push arm just as
    // completely. A collector that found nothing would assert "no condition"
    // for a workflow that has one -- the failure this case exists to catch --
    // so it is shown finding every shape before its emptiness is trusted.
    expect(
      conditionsOf(
        "jobs:\n  x:\n    if: github.event_name == 'pull_request'\n",
      ),
    ).toEqual(["github.event_name == 'pull_request'"]);
    expect(
      conditionsOf('jobs:\n  x:\n    if: github.event.pull_request != null\n'),
    ).toEqual(['github.event.pull_request != null']);
    expect(
      conditionsOf(
        "jobs:\n  x:\n    if: startsWith(github.ref, 'refs/pull/')\n",
      ),
    ).toEqual(["startsWith(github.ref, 'refs/pull/')"]);
    expect(
      conditionsOf(
        'jobs:\n  x:\n    steps:\n      - run: node x.mjs\n        if: github.event.pull_request != null\n',
      ),
    ).toEqual(['github.event.pull_request != null']);
  });

  it('checks out the graph it needs rather than a depth-1 merge commit', () => {
    const workflow = workflowText;

    // Reachability, the patch-id twin index and the declared-route probes all
    // read history. A shallow checkout would report orphans a reader can in
    // fact reach, and a check that fails for the wrong reason gets ignored.
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('github.event.pull_request.head.sha');
    expect(workflow).toContain('refs/remotes/origin/development');
  });

  it('declares a merge-queue class, and does not claim to report for a queued entry', () => {
    const workflow = workflowText;

    // advisory: emits a check run on pull_request, does not report under
    // merge_group, and therefore must never become a required context - a
    // required context nothing emits sits Pending forever and blocks the queue.
    expect(workflow).toMatch(/^#\s*merge-queue:\s*advisory$/m);
    expect(workflow).not.toMatch(/^\s+merge_group:/m);
  });

  it('lets no artifact claim enforcement while nothing enforces it', () => {
    const claimants = [
      '.squad/fact-checker/policy.md',
      '.squad/fact-checker/audit-trail.md',
      '.squad/decisions/inbox/sha-reporting-rule.md',
      '.squad/decisions/inbox/fact-checker-symmetric-diff.md',
    ].filter((f) =>
      // Quotation spans are stripped first. Run I of the audit trail measured
      // `_"..."_` as this repository's in-use mention marker, and the entry
      // recording this very defect necessarily quotes the false sentence it is
      // withdrawing. A detector that cannot tell a retraction from the claim it
      // retracts scores a hit on the document doing the retracting - which is
      // the failure this suite exists to prevent, arriving in the suite itself.
      /Enforced (by|on every pull request)/.test(
        read(...f.split('/')).replace(/_"[^"]*"_/g, ''),
      ),
    );

    // One-directional. An artifact is free to say nothing; what it may not do is
    // assert enforcement that does not exist. This is the exact defect the entry
    // above records, expressed so that it fails a test instead of a reader.
    if (!isEnforced) {
      expect(claimants).toEqual([]);
    }
  });

  // The other direction, added after it fired. While `isEnforced` was false the
  // case above carried the whole burden; the moment a maintainer moved the
  // workflow it became `if (false)`, an assertion whose outcome is decided by a
  // condition outside its subject - the same shape as a guard that is constantly
  // true, only quieter, because a vacuous test reports success.
  //
  // What it left uncovered is the reverse claim. Three normative documents went
  // on stating that the check was *not* enforced, and naming a staged path that
  // had been deleted, for hours after the live workflow began passing on every
  // pull request. Nothing failed, because denial was never the modelled failure.
  //
  // A stale denial is the more dangerous of the two: an over-claim invites the
  // reader to check and be disappointed, while an under-claim invites them not
  // to rely on a control that is in fact protecting them, and it decays silently
  // toward *do the work by hand*.
  //
  // The ledger is deliberately not a subject here, and the asymmetry is the
  // point rather than an exemption. `audit-trail.md` records dated observations
  // that were true when taken; a present-tense detector run over a historical
  // record would demand the record be falsified to pass. A policy asserts what
  // is true now and must track the object. Only the normative documents are
  // checked, and the trail records the transition in a new entry instead.
  it('lets no artifact deny enforcement while something enforces it', () => {
    const deniers = [
      '.squad/fact-checker/policy.md',
      '.squad/decisions/inbox/sha-reporting-rule.md',
      '.squad/decisions/inbox/fact-checker-symmetric-diff.md',
    ].filter((f) => {
      const text = read(...f.split('/')).replace(/_"[^"]*"_/g, '');
      return (
        /Not yet enforced/.test(text) ||
        /citation-reachability\.workflow\.yml/.test(text)
      );
    });

    if (isEnforced) {
      expect(deniers).toEqual([]);
    }
  });

  // Neither case above can fail while `isEnforced` is misread, so the flag gets
  // its own assertion rather than being trusted by the two that branch on it.
  it('decides enforcement from a workflow that actually invokes the harness', () => {
    expect(isEnforced).toBe(true);
    expect(workflowText).toContain('check:citation-reachability');
    expect(existsSync(path.join(repositoryRoot, stagedWorkflowPath))).toBe(
      false,
    );
  });
});

/**
 * #445. A declared twin was accepted on reachability alone. The verdict string named its own
 * two properties - "(declared, reachable)" - and twinship was not among them, so the single
 * claim the line made was the one claim nothing had checked. The whole route is
 * `patch-id hint -> a human writes a declaration -> the checker trusts it`, and no step in it
 * compared any content: a mistyped SHA, or any reachable commit at all, passed.
 *
 * The obvious repair is the wrong one, and it is worth stating why it is not used here.
 * `patch-id` hashes the diff *including context*, so the same appended lines landing on
 * different neighbours after a rebase produce different ids - and a rebase is exactly what
 * orphans the citation that makes a twin declaration necessary in the first place. Comparing
 * patch-ids would therefore reject genuine twins, most often on the busiest files. Arm B below
 * is that hazard as a test rather than as a claim: its twin is real but its context has moved.
 *
 * The check also may not simply *require* a content match, because the reader it speaks for
 * does not hold the orphaned object and never can. Presence is consulted in the refuting
 * direction only: it can withdraw a pass, never manufacture one. Arm C is that boundary - the
 * same declaration, from a position with no object, still passes, and now says so.
 */
describe('a declared twin is checked for being a twin', () => {
  const made: string[] = [];

  const run = (dir: string, args: string[] = []) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  const commit = (dir: string, message: string) => {
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-qm', message], {
      stdio: 'ignore',
    });
    return run(dir, ['rev-parse', 'HEAD']);
  };

  const ledger = (dir: string, citedSha: string, twinSha: string | null) =>
    writeFileSync(
      path.join(dir, '.squad', 'fact-checker', 'audit-trail.md'),
      [
        '# Audit trail',
        '',
        `The finding was recorded at \`${citedSha}\`.`,
        '',
        ...(twinSha
          ? [
              '## Superseded citations and their live twins',
              '',
              `- \`${citedSha}\` - \`${twinSha}\` rebased onto the current base.`,
              '',
            ]
          : []),
      ].join('\n'),
    );

  // These fixtures build a two-citation ledger by hand, which sits below the corpus floor the
  // harness carries for this repository. `--floor=0` says so explicitly rather than leaving the
  // arms to fail for a reason none of them is about. The floor itself is exercised in
  // `the harness refuses to publish a verdict it cannot support`, and no armed invocation passes
  // this flag - asserted in `states a guarantee its own guards actually deliver`.
  const runHarness = (dir: string) => {
    const r = spawnSync(
      'node',
      ['scripts/check-citation-reachability.mjs', '--floor=0'],
      {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      },
    );
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assertHarnessStarted(out);
    return { status: r.status, out };
  };

  /**
   * One repository carries all three arms, so nothing separates them but the declaration
   * under test. `cited` is appended, then reset away: the object is still in the store and
   * still resolves, and is reachable from nothing - the exact position of a citation orphaned
   * by a rebase. `genuineTwin` re-adds those identical lines after a padding commit has moved
   * the context beneath them, so it is a true twin whose patch-id differs.
   */
  const fixture = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'twin-'));
    made.push(dir);
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C',
      dir,
      'config',
      'user.email',
      't@example.invalid',
    ]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, '.squad', 'fact-checker'), { recursive: true });
    for (const script of [HARNESS, CORPUS_MODULE]) {
      copyFileSync(
        path.join(repositoryRoot, script),
        path.join(dir, script.replace(/\//g, path.sep)),
      );
    }
    writeFileSync(path.join(dir, '.squad', 'fact-checker', 'policy.md'), '');

    const notes = path.join(dir, 'notes.md');
    writeFileSync(notes, 'opening line\n');
    ledger(dir, '0'.repeat(40), null);
    commit(dir, 'seed');

    const FINDING = 'the sidecar was absent\nand the control could not fire\n';
    writeFileSync(notes, `opening line\n${FINDING}`);
    const cited = commit(dir, 'the finding');

    execFileSync('git', ['-C', dir, 'reset', '-q', '--hard', 'HEAD~1'], {
      stdio: 'ignore',
    });

    writeFileSync(notes, 'opening line\ncontext that arrived in between\n');
    commit(dir, 'padding that moves the context');

    writeFileSync(
      notes,
      `opening line\ncontext that arrived in between\n${FINDING}`,
    );
    const genuineTwin = commit(dir, 'the finding, rebased');

    writeFileSync(path.join(dir, 'other.md'), 'an entirely unrelated change\n');
    const unrelated = commit(dir, 'unrelated work');

    return { dir, cited, genuineTwin, unrelated };
  };

  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('holds the fixture to its own premises before anything is asserted on it', () => {
    const { dir, cited, genuineTwin, unrelated } = fixture();

    // Unless the cited object is present AND unreachable, arm A cannot fail for the reason
    // it claims, and a green would mean nothing.
    expect(run(dir, ['cat-file', '-t', cited])).toBe('commit');
    expect(
      spawnSync('git', [
        '-C',
        dir,
        'merge-base',
        '--is-ancestor',
        cited,
        'HEAD',
      ]).status,
    ).not.toBe(0);
    for (const reachableSha of [genuineTwin, unrelated]) {
      expect(
        spawnSync('git', [
          '-C',
          dir,
          'merge-base',
          '--is-ancestor',
          reachableSha,
          'HEAD',
        ]).status,
      ).toBe(0);
    }

    // And the twin must be one `patch-id` cannot see, or arm B passes without exercising the
    // hazard it exists for.
    const patchId = (rev: string) =>
      execFileSync('git', ['patch-id', '--stable'], {
        input: execFileSync('git', ['-C', dir, 'show', rev], {
          encoding: 'utf8',
          maxBuffer: 1 << 28,
        }),
        encoding: 'utf8',
      }).split(' ')[0];
    expect(patchId(cited)).not.toBe(patchId(genuineTwin));
  });

  it('ARM A: does not claim twinship for a reachable commit that is not a twin', () => {
    const { dir, cited, unrelated } = fixture();
    ledger(dir, cited, unrelated);

    const { status, out } = runHarness(dir);

    // The defect: the old verdict read "(declared, reachable)" here, naming two properties
    // while the reader took it as asserting a third. The pass itself is not withdrawn - see
    // ARM D for why refusing it is not available - but it no longer claims what nothing checked.
    expect(out).toContain('TWINSHIP UNVERIFIED');
    expect(out).not.toContain('content verified');
    expect(status).toBe(0);
  });

  it('ARM B: recognises a real twin whose context moved under it', () => {
    const { dir, cited, genuineTwin } = fixture();
    ledger(dir, cited, genuineTwin);

    const { status, out } = runHarness(dir);

    // The arm that makes ARM A attributable. Without it, "ARM A says unverified" is equally
    // consistent with a check that can never verify anything.
    expect(out).toContain('content verified');
    expect(out).not.toContain('TWINSHIP UNVERIFIED');
    expect(status).toBe(0);
  });

  it('ARM C: says unverified from a position that holds no object at all', () => {
    const { dir, genuineTwin } = fixture();
    ledger(dir, 'a'.repeat(40), genuineTwin);

    const { status, out } = runHarness(dir);

    // The reader's position, and the reason a content match may never be *required*: the
    // reader cannot hold the orphaned object, so requiring one reports ORPHAN for everyone
    // but the author - the asymmetry this harness exists to avoid.
    expect(status).toBe(0);
    expect(out).toContain('TWINSHIP UNVERIFIED');
  });

  /**
   * The hint path, which is where #413 actually bites this harness.
   *
   * `git patch-id --stable` hashes context lines, so a true twin that landed after somebody
   * else appended carries a different id. The *verdict* never depended on that - it uses the
   * containment test, which is why ARM B has been exercising this hazard since before the
   * issue was filed - but the authoring hint did, and it degraded on exactly the append-only
   * ledger every citation here points at.
   *
   * The failure this guards is not a false ORPHAN. The revision is an orphan either way. What
   * was lost is the line naming the commit to declare, and a bare orphan carrying no candidate
   * reads as "there is no twin", which is the opposite of the truth.
   */
  it('ARM F: names a candidate twin the patch-id cannot see, without rescuing the verdict', () => {
    const { dir, cited, genuineTwin } = fixture();
    ledger(dir, cited, null);

    // Premise, asserted rather than assumed: unless patch-id genuinely fails on this pair the
    // arm passes without exercising the hazard, and a green would mean nothing.
    const patchId = (rev: string) =>
      execFileSync('git', ['patch-id', '--stable'], {
        input: execFileSync('git', ['-C', dir, 'show', rev], {
          encoding: 'utf8',
          maxBuffer: 1 << 28,
        }),
        encoding: 'utf8',
      }).split(' ')[0];
    expect(patchId(cited)).not.toBe(patchId(genuineTwin));

    const { status, out } = runHarness(dir);

    expect(out).toContain(`candidate twin ${genuineTwin.slice(0, 8)}`);
    expect(out).toContain('patch-id differs');

    // The hint is a remedy, never a verdict. An undeclared orphan stays an orphan and the
    // harness still exits non-zero, or the aid would have become the pass it must never be.
    expect(out).toContain('ORPHAN');
    expect(status).toBe(1);
  });

  it('ARM G: offers no candidate when nothing in reach contains the cited lines', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nocand-'));
    made.push(dir);
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C',
      dir,
      'config',
      'user.email',
      't@example.invalid',
    ]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, '.squad', 'fact-checker'), { recursive: true });
    // Both files, because the harness imports the second one. This fixture named its
    // single file literally while its three siblings copy a list, so #495's extraction
    // of the refusal mechanism reached them and not this one.
    for (const script of [HARNESS, CORPUS_MODULE])
      copyFileSync(
        path.join(repositoryRoot, script),
        path.join(dir, script.replace(/\//g, path.sep)),
      );
    writeFileSync(path.join(dir, '.squad', 'fact-checker', 'policy.md'), '');

    const notes = path.join(dir, 'notes.md');
    writeFileSync(notes, 'opening line\n');
    ledger(dir, '0'.repeat(40), null);
    commit(dir, 'seed');

    writeFileSync(notes, 'opening line\na finding that is never re-added\n');
    const orphan = commit(dir, 'the finding');
    execFileSync('git', ['-C', dir, 'reset', '-q', '--hard', 'HEAD~1'], {
      stdio: 'ignore',
    });

    writeFileSync(path.join(dir, 'other.md'), 'entirely unrelated\n');
    commit(dir, 'unrelated work');
    ledger(dir, orphan, null);

    const { status, out } = runHarness(dir);

    // Without this arm, "ARM F found a candidate" is equally consistent with a fallback that
    // matches anything it is shown - the containment test runs over every commit in reach, and
    // a rule loose enough to always match would look identical on ARM F alone.
    //
    // Stated plainly because an unmarked always-green test is its own defect: this arm passes
    // against the pre-fix harness as well, and is meant to. Measured by replaying the harness
    // at the parent commit with both arms present - ARM F fails there, ARM G passes. It is a
    // bound on the fallback's looseness, not a detector of the defect, and only ARM F carries
    // the claim that the repair does anything.
    expect(out).toContain('no declared twin, undeclared');
    expect(out).not.toContain('candidate twin');
    expect(status).toBe(1);
  });

  /**
   * The regression guard for the fix that was nearly shipped instead of this one.
   *
   * Every twin declaration in this repository names a squash - 41 commits of #162 collapsed
   * into one - so the twin's content is the union of its inputs and identical to none of them.
   * Measured against the live ledger, requiring equality refused 34 of 44 correct rows and
   * requiring containment still refused 30, because a long squash legitimately loses the
   * intermediate states when a later commit edits a line an earlier one added.
   *
   * This fixture is that shape at small scale: `beta` is added by the cited revision and no
   * longer present in the squash, so containment fails and the row is still correct. A check
   * that reddens it is worse than one that says nothing.
   */
  it('ARM D: never reddens a squash whose intermediate lines did not survive', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'squash-'));
    made.push(dir);
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C',
      dir,
      'config',
      'user.email',
      't@example.invalid',
    ]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, '.squad', 'fact-checker'), { recursive: true });
    for (const script of [HARNESS, CORPUS_MODULE]) {
      copyFileSync(
        path.join(repositoryRoot, script),
        path.join(dir, script.replace(/\//g, path.sep)),
      );
    }
    writeFileSync(path.join(dir, '.squad', 'fact-checker', 'policy.md'), '');

    const notes = path.join(dir, 'notes.md');
    writeFileSync(notes, 'opening line\n');
    ledger(dir, '0'.repeat(40), null);
    commit(dir, 'seed');

    writeFileSync(notes, 'opening line\nalpha\nbeta\n');
    const citedOnBranch = commit(dir, 'work, later revised');

    execFileSync('git', ['-C', dir, 'reset', '-q', '--hard', 'HEAD~1'], {
      stdio: 'ignore',
    });

    // The squash: `alpha` survived, `beta` was revised away before the merge.
    writeFileSync(notes, 'opening line\nalpha\ngamma\n');
    const squash = commit(dir, 'squashed #162');

    ledger(dir, citedOnBranch, squash);
    const { status, out } = runHarness(dir);

    expect(status).toBe(0);
    expect(out).not.toContain('ORPHANED CITATIONS');
    expect(out).toContain('TWINSHIP UNVERIFIED');
  });

  it('carries a control proving the comparison can separate two revisions', () => {
    const { dir, cited, genuineTwin } = fixture();
    ledger(dir, cited, genuineTwin);

    // A comparison that always matched would stamp "content verified" on every declaration -
    // the same false reassurance in a new costume - so it is measured in-band, not assumed.
    expect(runHarness(dir).out).toContain(
      'control: the twin comparison separates two distinct revisions true',
    );
  });

  /**
   * The control above is only worth having if it runs where the harness runs. It did not.
   * `git show` renders a merge as a combined diff - one column per parent, every line
   * `++`-prefixed - so the added-line reader reports null for one, and the first version of
   * this control read HEAD and HEAD~1 directly. On any checkout of a branch that has been
   * updated from its base, both are merge commits, so the block was skipped, printed nothing,
   * and the run passed. Measured on this repository: with the broken comparison installed, the
   * old selection exits 0 and the current one exits 2.
   *
   * That is the failure this suite exists to catch, committed inside the fix for it, so the
   * guard is a merge commit at HEAD and the assertion is that the control was exercised at all.
   * The negative half matters as much as the positive: `NOT EXERCISED` must not appear, because
   * a skip that announces itself still leaves the comparison unmeasured.
   */
  it('ARM E: exercises that control from a checkout whose HEAD is a merge commit', () => {
    const { dir, cited, genuineTwin } = fixture();
    ledger(dir, cited, genuineTwin);

    const mainline = run(dir, ['rev-parse', 'HEAD']);
    run(dir, ['checkout', '-q', '-b', 'side', 'HEAD~1']);
    writeFileSync(path.join(dir, 'side.md'), 'work done in parallel\n');
    commit(dir, 'side work');
    run(dir, ['checkout', '-q', '-']);
    execFileSync(
      'git',
      ['-C', dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'],
      { stdio: 'ignore' },
    );

    // The premise: without it the arm proves nothing, because a non-merge HEAD passes trivially.
    const parents = run(dir, [
      'rev-list',
      '--parents',
      '-n',
      '1',
      'HEAD',
    ]).split(' ').length;
    expect(parents).toBe(3);
    expect(run(dir, ['rev-parse', 'HEAD'])).not.toBe(mainline);

    const { status, out } = runHarness(dir);
    expect(out).toContain(
      'control: the twin comparison separates two distinct revisions true',
    );
    expect(out).not.toContain('NOT EXERCISED');
    expect(status).toBe(0);
  });
});

/**
 * A reviewer raised a hazard about three-valued answers read through two-valued
 * tests: `git merge-base --is-ancestor` exits 0 for yes, 1 for no, and 128 when
 * the object or the ref is absent, so any caller testing truthiness collapses
 * "cannot tell" into "no". Measured here, all four shapes reproduce - including
 * one the report did not name, an absent *second* argument, which also gives 128.
 *
 * The harness has the structural precondition for that bug: its `git()` helper
 * catches every failure and returns null, so 1 and 128 are one value to it. What
 * it does not have is the bug, and the reason is worth pinning rather than
 * trusting. When the instrument goes blind the positive control goes with it -
 * a known-present SHA stops classifying REACHABLE - and the run withholds the
 * verdict instead of publishing one. That covers failure modes nobody
 * enumerated, which branching on exit codes by value cannot do, because it only
 * covers the codes someone thought of.
 *
 * The pair below is the discrimination, in both directions, over identical
 * artifacts and the identical script. A repository whose HEAD is unborn is the
 * blind case: note that the shallow-clone guard does *not* fire there, so this
 * is a genuinely different way to be unable to see. A repository with a single
 * commit is the sighted case; it reaches a verdict, and that verdict is a
 * failing one, which is the point - the check is allowed to say no, and is not
 * allowed to say no when it means it could not look.
 */
describe('the harness refuses to publish a verdict it cannot support', () => {
  const made: string[] = [];

  const stage = (dir: string) => {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, '.squad', 'fact-checker'), { recursive: true });
    for (const script of [HARNESS, CORPUS_MODULE]) {
      copyFileSync(
        path.join(repositoryRoot, script),
        path.join(dir, script.replace(/\//g, path.sep)),
      );
    }
    for (const f of ['audit-trail.md', 'policy.md']) {
      copyFileSync(
        path.join(repositoryRoot, '.squad', 'fact-checker', f),
        path.join(dir, '.squad', 'fact-checker', f),
      );
    }
  };

  const newRepo = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    made.push(dir);
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    stage(dir);
    return dir;
  };

  const spawnHarness = (dir: string) => {
    const r = spawnSync('node', ['scripts/check-citation-reachability.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  const runHarness = (dir: string) => {
    const result = spawnHarness(dir);
    const { out } = result;
    assertHarnessStarted(out);
    return result;
  };

  const publishedAVerdict = (out: string) =>
    /OK - every cited|ORPHANED CITATIONS/.test(out);

  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('rejects a startup exit 1 but accepts a citation-verdict exit 1', () => {
    const starved = newRepo('startup-starved-');
    rmSync(path.join(starved, CORPUS_MODULE));

    const startupFailure = spawnHarness(starved);
    expect(startupFailure.status).toBe(1);
    expect(startupFailure.out).toMatch(
      /ERR_MODULE_NOT_FOUND|Cannot find module/,
    );
    expect(() => runHarness(starved)).toThrow(
      /the harness never loaded, so this arm tested nothing/,
    );

    const complete = seeded('startup-complete-');
    const citationVerdict = spawnHarness(complete);
    expect(citationVerdict.status).toBe(1);
    expect(citationVerdict.out).toContain(
      'control: known-present SHA classifies REACHABLE',
    );
    expect(citationVerdict.out).toContain('ORPHANED CITATIONS');
    expect(citationVerdict.out).not.toContain('CONTROL FAILED');
    expect(runHarness(complete)).toEqual(citationVerdict);
  });

  it('withholds the verdict where no reader revision resolves at all', () => {
    const { status, out } = runHarness(newRepo('blind-'));

    // 2, not 1: "I could not look" must not be reported through the same channel
    // as "these citations are broken", or the repair instruction sends someone
    // to fix citations that are fine.
    expect(status).toBe(2);
    expect(out).toContain('CONTROL FAILED');
    expect(out).toContain('verdict withheld');
    expect(publishedAVerdict(out)).toBe(false);

    // The shallow guard is a different instrument and is silent here, so this
    // case is not covered by it - the control arm is what catches this one.
    expect(out).not.toContain('INCONCLUSIVE: this is a shallow clone');
  });

  it('reaches a verdict, and states its reader model, once it can see', () => {
    const dir = newRepo('sighted-');
    execFileSync('git', [
      '-C',
      dir,
      'config',
      'user.email',
      't@example.invalid',
    ]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed'], {
      stdio: 'ignore',
    });

    const { status, out } = runHarness(dir);

    expect(status).not.toBe(2);
    expect(out).not.toContain('verdict withheld');
    expect(publishedAVerdict(out)).toBe(true);

    // A count decides nothing until its scope is stated, so the verdict carries
    // the revisions it was computed against rather than leaving them implied.
    expect(out).toMatch(/reader revisions: .+\(\d+ commits reachable\)/);
  });

  /**
   * #481. The two tests above cover a reader that cannot resolve revisions. Neither
   * covers a *corpus* that is not there, and that is a separate blind arm: the scan
   * roots are hardcoded paths, so renaming `.squad/fact-checker/audit-trail.md`
   * made the shipping harness print `OK - every cited revision is reachable` and
   * exit 0 with REACHABLE 0 / TWIN 0 / DECLARED 0 / ORPHAN 0 - while every
   * self-control still passed, because the controls certify the classifier and
   * never the corpus. An empty corpus satisfies "every cited revision is
   * reachable" vacuously, and a gate that reports clean because it examined
   * nothing is worse than no gate, because it also reports confidence.
   *
   * The obvious repair inverts the defect into a check that cannot tell "broken"
   * from "fine", so the negative control below is not decoration: a floor that
   * always refuses is exactly as useless as one that always passes, and these
   * three cases run together so the refusals are shown to discriminate.
   */
  const seeded = (prefix: string) => {
    const dir = newRepo(prefix);
    execFileSync('git', [
      '-C',
      dir,
      'config',
      'user.email',
      't@example.invalid',
    ]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed'], {
      stdio: 'ignore',
    });
    return dir;
  };

  // Both roots, because they are not symmetric and only one of them is covered
  // twice. Measured at 6a8bc7a0: audit-trail.md carries all 122 cited SHAs (436
  // occurrences) and policy.md carries 0. So losing audit-trail.md also collapses
  // the corpus and the floor would catch it as a backstop, while losing policy.md
  // changes no count at all and the preflight is the only thing that can see it.
  // Testing only the loud root would leave the guard's whole reason for existing
  // untested.
  for (const root of ['audit-trail.md', 'policy.md']) {
    it(`withholds the verdict where the scan root ${root} has moved or been removed`, () => {
      const dir = seeded(`rootless-${root.replace(/\W/g, '')}-`);
      rmSync(path.join(dir, '.squad', 'fact-checker', root));

      const { status, out } = runHarness(dir);

      expect(status).toBe(2);
      expect(out).toContain('INCONCLUSIVE');
      expect(out).toContain(root);
      expect(publishedAVerdict(out)).toBe(false);

      // Specifically not the empty tally the defect produced.
      expect(out).not.toContain('REACHABLE 0   TWIN 0   DECLARED 0   ORPHAN 0');
    });
  }

  it('withholds the verdict where the roots are readable but the corpus has collapsed', () => {
    const dir = seeded('stripped-');
    for (const f of ['audit-trail.md', 'policy.md']) {
      const at = path.join(dir, '.squad', 'fact-checker', f);
      writeFileSync(
        at,
        readFileSync(at, 'utf8').replace(/`[0-9a-f]{7,40}`/g, '`REDACTED`'),
      );
    }

    const { status, out } = runHarness(dir);

    expect(status).toBe(2);
    expect(out).toContain('INCONCLUSIVE');
    expect(out).toMatch(/only 0 cited SHAs were found, below the floor of \d+/);
    expect(publishedAVerdict(out)).toBe(false);

    // The reason this arm needs a floor at all: the classifier is provably fine
    // here. Its controls pass, and it is the corpus that is missing.
    expect(out).not.toContain('CONTROL FAILED');
    expect(out).toContain('control: known-present SHA classifies REACHABLE');
  });

  it('negative control: an intact corpus trips neither new guard, in any checkout', () => {
    // Environment-independent by construction: a temp repo staged with the real,
    // unmodified artifacts. This is the same corpus the two tests above mutate, so
    // running it untouched here is what makes those two discriminating rather than
    // merely loud. A guard that always refuses is exactly as useless as one that
    // always passes, and only the pair shows which of the two this is.
    const { status, out } = runHarness(seeded('intact-'));

    expect(out).not.toContain('a scan root is missing or unreadable');
    expect(out).not.toMatch(/below the floor of \d+/);
    expect(status).not.toBe(2);
    expect(publishedAVerdict(out)).toBe(true);

    // The corpus was actually read, and read past the floor.
    const cited = out.match(/cited SHAs: (\d+)/);
    expect(cited).not.toBeNull();
    expect(Number(cited![1])).toBeGreaterThan(90);
  });

  it('negative control: the working checkout passes outright where it can see', () => {
    // `.github/workflows/ci.yml` runs this suite behind `actions/checkout@v4` with
    // no `fetch-depth`, i.e. depth 1 - so the real repository's history is not
    // available to this test in CI, and asserting exit 0 unconditionally would fail
    // there for an environmental reason. Both branches below assert; neither skips.
    const shallow =
      execFileSync('git', [
        '-C',
        repositoryRoot,
        'rev-parse',
        '--is-shallow-repository',
      ])
        .toString()
        .trim() === 'true';

    const { status, out } = runHarness(repositoryRoot);

    // Holds either way: the corpus is intact here, so whatever stops the run, it
    // must not be one of the two guards added for #481.
    expect(out).not.toContain('a scan root is missing or unreadable');
    expect(out).not.toMatch(/below the floor of \d+/);

    if (shallow) {
      // The only thing allowed to stop an intact corpus in a narrowed checkout is
      // the pre-existing reader guard, which is a different instrument.
      expect(status).toBe(2);
      expect(out).toContain('INCONCLUSIVE: this is a shallow clone');
      return;
    }

    expect(status).toBe(0);
    expect(out).toContain('OK - every cited revision is reachable');
    expect(out).not.toContain('INCONCLUSIVE');

    // Counts must be non-zero, or this control would also pass on the empty corpus
    // the two tests above exist to reject.
    const tally = out.match(
      /REACHABLE (\d+)\s+TWIN (\d+)\s+DECLARED (\d+)\s+ORPHAN (\d+)/,
    );
    expect(tally).not.toBeNull();
    const [, reachable, twin, declared] = tally!;
    expect(Number(reachable)).toBeGreaterThan(0);
    expect(Number(twin)).toBeGreaterThan(0);
    expect(Number(declared)).toBeGreaterThan(0);
  });
});
