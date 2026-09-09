// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) =>
  readFileSync(path.join(root, ...parts), 'utf8').replaceAll('\r\n', '\n');

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.isFile() && entry.name.endsWith('.md') ? [full] : [];
  });
}

describe('Ralph bounded-round policy', () => {
  const loop = read('.squad', 'agents', 'ralph', 'loop.md');
  const coordinatorPolicies = [
    read('.github', 'agents', 'squad.agent.md'),
    read('.squad', 'templates', 'squad.agent.md.template'),
  ];

  it('keeps every coordinator-facing Ralph policy one-shot', () => {
    for (const policy of coordinatorPolicies) {
      const ralphSection = policy
        .split('## Ralph — Work Monitor')[1]
        ?.split('### Connecting to a Repo')[0];
      expect(ralphSection).toBeDefined();
      expect(ralphSection).toMatch(
        /Each activation completes one bounded round and exits/i,
      );
      expect(ralphSection).toMatch(
        /later round requires a new explicit activation/i,
      );
      expect(ralphSection).toContain('.squad/agents/ralph/loop.md');
      expect(ralphSection).not.toContain('always-on work monitor');
      expect(ralphSection).not.toMatch(/continuous scan.*rescan loop/i);
      expect(ralphSection).not.toContain('idle-watch');
      expect(ralphSection).not.toContain('ralph-reference.md');
    }
  });

  it('requires callers to paginate before using the cache CLI', () => {
    expect(loop).toMatch(
      /caller must first obtain a complete\s+paginated listing.*fail closed on a malformed or truncated response.*provide that listing to `ralph:round-cache`/is,
    );
    expect(loop).toMatch(
      /It only snapshots, diffs, and emits\s+compact JSON/is,
    );
    expect(loop).not.toMatch(/ralph-round-cache\.mjs` to paginate/i);
  });

  it('keeps the exact verdict gate and current-head refusal semantics', () => {
    expect(loop).toContain(
      'npm run check:squad-verdict -- --repo OlyForge3D/PrintFarmerDesktop --pr N --json',
    );
    expect(loop).toMatch(
      /current-head `REVIEWED` or `APPROVED` usable evidence/,
    );
    expect(loop).toMatch(/one-reviewer documentation-only rule/);
    expect(loop).toMatch(/`APPROVED` preserves direct owner\s+approval/);
    expect(loop).toMatch(/NOT_APPLICABLE[\s\S]*never\s+unattended merge/);
    const gates = read(
      '.squad',
      'agents',
      'ralph',
      'references',
      'pr-gates.md',
    );
    expect(gates).toMatch(/current-head\s+`REVIEWED` or `APPROVED`/);
    expect(gates).toMatch(/documentation-only rule/);
    expect(gates).toMatch(/direct owner approval/);
    expect(gates).toMatch(/not-applicable.*refuse\s+unattended merge/is);
    expect(gates).toMatch(/combined-diff hunks/);
  });

  it('keeps Ralph unambiguously one-shot in its charter', () => {
    const charter = read('.squad', 'agents', 'ralph', 'charter.md');

    expect(charter).toMatch(/one bounded pass per activation/i);
    expect(charter).toMatch(/Reports once, then exits/);
    expect(charter).toMatch(/There is no\s+interactive-loop exception/i);
    expect(charter).not.toMatch(/keeps going while there is work/i);
    expect(charter).not.toMatch(
      /Interactive looping while work exists is fine/i,
    );
  });

  it('loads compact policy first and keeps cleanup report-only', () => {
    expect(loop).toContain('index.md');
    expect(loop).toContain('one round and exit');
    expect(loop).toContain('five');
    const reaping = read(
      '.squad',
      'agents',
      'ralph',
      'references',
      'reaping.md',
    );
    expect(reaping).toMatch(/never call archive or delete/);
    expect(reaping).toMatch(
      /no dirty or untracked data and no\s+unpushed work/,
    );
    expect(reaping).toMatch(/settling period/);
    expect(reaping).toMatch(
      /explicit confirmation that names each specific session/,
    );
    expect(reaping).toMatch(
      /not session management or a handoff to\s+a reaper/,
    );
    expect(loop).toContain('🧹 Cleanup candidates');
    expect(loop).toMatch(
      /must never call `archive_session` or\s+`delete_item`/,
    );
  });

  it('keeps merge and review safety bans in the always-loaded core', () => {
    expect(loop).toMatch(/Never merge a draft/);
    expect(loop).toMatch(
      /Serialize merges: verify one merge landed and its linked\s+issue closed before starting another/,
    );
    expect(loop).toMatch(/never reviews PRs or spawns review sessions/);
  });

  it('requires completed inspections before cache reuse', () => {
    expect(loop).toMatch(
      /cannot be reused until every planned inspection finishes/,
    );
    expect(loop).toContain('--commit ROUND_ID');
    expect(loop).toMatch(/interruption leaves every\s+item inspect-only/);
  });

  it('keeps author handoffs narrow and links all conditional procedures', () => {
    const handoff = read(
      '.squad',
      'skills',
      'ralph-implementation',
      'SKILL.md',
    );
    expect(handoff).toMatch(/changed paths.*acceptance criteria/);
    expect(handoff).not.toContain('full Ralph policy');
    for (const reference of [
      'triage-dispatch.md',
      'pr-gates.md',
      'reaping.md',
    ]) {
      expect(loop).toContain(reference);
    }
  });

  it('makes global BEHIND sync ordering a Ralph-side pre-dispatch gate', () => {
    const gates = read(
      '.squad',
      'agents',
      'ralph',
      'references',
      'pr-gates.md',
    );
    expect(loop).toContain('references/pr-gates.md');
    expect(gates).toContain('npm run plan:behind-sync-order');
    expect(gates).toMatch(/one global .*oldest-first sync order/i);
    expect(gates).toMatch(/active sync lease, stand down/i);
    expect(gates).toMatch(/never authorization/i);
  });

  it('keeps landed and premise re-derivation procedures in the lazy PR-gate reference', () => {
    const gates = read(
      '.squad',
      'agents',
      'ralph',
      'references',
      'pr-gates.md',
    );
    const collaboration = read(
      '.squad',
      'skills',
      'agent-collaboration',
      'SKILL.md',
    );

    expect(gates).toMatch(/Immediately before reporting a PR as merged/i);
    expect(gates).toContain('npm run check:merge-landed');
    expect(gates).toMatch(/merge commit.*origin\/development/is);
    expect(gates).toContain('npm run check:gate-premises -- --pr <n>');
    expect(gates).toMatch(/reads terminal state first/i);
    expect(gates).toMatch(/Exit 2 is unverifiable.*never.*proceed/is);
    expect(loop).toContain('references/pr-gates.md');
    expect(collaboration).toContain(
      '.squad/agents/ralph/references/pr-gates.md',
    );
    expect(collaboration).not.toMatch(/loop\.md` §9\.[12]/);
  });

  it('contains no obsolete numbered citations to the compact Ralph core', () => {
    const behindSyncOrder = read('scripts', 'plan-behind-sync-order.mjs');
    const citationSources = [
      read('.squad', 'skills', 'agent-collaboration', 'SKILL.md'),
      read('.squad', 'skills', 'git-workflow', 'SKILL.md'),
      read('.squad', 'routing.md'),
      read('.squad', 'templates', 'issue-lifecycle.md'),
      read('.github', 'workflows', 'squad-review-verdict.yml'),
      read('scripts', 'check-script-reachability.mjs'),
      behindSyncOrder,
      read('scripts', 'squad-verdict-gate.mjs'),
    ];
    for (const source of citationSources) {
      expect(source).not.toMatch(/ralph\/loop\.md`? §(?:8|9(?:\.\d+)?)/);
      expect(source).not.toMatch(/loop\.md` §4, which counts analysis/);
      expect(source).not.toMatch(/loop\.md[^\n]*§4\.3/);
      expect(source).not.toMatch(/ralph\/loop\.md`? §1\b/);
    }
    expect(behindSyncOrder).toMatch(/ralph\/loop\.md` step 2/);
    expect(behindSyncOrder).toMatch(/ralph\/references\/triage-dispatch\.md/);
  });

  it('points the merge-gate-premises reachability citation at the live reference document', () => {
    const reachability = read('scripts', 'check-script-reachability.mjs');
    const gates = read(
      '.squad',
      'agents',
      'ralph',
      'references',
      'pr-gates.md',
    );
    expect(gates).toMatch(/## Re-deriving merge-gate premises/);
    expect(gates).toContain('npm run check:gate-premises');
    expect(reachability).toMatch(/ralph\/references\/pr-gates\.md/);
    expect(reachability).toMatch(/Re-deriving merge-gate premises/);
  });

  it('points the squad verdict gate citations at live loop.md content', () => {
    const gate = read('scripts', 'squad-verdict-gate.mjs');
    expect(gate).toMatch(/loop\.md`\s+step 5/);
    expect(loop).toMatch(/^5\. Immediately before merge/m);
    expect(loop).toMatch(/`NOT_APPLICABLE` is never unattended merge/);
  });

  it('keeps the issue-lifecycle template bounded and cited to live Ralph policy', () => {
    const lifecycle = read('.squad', 'templates', 'issue-lifecycle.md');

    expect(lifecycle).toMatch(/one bounded round per activation and exits/i);
    expect(lifecycle).toMatch(/never polls, idles, or re-scans automatically/i);
    expect(lifecycle).toMatch(
      /later round requires a new\s+explicit activation/i,
    );
    expect(lifecycle).toContain(
      'Scan → Categorize → Dispatch → Verify gates → Report → Exit',
    );
    expect(lifecycle).toContain('.squad/agents/ralph/loop.md');
    for (const reference of [
      'triage-dispatch.md',
      'pr-gates.md',
      'reaping.md',
    ]) {
      expect(lifecycle).toContain(reference);
    }
    expect(lifecycle).not.toContain('ralph-reference.md');
    expect(lifecycle).not.toMatch(/continuously checks/i);
    expect(lifecycle).not.toMatch(/auto-merges/i);
  });

  it('keeps the user-owned Ralph instructions and their template in sync and bounded', () => {
    const liveInstructions = read('.squad', 'ralph-instructions.md');
    const templateInstructions = read(
      '.squad',
      'templates',
      'ralph-instructions.md',
    );

    // The template seeds `.squad/ralph-instructions.md` on `squad init`, so a
    // fresh install must not resurrect retired unbounded/continuous wording
    // that the live, already-remediated file no longer carries.
    for (const instructions of [liveInstructions, templateInstructions]) {
      expect(instructions).not.toMatch(
        /spawns? agents for all actionable issues simultaneously/i,
      );
      expect(instructions).not.toMatch(/MAXIMIZE PARALLELISM/i);
      expect(instructions).not.toMatch(/do not halt the loop/i);
      expect(instructions).toMatch(
        /\.squad\/agents\/ralph\/loop\.md.*authoritative, one-shot entry policy/is,
      );
      expect(instructions).toMatch(/Do one round and exit/);
      expect(instructions).toMatch(
        /five-slot active-session\s+cap defined in `\.squad\/agents\/ralph\/loop\.md`/,
      );
    }

    expect(templateInstructions).toEqual(liveInstructions);
  });

  it('lets no directive reintroduce the retired continuous Ralph cycle', () => {
    // The one-shot rule is only real if it holds everywhere at once. A single
    // stray template that still describes a looping monitor, or still points a
    // reader at the superseded reference, contradicts the compact core wherever
    // that reader happens to land -- which is exactly how this drift survived.
    const superseded = path.join(
      root,
      '.squad',
      'templates',
      'ralph-reference.md',
    );
    // Immutable records of what already happened: append-only agent history,
    // the dated decision log and its inbox, and archived roll-offs. They
    // legitimately describe activations made under the retired model, so this
    // guard covers directives only and never rewrites history.
    const historicalRecord = (document: string) =>
      ['history.md', 'decisions.md'].includes(path.basename(document)) ||
      document.includes(`${path.sep}.squad${path.sep}archive${path.sep}`) ||
      document.includes(`${path.sep}.squad${path.sep}decisions${path.sep}`);
    const documents = markdownFiles(path.join(root, '.squad'))
      .concat(markdownFiles(path.join(root, '.github')))
      .filter((document) => !historicalRecord(document));

    expect(documents.length).toBeGreaterThan(10);
    expect(documents).toContain(superseded);
    // Control: the exact strings this guard rejects are the ones the retired
    // wording used, so a document still carrying them is detected rather than
    // silently passing an over-narrow pattern.
    expect(
      documents.filter((document) =>
        /→\s*Loop\b/.test(
          `Scan → Categorize → Dispatch → Watch → Report → Loop\n${readFileSync(document, 'utf8')}`,
        ),
      ),
    ).toEqual(documents);

    for (const document of documents) {
      const body = readFileSync(document, 'utf8').replaceAll('\r\n', '\n');
      if (document !== superseded) {
        expect({
          document,
          cites: body.includes('ralph-reference.md'),
        }).toEqual({ document, cites: false });
      }
      expect({ document, loops: /→\s*Loop\b/.test(body) }).toEqual({
        document,
        loops: false,
      });
    }
  });
});
