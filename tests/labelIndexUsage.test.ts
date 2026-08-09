import { describe, expect, it } from 'vitest';

import {
  ALLOWED_LABEL_INDEX_USAGE,
  LABEL_INDEX_PATTERNS,
  SCANNED_DIRECTORIES,
  collectProjectGhWrapperNames,
  collectScannedFiles,
  findGhWrapperNames,
  findUnresolvedGhWrapperCalls,
  flattenGhArgvInvocations,
  flattenIndirectLabelQueryConstruction,
  formatNeedsReview,
  formatViolation,
  scanLabelIndexUsage,
} from '../scripts/check-label-index-usage.mjs';

// #299: five merged pull requests, `labels: []` at the object, still returned
// by `gh pr list --label hold:sequenced --state all` more than 27 hours after
// the removal. This is the CLI shape that produced that measurement.
const GH_PR_LIST_SNIPPET =
  'gh pr list --repo owner/repo --state all --label "hold:sequenced" --json number';

const GH_ISSUE_LIST_SNIPPET =
  'gh issue list --repo owner/repo --label "hold:sequenced" --state all';

const REST_LIST_SNIPPET =
  "fetch('https://api.github.com/repos/owner/repo/issues?labels=hold%3Asequenced&state=all')";

const SEARCH_API_SNIPPET =
  "fetch(`https://api.github.com/search/issues?q=${encodeURIComponent('repo:owner/repo label:hold:sequenced')}`)";

// Hicks: `gh api ... -f/-F labels=...` hands the label filter to the same
// REST issues collection endpoint the URL-anchored pattern above already
// catches, just spelled through gh's own field-flag syntax.
const GH_API_RAW_FIELD_LABELS_SNIPPET =
  'gh api repos/owner/repo/issues -f labels=hold:sequenced -f state=all';

const GH_API_TYPED_FIELD_LABELS_SNIPPET =
  'gh api repos/owner/repo/issues -F labels=hold:sequenced';

// Vasquez: `gh pr list --help`/`gh issue list --help` document `-l` as the
// short form of `--label`, so this is the same hazard as GH_PR_LIST_SNIPPET
// under a shorter spelling, not a different command.
const GH_PR_LIST_SHORTHAND_SNIPPET =
  'gh pr list --repo owner/repo --state all -l "hold:sequenced" --json number';

const GH_ISSUE_LIST_SHORTHAND_SNIPPET =
  'gh issue list --repo owner/repo -l "hold:sequenced" --state all';

// Hicks: `--search "label:..."` hands the label filter to the search index
// through a third spelling that the `--label`/`-l` patterns and the
// URL-anchored REST/search patterns above do not cover.
const GH_PR_LIST_SEARCH_LABEL_SNIPPET =
  'gh pr list --repo owner/repo --search "label:hold:sequenced" --state all';

const GH_ISSUE_LIST_SEARCH_LABEL_SNIPPET =
  'gh issue list --repo owner/repo --search "label:hold:sequenced"';

// Ripley (round 4): `gh search issues`/`gh search prs` are a third gh
// subcommand family reading the same index directly -- `--label` is
// documented by `gh search issues --help`/`gh search prs --help`, and the
// bare `label:x` query keyword is the identical qualifier under the CLI's
// own search syntax.
const GH_SEARCH_ISSUES_LABEL_SNIPPET =
  'gh search issues --repo owner/repo --label "hold:sequenced" --state open';

const GH_SEARCH_PRS_LABEL_KEYWORD_SNIPPET =
  'gh search prs --repo owner/repo label:hold:sequenced';

// Vasquez (round 1): the same `gh pr list --label` shape, but built as an
// argv array (execFileSync-style) rather than one contiguous string -- the
// pattern this repo's own scripts actually use to call `gh`/`git` to avoid
// shell injection. A scan that only read contiguous text would miss it.
const GH_PR_LIST_ARGV_ARRAY_SNIPPET = `
execFileSync('gh', [
  'pr',
  'list',
  '--repo',
  'owner/repo',
  '--label',
  'hold:sequenced',
  '--state',
  'all',
]);
`;

// Vasquez (round 2): naming the array before passing it -- a one-step
// refactor of the shape above -- must not evade detection. This is the
// argument-injection-shaped bypass the reviewer demonstrated: shape 1 alone
// only reconstructed the array literal written directly at the call site.
const GH_PR_LIST_ARGV_VARIABLE_SNIPPET = `
const ghArgs = [
  'pr',
  'list',
  '--repo',
  'owner/repo',
  '--label',
  'hold:sequenced',
];
execFileSync('gh', ghArgs);
`;

const GH_ISSUE_LIST_ARGV_VARIABLE_SNIPPET = `
const args = ['issue', 'list', '--repo', 'owner/repo', '-l', 'hold:sequenced'];
execFileSync('gh', args, { encoding: 'utf8' });
`;

// Vasquez (round 3): a binding declared safely and then REASSIGNED to a
// banned form before the call must resolve to the reassignment that
// actually reaches execFileSync, not the original safe declaration -- the
// bypass was "most recent in the whole file" (which finds the first/only
// match under a non-global regex) instead of "most recent before the call".
const GH_PR_LIST_ARGV_REASSIGNED_SNIPPET = `
let ghArgs = ['pr', 'list', '--repo', 'owner/repo'];
ghArgs = ['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced'];
execFileSync('gh', ghArgs);
`;

// Negative control: a safe declaration alone (no unsafe reassignment before
// the call) must NOT be flagged -- only the reassignment shape is a hazard.
const GH_PR_LIST_ARGV_SAFE_ONLY_SNIPPET = `
let ghArgs = ['pr', 'list', '--repo', 'owner/repo', '--state', 'all'];
execFileSync('gh', ghArgs);
`;

// Ripley (round 4): a local wrapper function that itself shells out to `gh`
// -- named ARBITRARILY, not just the conventional `gh`/`invokeGh` -- must
// not let a call through it evade detection just because the literal `'gh'`
// string only appears inside the wrapper's own definition.
const GH_WRAPPER_ARROW_BLOCK_BODY_SNIPPET = `
const gh = (args) => {
  return execFileSync('gh', args, { encoding: 'utf8' });
};
gh(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

const GH_WRAPPER_ARROW_EXPRESSION_BODY_SNIPPET = `
const invokeGh = (args) => execFileSync('gh', args);
const wrapperArgs = ['issue', 'list', '--repo', 'owner/repo', '-l', 'hold:sequenced'];
invokeGh(wrapperArgs);
`;

const GH_WRAPPER_FUNCTION_DECLARATION_SNIPPET = `
function runGh(args) {
  return execFileSync('gh', args);
}
runGh(['pr', 'list', '--search', '"label:hold:sequenced"']);
`;

// Negative control: a function that merely happens to be named like a
// plausible wrapper, but whose body does NOT shell out to the real `gh`
// binary, must not be treated as one -- detection is by behavior, not name.
const NON_WRAPPER_SAME_NAME_SNIPPET = `
function gh(message) {
  console.log('not a wrapper: ' + message);
}
gh(['pr', 'list', '--label', 'hold:sequenced']);
`;

// Ripley (round 5): a real repo-style wrapper's argv is not always its
// FIRST parameter -- `runGh(run, args, env)` takes it second. The lint
// must resolve an array-literal/array-variable argument found ANYWHERE in
// a wrapper call's argument list, not assume position 0.
const GH_WRAPPER_ARGV_SECOND_PARAMETER_SNIPPET = `
function runGh(run, args, env) {
  return run('gh', args, env);
}
runGh(execFileSync, ['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced'], { encoding: 'utf8' });
`;

// Same hazard as above, but the argv argument in the second position is a
// variable, not a literal -- both the position-agnostic scan AND the
// existing variable-resolution logic must compose correctly.
const GH_WRAPPER_ARGV_SECOND_PARAMETER_VARIABLE_SNIPPET = `
function runGh(run, args, env) {
  return run('gh', args, env);
}
const wrapperArgs = ['issue', 'list', '--repo', 'owner/repo', '-l', 'hold:sequenced'];
runGh(execFileSync, wrapperArgs, { encoding: 'utf8' });
`;

// Vasquez/Ripley (round 6): a NESTED wrapper -- one that calls another
// wrapper rather than shelling out to `gh` directly in its own body --
// must still be resolved, at whatever depth, via fixed-point iteration.
const GH_NESTED_WRAPPER_SNIPPET = `
const invokeGh = (args) => execFileSync('gh', args);
const runGh = (args) => invokeGh(args);
runGh(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Vasquez (round 6): a wrapper defined in ONE scanned file and imported
// (optionally under an alias) into ANOTHER must still be resolved -- the
// importing file's own text never contains the wrapper's defining body.
const GH_WRAPPER_DEFINITION_MODULE_SNIPPET = `
export const invokeGh = (args) => execFileSync('gh', args);
`;
const GH_WRAPPER_IMPORT_CONSUMER_SNIPPET = `
import { invokeGh as runGh } from './gh-utils.mjs';
runGh(['issue', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Ripley (round 8): the original wrapper-body test, `/['"]gh['"]\s*,/`,
// matched that literal text ANYWHERE in a function's body -- a plain
// string, not an actual call -- and flagged an unrelated function as a
// wrapper. Neither snippet below shells out to `gh` at all.
const GH_STRING_LITERAL_FALSE_POSITIVE_SNIPPET = `
function notAWrapper(x) {
  const message = "success: 'gh', done";
  return message + x;
}
notAWrapper(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

const GH_COMMENT_FALSE_POSITIVE_SNIPPET = `
function notAWrapper2(x) {
  // calls 'gh', badly -- this comment must not count as a real call
  return x + 1;
}
notAWrapper2(['issue', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Vasquez (round 8): a wrapper written as a CLASS METHOD, called via
// property access (`runner.invokeGh([...])`), was invisible to the
// function/arrow/const-only definition-header pattern.
const GH_CLASS_METHOD_WRAPPER_SNIPPET = `
class Runner {
  invokeGh(args) {
    return execFileSync('gh', args);
  }
}
const runner = new Runner();
runner.invokeGh(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Vasquez (round 8): a plain REFERENCE ALIAS -- `const myGh = invokeGh;`,
// no call, no parens -- to an already-known wrapper, later called under
// the alias, must resolve too.
const GH_ALIASED_WRAPPER_SNIPPET = `
const invokeGh = (args) => execFileSync('gh', args);
const myGh = invokeGh;
myGh(['issue', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Vasquez/Ripley (round 9): a wrapper re-exported through an intermediate
// "barrel" file -- `export { invokeGh } from './gh-utils.mjs';` in an
// index module, then imported from THAT index rather than the original
// module -- must still resolve, chained through any number of hops.
const GH_WRAPPER_BARREL_INDEX_SNIPPET = `
export { invokeGh } from './gh-utils.mjs';
`;
const GH_WRAPPER_BARREL_CONSUMER_SNIPPET = `
import { invokeGh } from './index.mjs';
invokeGh(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Ripley (round 9): a wrapper exposed only as a module's DEFAULT export --
// `export default (args) => execFileSync('gh', args);` -- imported with
// `import invokeGh from './gh-utils.mjs'` (no braces) -- must resolve too,
// even though the defining module never gives the wrapper a name of its
// own.
const GH_WRAPPER_DEFAULT_EXPORT_MODULE_SNIPPET = `
export default (args) => execFileSync('gh', args);
`;
const GH_WRAPPER_DEFAULT_IMPORT_CONSUMER_SNIPPET = `
import invokeGh from './gh-utils.mjs';
invokeGh(['issue', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Ripley (round 9): a wrapper whose SOLE parameter is a rest parameter --
// its argv is reconstructed by the language from however many individual
// positional arguments the call actually used, never passed as one
// array-typed argument the ordinary per-argument scan looks for.
const GH_WRAPPER_REST_PARAM_SNIPPET = `
function runGh(...args) {
  return execFileSync('gh', args);
}
runGh('issue', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced');
`;

// Vasquez (round 9): a REAL wrapper (bare function `runGh`) coexisting, in
// the SAME file, with an UNRELATED object method that happens to share the
// bare identifier `runGh` -- the unrelated method must NOT be conflated
// with the real wrapper just because the call-site scan matches on name
// alone.
const GH_WRAPPER_NAME_COLLISION_SNIPPET = `
function runGh(args) {
  return execFileSync('gh', args);
}
runGh(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);

const client = {
  runGh(tag, list) {
    return safeLog(tag, list);
  }
};
client.runGh('safe', ['issue', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Vasquez (round 10): a wrapper re-exported through a barrel file with an
// ALIAS (`export { invokeGh as runGh } from './gh-utils.mjs';`), then
// imported (under that alias) from the barrel -- must resolve the same
// way a non-aliased re-export does.
const GH_WRAPPER_BARREL_ALIASED_INDEX_SNIPPET = `
export { invokeGh as runGh } from './gh-utils.mjs';
`;
const GH_WRAPPER_BARREL_ALIASED_CONSUMER_SNIPPET = `
import { runGh } from './index.mjs';
runGh(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Vasquez (round 10): a string literal containing \`//\` (e.g. a URL) on the
// SAME LINE, BEFORE the wrapper's real gh call -- a naive line-comment
// strip would mistake the \`//\` inside the string for a comment start and
// discard the rest of the line, including the real call.
const GH_WRAPPER_URL_STRING_SAME_LINE_SNIPPET = `
function invokeGh(args) { console.log('https://example.com'); return execFileSync('gh', args); }
invokeGh(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Vasquez (round 10): a FACTORY function that itself does not directly
// call \`gh\`'s own name at the call site -- it RETURNS a closure that
// does -- and the returned value, not the factory, is what is later
// called under a new name.
const GH_FACTORY_RETURNED_WRAPPER_SNIPPET = `
function makeGhRunner() {
  return (args) => execFileSync('gh', args);
}
const runGh = makeGhRunner();
runGh(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Hicks (round 10): the label qualifier is assembled into a variable
// FIRST, and only later interpolated into a SEPARATE outbound fetch call
// -- neither the \`label:\` text nor the request URL ever appear together
// in one matched span.
const INDIRECT_LABEL_QUERY_SNIPPET = `
const label = 'hold:sequenced';
const query = \`repo:owner/repo label:\${label}\`;
fetch(\`https://api.github.com/search/issues?q=\${encodeURIComponent(query)}\`);
`;

// Negative control: an unrelated fetch call and an unrelated \`label:\`-
// containing string in the SAME file, with no actual link between them --
// must NOT be flagged, since the fetch's own argument text never
// references the label-holding variable NOR a GitHub host.
const INDIRECT_LABEL_QUERY_NEGATIVE_CONTROL_SNIPPET = `
const greeting = 'hello label: not a github query';
fetch('https://example.com/unrelated');
`;

// The safe instrument: a per-object read. Must never be flagged, or every
// script that reads labels correctly (check-sequencing-hold.mjs,
// lift-hold-on-close.mjs's fetchPullRequest) would fail this check.
const OBJECT_READ_SNIPPET =
  'fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`)';

// Vasquez (round 11): a comment merely QUOTING the direct-call shape --
// documenting the pattern, not executing it -- must never itself be
// flattened into a violation. `flattenGhArgvInvocations`'s own call-site
// scans previously read raw (non-comment-stripped) text, so this comment
// alone produced a false positive.
const GH_COMMENT_ONLY_DIRECT_CALL_SNIPPET = `
// example of the banned shape: execFileSync('gh', ['pr', 'list', '--label', 'hold:sequenced']);
console.log('nothing real happens here');
`;

// Vasquez (round 11): a method-shorthand wrapper called through BRACKET
// (computed-property) access -- \`helpers['invokeGh']([...])\` -- is exactly
// as legitimate a call site as dot access (\`helpers.invokeGh([...])\`), but
// the method-mode call-site pattern previously required a literal \`.\`.
const GH_WRAPPER_BRACKET_CALL_SNIPPET = `
const helpers = {
  invokeGh(args) { return execFileSync('gh', args); }
};
helpers['invokeGh'](['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Ripley (round 11): a REGEX LITERAL with escaped slashes (\`\\/\\/\`, e.g.
// matching a URL scheme) is not a quoted string, so round 10's
// quote-tracking comment-stripper does not protect it -- the escaped
// slash's second character was read as an ordinary character and then
// paired with the regex's own closing \`/\` delimiter to look like a \`//\`
// comment start, discarding the rest of the line (the real gh call)
// as a false NEGATIVE.
const GH_WRAPPER_REGEX_LITERAL_SAME_LINE_SNIPPET = String.raw`
function invokeGh(args) { const isHttps = /^https:\/\//.test('x'); return execFileSync('gh', args); }
invokeGh(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Ripley + Vasquez (round 12): a rest-param wrapper call whose argv
// contains a DYNAMIC/computed value cannot be statically resolved --
// previously this caused the whole call site to be silently discarded,
// with no signal at all that it was even considered.
const GH_REST_PARAM_UNRESOLVABLE_ARGV_SNIPPET = `
function runGh(...args) { return execFileSync('gh', args); }
const dynamicLabel = computeLabelSomehow();
runGh('pr', 'list', '--label', dynamicLabel);
`;

// Negative control: the same rest-param wrapper shape, but every argument
// IS statically resolvable -- must still be flagged as an ordinary
// violation (not `needsReview`), exactly as before this round's change.
const GH_REST_PARAM_RESOLVABLE_ARGV_VIOLATION_SNIPPET = `
function runGh(...args) { return execFileSync('gh', args); }
runGh('pr', 'list', '--label', 'hold:sequenced');
`;

// Negative control: a fully resolvable, SAFE rest-param call (no banned
// pattern at all) -- must produce neither a violation nor a needsReview
// entry.
const GH_REST_PARAM_RESOLVABLE_ARGV_SAFE_SNIPPET = `
function runGh(...args) { return execFileSync('gh', args); }
runGh('repos', 'owner/repo', 'pulls', '5', 'labels');
`;

// Vasquez (round 12): the comma-operator indirect-call idiom -- `(0,
// runGh)([...])`, used to strip a call's \`this\` binding -- evaded both
// the \`'bare'\`-mode (identifier not immediately followed by \`(\`) and
// \`'method'\`-mode (no preceding \`.\`) call-site patterns.
const GH_WRAPPER_COMMA_OPERATOR_CALL_SNIPPET = `
function runGh(args) { return execFileSync('gh', args); }
(0, runGh)(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Negative control: the comma-operator idiom applied to an UNRELATED
// function that never shells out to \`gh\` -- must not be flagged.
const NON_WRAPPER_COMMA_OPERATOR_CALL_SNIPPET = `
function safeHelper(args) { return args.join(' '); }
(0, safeHelper)(['not', 'a', 'gh', 'call', '--label']);
`;

// Vasquez (round 12): a destructured, RENAMED method-wrapper binding --
// \`const { runGh: rg } = someObj;\` -- where \`runGh\` is an object
// method-shorthand wrapper -- produces a new bare-callable local name
// (\`rg\`) that neither the plain-alias pass (no braces) nor the nested-call
// pass (looks for a call, not a binding) recognized.
const GH_WRAPPER_DESTRUCTURED_RENAME_SNIPPET = `
const someObj = { runGh(args) { return execFileSync('gh', args); } };
const { runGh: rg } = someObj;
rg(['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Negative control: destructuring-with-rename applied to an UNRELATED
// method that never shells out to \`gh\` -- must not be flagged.
const NON_WRAPPER_DESTRUCTURED_RENAME_SNIPPET = `
const someObj = { safeThing(args) { return args.join(' '); } };
const { safeThing: st } = someObj;
st(['not', 'a', 'gh', 'call', '--label']);
`;

// Ralph session 22644699 (round 13), Hicks: a direct \`gh\` call's array-
// literal argv can mix quoted string elements with ONE bare-identifier
// element whose VALUE is built from a separately-declared string/template
// variable -- the array literal itself is never variable-valued as a
// WHOLE (so the existing whole-array resolution never applies), but its
// one non-literal element is exactly the shape that carries the
// interesting \`label:\` text.
const GH_ARRAY_ELEMENT_LABEL_VARIABLE_SNIPPET = `
const label = 'hold:sequenced';
const query = \`label:\${label}\`;
execFileSync('gh', ['search', 'issues', query]);
`;

// Negative control: the same mixed-array shape, but the bare-identifier
// element resolves to a variable that does NOT contain \`label:\` text --
// must not be flagged.
const GH_ARRAY_ELEMENT_UNRELATED_VARIABLE_SNIPPET = `
const unrelated = 'not-a-label-thing';
execFileSync('gh', ['search', 'issues', unrelated]);
`;

// Negative control: the bare-identifier array element has NO preceding
// assignment at all (unresolvable) -- must not be flagged (no value to
// synthesize, and this file's existing conservative-omission convention
// applies rather than guessing).
const GH_ARRAY_ELEMENT_UNDECLARED_VARIABLE_SNIPPET = `
execFileSync('gh', ['search', 'issues', undeclaredQuery]);
`;

// Vasquez (round 9/15): a method-shorthand wrapper called through a
// VARIABLE-KEY bracket access -- \`const key = 'invokeGh'; obj[key]([...])\`
// -- where the literal-quoted-key form (\`obj['invokeGh']([...])\`,
// see \`GH_WRAPPER_BRACKET_CALL_SNIPPET\` above) was already handled, but
// the key here is a plain identifier resolved from a separate assignment.
const GH_WRAPPER_VARIABLE_KEY_BRACKET_CALL_SNIPPET = `
const obj = { invokeGh(args) { return execFileSync('gh', args); } };
const key = 'invokeGh';
obj[key](['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced']);
`;

// Negative control: the same variable-key bracket-access shape, but the
// resolved key names an UNRELATED method that never shells out to \`gh\` --
// must not be flagged.
const NON_WRAPPER_VARIABLE_KEY_BRACKET_CALL_SNIPPET = `
const obj = { safeThing(args) { return args.join(' '); } };
const key = 'safeThing';
obj[key](['not', 'a', 'gh', 'call', '--label']);
`;

// Ralph session ae252904 (round 16): a wrapper call's argv can be spread
// from a separately-declared array variable -- const parts = [...];
// runGh([...parts]); -- the same single-hop indirection already handled
// for a bare-identifier array-literal ELEMENT, applied here via the
// spread operator instead of a plain reference.
const GH_WRAPPER_ARGV_ARRAY_SPREAD_SNIPPET = `
function runGh(args) { return execFileSync('gh', args); }
const parts = ['pr', 'list', '--repo', 'owner/repo', '--label', 'hold:sequenced'];
runGh([...parts]);
`;

// Negative control: the same spread shape, but the spread array variable
// resolves to a SAFE argv (no banned pattern at all) -- must not be
// flagged.
const GH_WRAPPER_ARGV_ARRAY_SPREAD_SAFE_SNIPPET = `
function runGh(args) { return execFileSync('gh', args); }
const parts = ['repos', 'owner/repo', 'pulls', '5', 'labels'];
runGh([...parts]);
`;

describe('scanLabelIndexUsage', () => {
  it('flags gh pr list --label as an unlisted violation', () => {
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: GH_PR_LIST_SNIPPET }],
    });
    expect(allowlisted).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.path).toBe('scripts/example.mjs');
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  it('flags gh issue list --label as an unlisted violation', () => {
    const { violations } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: GH_ISSUE_LIST_SNIPPET }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh issue list --label');
  });

  it('flags the REST issues collection filtered by labels=', () => {
    const { violations } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: REST_LIST_SNIPPET }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain(
      'REST issues collection filtered by label',
    );
  });

  it('flags the search API label: qualifier', () => {
    const { violations } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: SEARCH_API_SNIPPET }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('search API label: qualifier');
  });

  // Vasquez: the -l shorthand must be caught, not just --label.
  it('flags gh pr list -l (the --label shorthand)', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_PR_LIST_SHORTHAND_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  it('flags gh issue list -l (the --label shorthand)', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_ISSUE_LIST_SHORTHAND_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh issue list --label');
  });

  // Hicks: --search "label:..." is a third spelling of the same bypass.
  it('flags gh pr list --search "label:..."', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_PR_LIST_SEARCH_LABEL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain(
      'gh pr/issue list --search label:',
    );
  });

  it('flags gh issue list --search "label:..."', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_ISSUE_LIST_SEARCH_LABEL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain(
      'gh pr/issue list --search label:',
    );
  });

  // Ripley (round 4): gh search issues/prs is a third gh subcommand family
  // reading the same index, distinct from `pr list`/`issue list`.
  it('flags gh search issues --label', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_SEARCH_ISSUES_LABEL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh search issues/prs --label');
  });

  it('flags gh search prs label:... (the bare query keyword)', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_SEARCH_PRS_LABEL_KEYWORD_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh search issues/prs --label');
  });

  // Hicks (round 5): `gh api ... -f/-F labels=...` reaches the same REST
  // issues-collection filter, spelled through gh's field-flag syntax.
  it('flags gh api ... -f labels=... (the raw-field form)', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_API_RAW_FIELD_LABELS_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh api ... -f/-F labels=');
  });

  it('flags gh api ... -F labels=... (the typed-field form)', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_API_TYPED_FIELD_LABELS_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh api ... -f/-F labels=');
  });

  // Vasquez: an argv-array invocation of the identical banned shape must be
  // caught, not just the contiguous-string spelling.
  it('flags gh pr list --label built as an execFileSync argv array', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_PR_LIST_ARGV_ARRAY_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Vasquez (round 2): the one-step evasion of the direct-array-literal
  // shape above -- name the array, then pass the identifier. Must be caught
  // exactly like the direct-literal shape, or the "fix" for round 1 would
  // be defeated by the most obvious refactor of the code it was meant to
  // catch.
  it('flags gh pr list --label built via a named argv variable (the direct-literal bypass)', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_PR_LIST_ARGV_VARIABLE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  it('flags gh issue list -l built via a named argv variable, with an options object after it', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_ISSUE_LIST_ARGV_VARIABLE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh issue list --label');
  });

  // Negative control for the variable-indirection path: an argv variable
  // that holds a SAFE per-object gh call must not be flagged.
  it('does not flag a named argv variable holding a safe per-object gh call', () => {
    const safeVariableSnippet = `
const args = ['api', 'repos/owner/repo/issues/175/labels'];
execFileSync('gh', args);
`;
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: safeVariableSnippet }],
    });
    expect(violations).toEqual([]);
    expect(allowlisted).toEqual([]);
  });

  // Negative control for the argv-array flatten path itself: an execFileSync
  // argv array for a SAFE per-object gh call must not be flagged, or the
  // flatten step would be as useless as a scanner that matched every
  // execFileSync call regardless of arguments.
  it('does not flag an execFileSync argv array for a safe per-object gh call', () => {
    const safeArgvSnippet = `
execFileSync('gh', [
  'api',
  'repos/owner/repo/issues/175/labels',
]);
`;
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: safeArgvSnippet }],
    });
    expect(violations).toEqual([]);
    expect(allowlisted).toEqual([]);
  });

  // Negative control: the safe per-object read must never be flagged. Without
  // this, a scanner that matched every fetch() call would pass every positive
  // test above while being useless -- the same reasoning
  // forbiddenJobLiteral.test.ts applies to its absent-string control.
  it('does not flag a per-object label read', () => {
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: OBJECT_READ_SNIPPET }],
    });
    expect(violations).toEqual([]);
    expect(allowlisted).toEqual([]);
  });

  it('does not flag a file with no matching content at all', () => {
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: 'console.log("hi");' }],
    });
    expect(violations).toEqual([]);
    expect(allowlisted).toEqual([]);
  });

  it('permits a matched file present in the allowlist with a real reason', () => {
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: SEARCH_API_SNIPPET }],
      allowlist: {
        'scripts/example.mjs': {
          patterns: ['search API label: qualifier'],
          reason: 'a written reason',
        },
      },
    });
    expect(violations).toEqual([]);
    expect(allowlisted).toHaveLength(1);
    expect(allowlisted[0]!.reason).toBe('a written reason');
  });

  // An allowlist entry must carry a reason, or it is indistinguishable from
  // silently deleting the check for that file -- the same requirement
  // check-script-reachability.mjs states for UNINVOKED_SCRIPTS.
  it.each(['', '   '])(
    'rejects an allowlist entry with an empty reason (%j)',
    (emptyReason) => {
      const { violations, allowlisted } = scanLabelIndexUsage({
        files: [{ path: 'scripts/example.mjs', contents: SEARCH_API_SNIPPET }],
        allowlist: {
          'scripts/example.mjs': {
            patterns: ['search API label: qualifier'],
            reason: emptyReason,
          },
        },
      });
      expect(allowlisted).toEqual([]);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.reason).toContain('not a justification');
    },
  );

  // Vasquez: a blanket per-file allow would let a NEW, unreviewed shape ride
  // in on a different shape's justification, silently, because the file
  // already "has an entry". Pattern-scoping must catch that.
  it('rejects an allowlist entry with no `patterns` list as excusing the whole file', () => {
    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: SEARCH_API_SNIPPET }],
      allowlist: {
        'scripts/example.mjs': { reason: 'a reason with no patterns list' },
      },
    });
    expect(allowlisted).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain('patterns');
  });

  it('still flags a NEW pattern added to an already-allowlisted file', () => {
    const contentsWithTwoShapes = [SEARCH_API_SNIPPET, GH_PR_LIST_SNIPPET].join(
      '\n',
    );

    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: contentsWithTwoShapes }],
      allowlist: {
        // Only excuses the search-API shape -- the gh pr list --label shape
        // added later must still be reported, even though this file already
        // has an allowlist entry.
        'scripts/example.mjs': {
          patterns: ['search API label: qualifier'],
          reason: 'the search-API shape re-reads before acting',
        },
      },
    });

    expect(allowlisted).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toEqual(['gh pr list --label']);
    expect(violations[0]!.reason).toContain('DIFFERENT pattern');
  });

  it('allows only the covered patterns when a file matches both an allowlisted and a new shape', () => {
    const contentsWithTwoShapes = [
      SEARCH_API_SNIPPET,
      GH_ISSUE_LIST_SNIPPET,
    ].join('\n');

    const { violations, allowlisted } = scanLabelIndexUsage({
      files: [{ path: 'scripts/example.mjs', contents: contentsWithTwoShapes }],
      allowlist: {
        'scripts/example.mjs': {
          patterns: ['search API label: qualifier', 'gh issue list --label'],
          reason: 'both shapes reviewed and re-read before acting',
        },
      },
    });

    expect(violations).toEqual([]);
    expect(allowlisted).toHaveLength(1);
    expect(allowlisted[0]!.matches.sort()).toEqual(
      ['gh issue list --label', 'search API label: qualifier'].sort(),
    );
  });

  it('scans every file independently, reporting each matched file once', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        { path: 'scripts/a.mjs', contents: GH_PR_LIST_SNIPPET },
        { path: 'scripts/b.mjs', contents: 'nothing interesting here' },
        { path: 'scripts/c.mjs', contents: GH_ISSUE_LIST_SNIPPET },
      ],
    });
    expect(violations.map((v) => v.path).sort()).toEqual([
      'scripts/a.mjs',
      'scripts/c.mjs',
    ]);
  });

  // Ripley (round 5): end-to-end, through the real scanLabelIndexUsage
  // entrypoint (not just the flattenGhArgvInvocations helper), a wrapper
  // whose argv is not its first parameter must still produce a violation.
  it('flags a call through a wrapper whose argv is its second parameter', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_ARGV_SECOND_PARAMETER_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Vasquez/Ripley (round 6): end-to-end, a NESTED wrapper (one that calls
  // another wrapper rather than gh directly) must be flagged through the
  // real scanning entrypoint, which is what wires flattenGhArgvInvocations
  // up to collectProjectGhWrapperNames.
  it('flags a call through a nested wrapper (a wrapper that calls another wrapper)', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        { path: 'scripts/example.mjs', contents: GH_NESTED_WRAPPER_SNIPPET },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Vasquez (round 6): end-to-end, a wrapper imported (under an alias) from
  // ANOTHER scanned file must be flagged in the IMPORTING file, through the
  // real scanning entrypoint across the whole file set.
  it('flags a call through a wrapper imported from another scanned file', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/gh-utils.mjs',
          contents: GH_WRAPPER_DEFINITION_MODULE_SNIPPET,
        },
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_IMPORT_CONSUMER_SNIPPET,
        },
      ],
    });
    const consumerViolation = violations.find(
      (violation) => violation.path === 'scripts/example.mjs',
    );
    expect(consumerViolation).toBeDefined();
    expect(consumerViolation!.matches).toContain('gh issue list --label');
  });

  // Vasquez (round 8): end-to-end, a wrapper written as a CLASS METHOD
  // (called via property access, `runner.invokeGh([...])`) must be flagged
  // through the real scanning entrypoint.
  it('flags a call through a class-method wrapper', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_CLASS_METHOD_WRAPPER_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Vasquez (round 8): end-to-end, a bare reference alias of an
  // already-known wrapper (`const myGh = invokeGh;`, no call) must be
  // flagged through the real scanning entrypoint when called under the
  // alias.
  it('flags a call through an aliased wrapper reference', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_ALIASED_WRAPPER_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh issue list --label');
  });

  // Ripley (round 8): end-to-end negative controls -- a function whose body
  // merely contains the literal text `'gh',` inside a string or a comment
  // must NOT produce a violation, since it is not an actual wrapper.
  it('does not flag a call through a function whose body only contains the gh-call shape inside a string literal', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_STRING_LITERAL_FALSE_POSITIVE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(0);
  });

  it('does not flag a call through a function whose body only contains the gh-call shape inside a comment', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_COMMENT_FALSE_POSITIVE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(0);
  });

  // Vasquez/Ripley (round 9): end-to-end, a wrapper re-exported through an
  // intermediate barrel file must be flagged in the file that imports it
  // from the barrel, through the real scanning entrypoint.
  it('flags a call through a wrapper re-exported through a barrel file', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/gh-utils.mjs',
          contents: GH_WRAPPER_DEFINITION_MODULE_SNIPPET,
        },
        {
          path: 'scripts/index.mjs',
          contents: GH_WRAPPER_BARREL_INDEX_SNIPPET,
        },
        {
          path: 'scripts/consumer.mjs',
          contents: GH_WRAPPER_BARREL_CONSUMER_SNIPPET,
        },
      ],
    });
    const consumerViolation = violations.find(
      (violation) => violation.path === 'scripts/consumer.mjs',
    );
    expect(consumerViolation).toBeDefined();
    expect(consumerViolation!.matches).toContain('gh pr list --label');
  });

  // Ripley (round 9): end-to-end, a wrapper exposed only as a module's
  // default export, imported with `import NAME from './path'` (no
  // braces), must be flagged in the importing file.
  it('flags a call through a default-exported wrapper imported without braces', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/gh-utils.mjs',
          contents: GH_WRAPPER_DEFAULT_EXPORT_MODULE_SNIPPET,
        },
        {
          path: 'scripts/consumer2.mjs',
          contents: GH_WRAPPER_DEFAULT_IMPORT_CONSUMER_SNIPPET,
        },
      ],
    });
    const consumerViolation = violations.find(
      (violation) => violation.path === 'scripts/consumer2.mjs',
    );
    expect(consumerViolation).toBeDefined();
    expect(consumerViolation!.matches).toContain('gh issue list --label');
  });

  // Ripley (round 9): end-to-end, a rest-param wrapper's argv, spread
  // across the wrapper call's entire argument list, must be flagged.
  it('flags a call through a rest-param wrapper', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_REST_PARAM_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh issue list --label');
  });

  // Vasquez (round 9): end-to-end negative control -- an unrelated method
  // call sharing a bare wrapper's name must produce exactly one
  // violation (the real bare-wrapper call), not two.
  it('does not conflate an unrelated method call with a same-named bare wrapper', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_NAME_COLLISION_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toEqual(['gh pr list --label']);
  });

  // Vasquez (round 10): end-to-end, a wrapper re-exported through a
  // barrel file UNDER AN ALIAS must be flagged in the importing file.
  it('flags a call through a wrapper re-exported through a barrel file under an alias', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/gh-utils.mjs',
          contents: GH_WRAPPER_DEFINITION_MODULE_SNIPPET,
        },
        {
          path: 'scripts/index.mjs',
          contents: GH_WRAPPER_BARREL_ALIASED_INDEX_SNIPPET,
        },
        {
          path: 'scripts/consumer.mjs',
          contents: GH_WRAPPER_BARREL_ALIASED_CONSUMER_SNIPPET,
        },
      ],
    });
    const consumerViolation = violations.find(
      (violation) => violation.path === 'scripts/consumer.mjs',
    );
    expect(consumerViolation).toBeDefined();
    expect(consumerViolation!.matches).toContain('gh pr list --label');
  });

  // Vasquez (round 10): end-to-end, a wrapper must still be recognized
  // when a string literal containing `//` (e.g. a URL) appears earlier on
  // the same line as the real gh call, so the fix must not regress into a
  // false NEGATIVE via an overly naive comment strip.
  it('flags a call through a wrapper even when a same-line string literal contains //', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_URL_STRING_SAME_LINE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Vasquez (round 10): end-to-end, a factory-returned wrapper
  // (`const runGh = makeGhRunner();`) must be flagged through the real
  // scanning entrypoint.
  it('flags a call through a factory-returned wrapper', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_FACTORY_RETURNED_WRAPPER_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Hicks (round 10): end-to-end, a label qualifier assembled into a
  // variable first and only later interpolated into a separate GitHub
  // fetch call must be flagged.
  it('flags an indirect two-step label-index query construction', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: INDIRECT_LABEL_QUERY_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('search API label: qualifier');
  });

  // Negative control: an unrelated fetch call and an unrelated
  // `label:`-containing string, with no actual link between them, must
  // not be flagged.
  it('does not flag an unrelated fetch call alongside an unrelated label:-containing string', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: INDIRECT_LABEL_QUERY_NEGATIVE_CONTROL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(0);
  });

  // Vasquez (round 11): end-to-end, a comment merely quoting the
  // direct-call shape must not itself be flagged.
  it('does not flag a comment that merely quotes the direct-call shape', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_COMMENT_ONLY_DIRECT_CALL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(0);
  });

  // Vasquez (round 11): end-to-end, a method-shorthand wrapper called
  // through bracket (computed-property) access must be flagged the same
  // as a dot-accessed call.
  it('flags a call through a method wrapper invoked via bracket access', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_BRACKET_CALL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Ripley (round 11): end-to-end, a wrapper must still be flagged when a
  // same-line regex literal with escaped slashes appears before the real
  // gh call.
  it('flags a call through a wrapper even when a same-line regex literal contains escaped slashes', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_REGEX_LITERAL_SAME_LINE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Ripley + Vasquez (round 12): a rest-param wrapper call whose argv
  // cannot be statically resolved must surface as a distinct `needsReview`
  // finding, never as a silent pass -- previously it was indistinguishable
  // from a call the check had verified as safe.
  it('reports an unresolvable rest-param wrapper call as needsReview, not a silent pass', () => {
    const result = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_REST_PARAM_UNRESOLVABLE_ARGV_SNIPPET,
        },
      ],
    });
    expect(result.violations).toHaveLength(0);
    expect(result.needsReview).toHaveLength(1);
    expect(result.needsReview[0]).toMatchObject({
      path: 'scripts/example.mjs',
      name: 'runGh',
    });
    expect(result.needsReview[0]!.snippet).toContain('dynamicLabel');
  });

  // Negative control: a resolvable rest-param call that DOES match a
  // banned pattern must still be reported as an ordinary violation, not
  // needsReview -- the new category must not swallow a real violation.
  it('still flags a resolvable rest-param wrapper call as an ordinary violation', () => {
    const result = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_REST_PARAM_RESOLVABLE_ARGV_VIOLATION_SNIPPET,
        },
      ],
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.matches).toContain('gh pr list --label');
    expect(result.needsReview).toHaveLength(0);
  });

  // Negative control: a fully resolvable, SAFE rest-param call must
  // produce neither a violation nor a needsReview entry.
  it('does not flag a fully resolvable, safe rest-param wrapper call', () => {
    const result = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_REST_PARAM_RESOLVABLE_ARGV_SAFE_SNIPPET,
        },
      ],
    });
    expect(result.violations).toHaveLength(0);
    expect(result.needsReview).toHaveLength(0);
  });

  // Vasquez (round 12): end-to-end, the comma-operator indirect-call idiom
  // must be traced back to a known wrapper the same as a direct call.
  it('flags a call through the comma-operator indirect-call idiom', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_COMMA_OPERATOR_CALL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Negative control: the comma-operator idiom applied to a function that
  // never shells out to `gh` must not be flagged.
  it('does not flag a comma-operator call to an unrelated function', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: NON_WRAPPER_COMMA_OPERATOR_CALL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(0);
  });

  // Vasquez (round 12): end-to-end, a destructured-and-RENAMED reference
  // to a method-shorthand wrapper must be traced back to it.
  it('flags a call through a destructured, renamed method-wrapper binding', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_DESTRUCTURED_RENAME_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Negative control: destructuring-with-rename applied to an unrelated
  // method that never shells out to `gh` must not be flagged.
  it('does not flag a destructured, renamed binding to an unrelated method', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: NON_WRAPPER_DESTRUCTURED_RENAME_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(0);
  });

  // Ralph session 22644699 (round 13), Hicks: a direct `gh` array-literal
  // argv mixing quoted elements with a bare-identifier element that
  // resolves to a preceding `label:`-bearing string/template variable
  // must be flagged -- the array literal is fully static in SHAPE, but
  // one of its elements carries the interesting text indirectly.
  it('flags a gh array-literal argv element that resolves to a label-bearing variable', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_ARRAY_ELEMENT_LABEL_VARIABLE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh search issues/prs --label');
  });

  // Negative control: the same mixed-array shape, but the resolved
  // variable's value does not contain `label:` text -- must not be
  // flagged.
  it('does not flag a gh array-literal argv element resolving to an unrelated variable', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_ARRAY_ELEMENT_UNRELATED_VARIABLE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(0);
  });

  // Negative control: the bare-identifier array element has no preceding
  // assignment at all -- unresolvable, so nothing is synthesized and no
  // violation is (falsely) produced.
  it('does not flag a gh array-literal argv element with no preceding assignment', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_ARRAY_ELEMENT_UNDECLARED_VARIABLE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(0);
  });

  // Vasquez (round 9/15): end-to-end, a method-shorthand wrapper called
  // through a VARIABLE-KEY bracket access must be traced back to it, the
  // same as the already-handled literal-quoted-key form.
  it('flags a call through a variable-key bracket-access binding', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_VARIABLE_KEY_BRACKET_CALL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Negative control: a variable-key bracket access resolving to an
  // unrelated method that never shells out to `gh` must not be flagged.
  it('does not flag a variable-key bracket-access binding to an unrelated method', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: NON_WRAPPER_VARIABLE_KEY_BRACKET_CALL_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(0);
  });

  // Ralph session ae252904 (round 16): a wrapper call's argv spread from a
  // separately-declared array variable must be resolved and scanned, the
  // same as the already-handled bare-identifier array-literal element.
  it('flags a wrapper call whose argv is spread from a preceding array variable', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_ARGV_ARRAY_SPREAD_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.matches).toContain('gh pr list --label');
  });

  // Negative control: the same spread shape resolving to a safe argv must
  // not be flagged.
  it('does not flag a wrapper call whose spread argv variable is safe', () => {
    const { violations } = scanLabelIndexUsage({
      files: [
        {
          path: 'scripts/example.mjs',
          contents: GH_WRAPPER_ARGV_ARRAY_SPREAD_SAFE_SNIPPET,
        },
      ],
    });
    expect(violations).toHaveLength(0);
  });
});

describe('flattenGhArgvInvocations', () => {
  it('reconstructs a gh argv-array call as a plain-text command', () => {
    const flattened = flattenGhArgvInvocations(GH_PR_LIST_ARGV_ARRAY_SNIPPET);
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  it('returns an empty string when there is no gh argv-array call', () => {
    expect(flattenGhArgvInvocations('console.log("hi");')).toBe('');
  });

  // Vasquez (round 2): the bypass was resolving a named argv variable back
  // to its array-literal assignment, not giving up on it.
  it('resolves a named argv variable back to its own array-literal assignment', () => {
    const flattened = flattenGhArgvInvocations(
      GH_PR_LIST_ARGV_VARIABLE_SNIPPET,
    );
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  it('resolves a named argv variable even when the call has a trailing options object', () => {
    const flattened = flattenGhArgvInvocations(
      GH_ISSUE_LIST_ARGV_VARIABLE_SNIPPET,
    );
    expect(flattened).toContain('gh issue list');
    expect(flattened).toContain('-l');
    expect(flattened).toContain('hold:sequenced');
  });

  it('does not resolve an argv variable with no matching array-literal assignment in the file', () => {
    // Documented limit: an argv assembled through .push()/.concat()/spread
    // from another variable, or declared in a file this scan cannot see,
    // cannot be resolved by a text scan without executing the program --
    // the same interpolated-value limit LABEL_INDEX_PATTERNS already has.
    const variableArgvSnippet = "execFileSync('gh', ghArgs);";
    expect(flattenGhArgvInvocations(variableArgvSnippet)).toBe('');
  });

  // Vasquez (round 3): reassignment bypass -- a binding declared safely and
  // then reassigned to a banned form before the call must resolve to the
  // reassignment, not the original declaration.
  it('resolves a reassigned argv variable to its most recent assignment before the call', () => {
    const flattened = flattenGhArgvInvocations(
      GH_PR_LIST_ARGV_REASSIGNED_SNIPPET,
    );
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  it('does not flag a safe-only argv variable with no unsafe reassignment', () => {
    const flattened = flattenGhArgvInvocations(
      GH_PR_LIST_ARGV_SAFE_ONLY_SNIPPET,
    );
    expect(flattened).not.toContain('--label');
    expect(flattened).not.toContain('hold:sequenced');
  });

  // Ripley (round 4): a wrapper function's own `execFileSync('gh', ...)`
  // must be traced through a call to the wrapper by name, for a
  // block-bodied arrow, an expression-bodied arrow, and a plain function
  // declaration -- three common shapes a repo helper might take.
  it('resolves a call to a block-bodied arrow wrapper that shells out to gh', () => {
    const flattened = flattenGhArgvInvocations(
      GH_WRAPPER_ARROW_BLOCK_BODY_SNIPPET,
    );
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  it('resolves a call to an expression-bodied arrow wrapper, including its own argv variable', () => {
    const flattened = flattenGhArgvInvocations(
      GH_WRAPPER_ARROW_EXPRESSION_BODY_SNIPPET,
    );
    expect(flattened).toContain('gh issue list');
    expect(flattened).toContain('-l');
    expect(flattened).toContain('hold:sequenced');
  });

  it('resolves a call to a plain function-declaration wrapper', () => {
    const flattened = flattenGhArgvInvocations(
      GH_WRAPPER_FUNCTION_DECLARATION_SNIPPET,
    );
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--search');
  });

  it('does not treat a same-named function as a wrapper unless its body actually shells out to gh', () => {
    const flattened = flattenGhArgvInvocations(NON_WRAPPER_SAME_NAME_SNIPPET);
    expect(flattened).toBe('');
  });

  // Ripley (round 5): a wrapper's argv is not always its FIRST parameter --
  // a real repo-style wrapper like `runGh(run, args, env)` takes it second.
  // The scan must resolve an array-literal or array-variable argument found
  // ANYWHERE in the wrapper call's argument list, not assume position 0.
  it('resolves a wrapper argv passed as the SECOND parameter (array literal)', () => {
    const flattened = flattenGhArgvInvocations(
      GH_WRAPPER_ARGV_SECOND_PARAMETER_SNIPPET,
    );
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  it('resolves a wrapper argv passed as the SECOND parameter (variable)', () => {
    const flattened = flattenGhArgvInvocations(
      GH_WRAPPER_ARGV_SECOND_PARAMETER_VARIABLE_SNIPPET,
    );
    expect(flattened).toContain('gh issue list');
    expect(flattened).toContain('-l');
    expect(flattened).toContain('hold:sequenced');
  });

  // Vasquez/Ripley (round 6): a NESTED wrapper -- one whose own body calls
  // ANOTHER wrapper rather than `gh` directly -- must be resolved too, via
  // the `extraWrapperNames` a project-wide caller (collectProjectGhWrapperNames)
  // supplies after fixed-point iteration.
  it('resolves a nested wrapper when its name is supplied via extraWrapperNames', () => {
    const flattened = flattenGhArgvInvocations(GH_NESTED_WRAPPER_SNIPPET, [
      'runGh',
    ]);
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  it('does NOT resolve a nested wrapper on its own, without extraWrapperNames (documents the single-file limit extraWrapperNames exists to lift)', () => {
    const flattened = flattenGhArgvInvocations(GH_NESTED_WRAPPER_SNIPPET);
    expect(flattened).not.toContain('--label');
  });

  // Ripley (round 9): a rest-param wrapper's argv must be reconstructed
  // from its ENTIRE call argument list, not just a single array-typed
  // argument.
  it('resolves a rest-param wrapper by reconstructing its entire call argument list', () => {
    const flattened = flattenGhArgvInvocations(GH_WRAPPER_REST_PARAM_SNIPPET);
    expect(flattened).toContain('gh issue list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  // Vasquez (round 9): an unrelated method call sharing a bare wrapper's
  // name (e.g. `client.runGh('safe', [...])` on some unrelated object)
  // must NOT be conflated with the real bare-defined wrapper -- exactly
  // one match, from the genuine `runGh([...])` call, should be produced.
  it('does not conflate an unrelated method call with a same-named bare wrapper', () => {
    const flattened = flattenGhArgvInvocations(
      GH_WRAPPER_NAME_COLLISION_SNIPPET,
    );
    const matches = flattened
      .split('\n')
      .filter((line) => line.includes('--label'));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain('gh pr list');
    expect(flattened).not.toContain('gh issue list');
  });

  // Vasquez (round 10): a factory-returned wrapper's call site must
  // resolve too, once `makeGhRunner` (the factory) and `runGh` (its
  // return value, bound under a new name) are both supplied via
  // extraWrapperNames -- the same project-wide resolution
  // `collectProjectGhWrapperNames` performs.
  it('resolves a factory-returned wrapper when both names are supplied via extraWrapperNames', () => {
    const flattened = flattenGhArgvInvocations(
      GH_FACTORY_RETURNED_WRAPPER_SNIPPET,
      ['makeGhRunner', 'runGh'],
    );
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  // Vasquez (round 11): a comment merely QUOTING the direct-call shape
  // (documenting the pattern, not executing it) must not itself be
  // flattened into a violation -- this function's own call-site scans
  // must strip comments from `contents` first, the same way every
  // wrapper-DEFINITION test in this file already does for an extracted
  // body.
  it('does not flatten a comment that merely quotes the direct-call shape', () => {
    expect(flattenGhArgvInvocations(GH_COMMENT_ONLY_DIRECT_CALL_SNIPPET)).toBe(
      '',
    );
  });

  // Vasquez (round 11): a method-shorthand wrapper called through BRACKET
  // (computed-property) access must resolve exactly as a dot-accessed call
  // would.
  it('resolves a method wrapper called through bracket (computed-property) access', () => {
    const flattened = flattenGhArgvInvocations(GH_WRAPPER_BRACKET_CALL_SNIPPET);
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  // Ripley (round 11): a wrapper must still be recognized when a REGEX
  // LITERAL with escaped slashes (not a quoted string) appears earlier on
  // the same line as the real gh call.
  it('resolves a wrapper even when a same-line regex literal contains escaped slashes', () => {
    const flattened = flattenGhArgvInvocations(
      GH_WRAPPER_REGEX_LITERAL_SAME_LINE_SNIPPET,
    );
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  // Vasquez (round 12): the comma-operator indirect-call idiom (`(0,
  // runGh)([...])`) must resolve exactly as a direct bare call would.
  it('resolves a wrapper called through the comma-operator indirect-call idiom', () => {
    const flattened = flattenGhArgvInvocations(
      GH_WRAPPER_COMMA_OPERATOR_CALL_SNIPPET,
    );
    expect(flattened).toContain('gh pr list');
    expect(flattened).toContain('--label');
    expect(flattened).toContain('hold:sequenced');
  });

  it('does not resolve a comma-operator call to an unrelated function', () => {
    expect(
      flattenGhArgvInvocations(NON_WRAPPER_COMMA_OPERATOR_CALL_SNIPPET),
    ).toBe('');
  });
});

describe('findUnresolvedGhWrapperCalls', () => {
  // Ripley + Vasquez (round 12): a rest-param wrapper call whose argv
  // contains a value that cannot be statically resolved must be reported
  // here, not silently discarded.
  it('reports a rest-param wrapper call whose argv cannot be statically resolved', () => {
    const entries = findUnresolvedGhWrapperCalls(
      GH_REST_PARAM_UNRESOLVABLE_ARGV_SNIPPET,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('runGh');
    expect(entries[0]!.snippet).toContain('dynamicLabel');
  });

  it('does not report a rest-param wrapper call whose argv is fully resolvable', () => {
    expect(
      findUnresolvedGhWrapperCalls(
        GH_REST_PARAM_RESOLVABLE_ARGV_VIOLATION_SNIPPET,
      ),
    ).toHaveLength(0);
    expect(
      findUnresolvedGhWrapperCalls(GH_REST_PARAM_RESOLVABLE_ARGV_SAFE_SNIPPET),
    ).toHaveLength(0);
  });

  // A rest-param wrapper's own DEFINITION header (`function runGh(...args)
  // { ... }`) must never itself be reported -- only actual CALL sites with
  // unresolvable arguments.
  it('does not report a rest-param wrapper definition with no call sites at all', () => {
    expect(
      findUnresolvedGhWrapperCalls(
        'function runGh(...args) { return execFileSync("gh", args); }',
      ),
    ).toHaveLength(0);
  });
});

describe('formatNeedsReview', () => {
  it('includes the file path, wrapper name, and snippet', () => {
    const formatted = formatNeedsReview({
      path: 'scripts/example.mjs',
      name: 'runGh',
      snippet: "runGh('pr', 'list', '--label', dynamicLabel)",
    });
    expect(formatted).toContain('scripts/example.mjs');
    expect(formatted).toContain('runGh');
    expect(formatted).toContain('dynamicLabel');
  });
});

describe('flattenIndirectLabelQueryConstruction', () => {
  // Hicks (round 10): a `label:` qualifier assembled into a variable
  // first, then interpolated into a SEPARATE fetch call to a GitHub host,
  // must be recognized even though neither the literal text `label:` nor
  // the request URL ever appear together in one matched span.
  it('recognizes a label qualifier built in a variable and used in a later fetch call to a GitHub host', () => {
    const flattened = flattenIndirectLabelQueryConstruction(
      INDIRECT_LABEL_QUERY_SNIPPET,
    );
    expect(flattened).not.toBe('');
  });

  it('returns an empty string when there is no label:-containing variable at all', () => {
    expect(
      flattenIndirectLabelQueryConstruction('fetch("https://example.com");'),
    ).toBe('');
  });

  // Negative control: an unrelated fetch call and an unrelated `label:`-
  // containing string, with no actual link (the fetch never references
  // the label-holding variable, nor a GitHub host) -- must not be flagged.
  it('does not flag an unrelated fetch call alongside an unrelated label:-containing string', () => {
    expect(
      flattenIndirectLabelQueryConstruction(
        INDIRECT_LABEL_QUERY_NEGATIVE_CONTROL_SNIPPET,
      ),
    ).toBe('');
  });
});

describe('findGhWrapperNames', () => {
  it('finds a block-bodied arrow wrapper by behavior, not name', () => {
    const names = findGhWrapperNames(GH_WRAPPER_ARROW_BLOCK_BODY_SNIPPET);
    expect(names.has('gh')).toBe(true);
  });

  it('finds an expression-bodied arrow wrapper under an arbitrary name', () => {
    const names = findGhWrapperNames(GH_WRAPPER_ARROW_EXPRESSION_BODY_SNIPPET);
    expect(names.has('invokeGh')).toBe(true);
  });

  it('finds a plain function-declaration wrapper', () => {
    const names = findGhWrapperNames(GH_WRAPPER_FUNCTION_DECLARATION_SNIPPET);
    expect(names.has('runGh')).toBe(true);
  });

  it('does not report a same-named function whose body does not shell out to gh', () => {
    const names = findGhWrapperNames(NON_WRAPPER_SAME_NAME_SNIPPET);
    expect(names.has('gh')).toBe(false);
  });

  it('returns an empty set for a file with no function definitions at all', () => {
    const names = findGhWrapperNames('const x = 1;');
    expect(names.size).toBe(0);
  });

  // Ripley (round 5): behavior detection must not depend on where the argv
  // parameter sits in the wrapper's own signature -- `runGh(run, args, env)`
  // still shells out to `gh` via `run('gh', args, env)` in its body.
  it('finds a wrapper whose own argv parameter is not its first parameter', () => {
    const names = findGhWrapperNames(GH_WRAPPER_ARGV_SECOND_PARAMETER_SNIPPET);
    expect(names.has('runGh')).toBe(true);
  });

  // Ripley (round 8): a plain string containing the literal text `'gh',`
  // must not be mistaken for an actual call to `gh`.
  it('does not report a function whose body only contains the literal text inside a STRING, not an actual call', () => {
    const names = findGhWrapperNames(GH_STRING_LITERAL_FALSE_POSITIVE_SNIPPET);
    expect(names.has('notAWrapper')).toBe(false);
  });

  // Ripley (round 8): same false-positive shape, but via a COMMENT rather
  // than a string literal.
  it('does not report a function whose body only contains the literal text inside a COMMENT, not an actual call', () => {
    const names = findGhWrapperNames(GH_COMMENT_FALSE_POSITIVE_SNIPPET);
    expect(names.has('notAWrapper2')).toBe(false);
  });

  // Vasquez (round 8): a CLASS METHOD (`invokeGh(args) { ... }` inside a
  // class body) must be recognized as a wrapper definition, the same as a
  // function declaration or arrow assignment.
  it('finds a class-method wrapper by behavior', () => {
    const names = findGhWrapperNames(GH_CLASS_METHOD_WRAPPER_SNIPPET);
    expect(names.has('invokeGh')).toBe(true);
  });

  // Vasquez (round 10): a string literal containing `//` (e.g. a URL) on
  // the SAME LINE, BEFORE the wrapper's real gh call, must not cause the
  // comment-stripping pass to discard the rest of the line -- the wrapper
  // must still be recognized.
  it('finds a wrapper even when a string literal containing // appears earlier on the same line', () => {
    const names = findGhWrapperNames(GH_WRAPPER_URL_STRING_SAME_LINE_SNIPPET);
    expect(names.has('invokeGh')).toBe(true);
  });

  // Ripley (round 11): a REGEX LITERAL with escaped slashes (not a quoted
  // string) on the SAME LINE, BEFORE the wrapper's real gh call, must not
  // cause the comment-stripping pass to discard the rest of the line
  // either -- the wrapper must still be recognized.
  it('finds a wrapper even when a same-line regex literal contains escaped slashes', () => {
    const names = findGhWrapperNames(
      GH_WRAPPER_REGEX_LITERAL_SAME_LINE_SNIPPET,
    );
    expect(names.has('invokeGh')).toBe(true);
  });
});

// Vasquez/Ripley (round 6): both gaps -- nested wrappers (a wrapper that
// calls another wrapper, neither shelling out to `gh` directly in its own
// body) and cross-file wrapper imports -- require resolving wrapper names
// PROJECT-WIDE, across every scanned file at once, not one file's text in
// isolation. `collectProjectGhWrapperNames` is the function that does this.
describe('collectProjectGhWrapperNames', () => {
  it('resolves a nested wrapper (one that calls another wrapper, not gh directly) via fixed-point iteration', () => {
    const wrapperNamesByPath = collectProjectGhWrapperNames([
      { path: 'scripts/example.mjs', contents: GH_NESTED_WRAPPER_SNIPPET },
    ]);
    const names = wrapperNamesByPath.get('scripts/example.mjs')!;
    expect(names.has('invokeGh')).toBe(true);
    expect(names.has('runGh')).toBe(true);
  });

  it('resolves a wrapper imported (under an alias) from another scanned file', () => {
    const wrapperNamesByPath = collectProjectGhWrapperNames([
      {
        path: 'scripts/gh-utils.mjs',
        contents: GH_WRAPPER_DEFINITION_MODULE_SNIPPET,
      },
      {
        path: 'scripts/example.mjs',
        contents: GH_WRAPPER_IMPORT_CONSUMER_SNIPPET,
      },
    ]);
    expect(
      wrapperNamesByPath.get('scripts/gh-utils.mjs')!.has('invokeGh'),
    ).toBe(true);
    // The consumer imports `invokeGh` AS `runGh` -- the local (aliased)
    // name is what must be recognized as a wrapper in ITS OWN file.
    expect(wrapperNamesByPath.get('scripts/example.mjs')!.has('runGh')).toBe(
      true,
    );
  });

  it('does not resolve an import from a file outside the given file set', () => {
    const wrapperNamesByPath = collectProjectGhWrapperNames([
      {
        path: 'scripts/example.mjs',
        contents: GH_WRAPPER_IMPORT_CONSUMER_SNIPPET,
      },
    ]);
    expect(wrapperNamesByPath.get('scripts/example.mjs')!.has('runGh')).toBe(
      false,
    );
  });

  // Vasquez (round 8): a bare reference alias (`const myGh = invokeGh;`,
  // no call) to an already-known wrapper must resolve too, via the same
  // fixed-point loop used for nested/cross-file wrappers.
  it('resolves a bare reference alias of an already-known wrapper', () => {
    const wrapperNamesByPath = collectProjectGhWrapperNames([
      { path: 'scripts/example.mjs', contents: GH_ALIASED_WRAPPER_SNIPPET },
    ]);
    const names = wrapperNamesByPath.get('scripts/example.mjs')!;
    expect(names.has('invokeGh')).toBe(true);
    expect(names.has('myGh')).toBe(true);
  });

  // Vasquez/Ripley (round 9): a wrapper re-exported through an
  // intermediate barrel file must resolve chained through any number of
  // re-export/import hops, via the same fixed-point loop.
  it('resolves a wrapper re-exported through a barrel file and imported from it', () => {
    const wrapperNamesByPath = collectProjectGhWrapperNames([
      {
        path: 'scripts/gh-utils.mjs',
        contents: GH_WRAPPER_DEFINITION_MODULE_SNIPPET,
      },
      {
        path: 'scripts/index.mjs',
        contents: GH_WRAPPER_BARREL_INDEX_SNIPPET,
      },
      {
        path: 'scripts/consumer.mjs',
        contents: GH_WRAPPER_BARREL_CONSUMER_SNIPPET,
      },
    ]);
    expect(wrapperNamesByPath.get('scripts/index.mjs')!.has('invokeGh')).toBe(
      true,
    );
    expect(
      wrapperNamesByPath.get('scripts/consumer.mjs')!.has('invokeGh'),
    ).toBe(true);
  });

  // Ripley (round 9): a wrapper exposed only as a DEFAULT export, imported
  // with `import NAME from './path'` (no braces), must resolve via the
  // `'default'` sentinel entry.
  it('resolves a default-exported wrapper imported without braces', () => {
    const wrapperNamesByPath = collectProjectGhWrapperNames([
      {
        path: 'scripts/gh-utils.mjs',
        contents: GH_WRAPPER_DEFAULT_EXPORT_MODULE_SNIPPET,
      },
      {
        path: 'scripts/consumer2.mjs',
        contents: GH_WRAPPER_DEFAULT_IMPORT_CONSUMER_SNIPPET,
      },
    ]);
    expect(wrapperNamesByPath.get('scripts/gh-utils.mjs')!.has('default')).toBe(
      true,
    );
    expect(
      wrapperNamesByPath.get('scripts/consumer2.mjs')!.has('invokeGh'),
    ).toBe(true);
  });

  // Vasquez (round 10): a wrapper re-exported through a barrel file with
  // an ALIAS (`export { invokeGh as runGh } from './gh-utils.mjs';`) must
  // resolve the same way a non-aliased re-export does.
  it('resolves a wrapper re-exported through a barrel file UNDER AN ALIAS', () => {
    const wrapperNamesByPath = collectProjectGhWrapperNames([
      {
        path: 'scripts/gh-utils.mjs',
        contents: GH_WRAPPER_DEFINITION_MODULE_SNIPPET,
      },
      {
        path: 'scripts/index.mjs',
        contents: GH_WRAPPER_BARREL_ALIASED_INDEX_SNIPPET,
      },
      {
        path: 'scripts/consumer.mjs',
        contents: GH_WRAPPER_BARREL_ALIASED_CONSUMER_SNIPPET,
      },
    ]);
    expect(wrapperNamesByPath.get('scripts/index.mjs')!.has('runGh')).toBe(
      true,
    );
    expect(wrapperNamesByPath.get('scripts/consumer.mjs')!.has('runGh')).toBe(
      true,
    );
  });

  // Vasquez (round 10): a wrapper's return value, assigned from a CALL to
  // an already-known wrapper (`const runGh = makeGhRunner();`), must
  // resolve too -- `makeGhRunner` is already known as a wrapper because
  // its own body textually shells out to gh (nested inside the closure it
  // returns).
  it('resolves a factory-returned wrapper (const NAME = knownWrapper())', () => {
    const wrapperNamesByPath = collectProjectGhWrapperNames([
      {
        path: 'scripts/example.mjs',
        contents: GH_FACTORY_RETURNED_WRAPPER_SNIPPET,
      },
    ]);
    const names = wrapperNamesByPath.get('scripts/example.mjs')!;
    expect(names.has('makeGhRunner')).toBe(true);
    expect(names.has('runGh')).toBe(true);
  });
});

describe('formatViolation', () => {
  it('renders the path, matched patterns and reason', () => {
    const rendered = formatViolation({
      path: 'scripts/example.mjs',
      matches: ['gh pr list --label'],
      reason: 'no allowlist entry',
    });
    expect(rendered).toContain('scripts/example.mjs');
    expect(rendered).toContain('gh pr list --label');
    expect(rendered).toContain('no allowlist entry');
  });
});

describe('LABEL_INDEX_PATTERNS and SCANNED_DIRECTORIES', () => {
  it('names at least the five surfaces this check covers', () => {
    expect(LABEL_INDEX_PATTERNS.length).toBeGreaterThanOrEqual(5);
    const names = LABEL_INDEX_PATTERNS.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'gh pr list --label',
        'gh issue list --label',
        'gh pr/issue list --search label:',
        'REST issues collection filtered by label',
        'search API label: qualifier',
      ]),
    );
  });

  it('scans scripts/ and .github/workflows/, not documentation', () => {
    expect(SCANNED_DIRECTORIES).toEqual(
      expect.arrayContaining(['scripts/', '.github/workflows/']),
    );
    // .squad/holds.md quotes `gh pr list --label` at length as a worked
    // example of #299 -- it must stay out of scope, or this guard would nag
    // every retelling of the issue it exists to prevent recurrence of.
    expect(SCANNED_DIRECTORIES).not.toEqual(
      expect.arrayContaining(['.squad/']),
    );
  });
});

describe('ALLOWED_LABEL_INDEX_USAGE', () => {
  it('carries a non-empty reason and a non-empty patterns list for every entry', () => {
    for (const [file, entry] of Object.entries(ALLOWED_LABEL_INDEX_USAGE)) {
      expect(file.length).toBeGreaterThan(0);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(entry.patterns)).toBe(true);
      expect(entry.patterns?.length).toBeGreaterThan(0);
      // Every named pattern must be a pattern this file actually defines --
      // an allowlist entry that names a typo'd or removed pattern would
      // silently excuse nothing while looking like it excuses something.
      const knownNames = LABEL_INDEX_PATTERNS.map((p) => p.name);
      for (const patternName of entry.patterns ?? []) {
        expect(knownNames).toContain(patternName);
      }
    }
  });

  it('allowlists lift-hold-on-close.mjs, the one script that legitimately queries the index', () => {
    expect(ALLOWED_LABEL_INDEX_USAGE).toHaveProperty(
      'scripts/lift-hold-on-close.mjs',
    );
    const entry = ALLOWED_LABEL_INDEX_USAGE['scripts/lift-hold-on-close.mjs'];
    expect(entry?.reason).toContain('re-read');
    expect(entry?.patterns).toEqual(['search API label: qualifier']);
  });
});

// Vasquez: `collectScannedFiles` must never follow a tracked symbolic link
// -- it could point outside this repository entirely, smuggling an
// unreviewed file's content into the scan under a `scripts/`-looking path.
describe('collectScannedFiles', () => {
  it('refuses a tracked symbolic link instead of reading through it', () => {
    const { files, refusedSymlinks } = collectScannedFiles({
      listFiles: () => ['scripts/real-file.mjs', 'scripts/escape-hatch.mjs'],
      lstat: (path) => ({
        isSymbolicLink: () => path === 'scripts/escape-hatch.mjs',
      }),
      readFile: (path) => {
        // The symlink path must never reach readFile at all -- if it does,
        // the guard ran too late to matter.
        if (path === 'scripts/escape-hatch.mjs') {
          throw new Error('readFile must not be called for a symbolic link');
        }
        return `contents of ${path}`;
      },
    });

    expect(refusedSymlinks).toEqual(['scripts/escape-hatch.mjs']);
    expect(files).toEqual([
      {
        path: 'scripts/real-file.mjs',
        contents: 'contents of scripts/real-file.mjs',
      },
    ]);
  });

  it('does not refuse a regular tracked file', () => {
    const { files, refusedSymlinks } = collectScannedFiles({
      listFiles: () => ['scripts/real-file.mjs'],
      lstat: () => ({ isSymbolicLink: () => false }),
      readFile: (path) => `contents of ${path}`,
    });

    expect(refusedSymlinks).toEqual([]);
    expect(files).toEqual([
      {
        path: 'scripts/real-file.mjs',
        contents: 'contents of scripts/real-file.mjs',
      },
    ]);
  });

  // Vasquez (round 5): the pre-read lstat and the read itself are two
  // separate filesystem calls, so a path could in principle be swapped for
  // a symlink in between (TOCTOU). Simulates that swap by having `lstat`
  // report "not a symlink" on its FIRST call (the pre-read check, which
  // passes) and "IS a symlink" on its SECOND call (the post-read
  // re-check) -- the just-read content must be discarded and the path
  // reported as refused, not silently trusted on the strength of the
  // first check alone.
  it('discards content and refuses the path if a post-read recheck finds a symlink (narrows the TOCTOU race)', () => {
    let lstatCallCount = 0;
    const { files, refusedSymlinks } = collectScannedFiles({
      listFiles: () => ['scripts/swapped-file.mjs'],
      lstat: () => {
        lstatCallCount += 1;
        return { isSymbolicLink: () => lstatCallCount >= 2 };
      },
      readFile: (path) => `contents of ${path}`,
    });

    expect(refusedSymlinks).toEqual(['scripts/swapped-file.mjs']);
    expect(files).toEqual([]);
  });
});

// Real-repo scan: the tracked tree, right now, must be clean except for the
// one allowlisted file. This is the assertion that actually enforces #299's
// remedy going forward -- a future script that copies the `gh pr list
// --label` shape without reading this file first will fail this test.
describe('the tracked tree has no unlisted use of the label search/list index', () => {
  it('scans scripts/ and .github/workflows/ and finds only the allowlisted file, if any', () => {
    // Uses collectScannedFiles' real defaults (fs.readFileSync + `git
    // ls-files`, both resolved relative to the process cwd, which vitest
    // runs from the repository root) rather than reading a specific commit --
    // this test must see files as they are in the working tree, including
    // this change's own new/uncommitted files, not a stale HEAD.
    const { files, refusedSymlinks } = collectScannedFiles();

    // The real tree must contain no tracked symlinks under the scanned
    // directories; if it ever does, that is itself something to review, not
    // something this test should silently pass through.
    expect(refusedSymlinks).toEqual([]);

    // Controls, so a scan that read zero files is not indistinguishable from
    // a clean tree.
    expect(files.length).toBeGreaterThan(10);

    const { violations, allowlisted } = scanLabelIndexUsage({ files });

    if (violations.length > 0) {
      throw new Error(
        `label-index-usage violation(s):\n${violations.map(formatViolation).join('\n')}`,
      );
    }

    for (const entry of allowlisted) {
      expect(Object.keys(ALLOWED_LABEL_INDEX_USAGE)).toContain(entry.path);
    }
  });
});
