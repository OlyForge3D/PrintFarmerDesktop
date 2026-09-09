// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) =>
  readFileSync(path.join(root, ...parts), 'utf8').replaceAll('\r\n', '\n');

describe('Ralph bounded-round policy', () => {
  const loop = read('.squad', 'agents', 'ralph', 'loop.md');

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
});
