import { describe, expect, it } from 'vitest';

import {
  EXIT_GATE_REQUIRED,
  EXIT_OK,
  EXIT_UNVERIFIABLE,
  VERDICT_GATE_REQUIRED,
  VERDICT_NO_GATE_NEEDED,
  VERDICT_UNVERIFIABLE,
  classifyPosition,
  classifyRoundBudget,
  classifyTerminalState,
  formatVerdict,
} from '../scripts/check-gate-premises.mjs';

const HEAD_A = '3bfa78f2722455ae626d77ada6281beaf1dd53fa';
const HEAD_B = 'cd51222311111111111111111111111111111111';

describe('classifyTerminalState — fix #4, check terminal state first', () => {
  it('resolves NO_GATE_NEEDED for a closed, merged PR regardless of anything else', () => {
    const result = classifyTerminalState({
      prNumber: 423,
      state: 'closed',
      merged: true,
    });
    expect(result.verdict).toBe(VERDICT_NO_GATE_NEEDED);
    expect(result.reason).toMatch(/no review gate/);
  });

  it('resolves NO_GATE_NEEDED for a closed, unmerged PR too — there is no live head', () => {
    const result = classifyTerminalState({
      prNumber: 423,
      state: 'closed',
      merged: false,
    });
    expect(result.verdict).toBe(VERDICT_NO_GATE_NEEDED);
  });

  it('requires a gate for an open PR', () => {
    const result = classifyTerminalState({
      prNumber: 423,
      state: 'open',
      merged: false,
    });
    expect(result.verdict).toBe(VERDICT_GATE_REQUIRED);
  });

  it('is UNVERIFIABLE with no usable state, never defaults to either terminal answer', () => {
    expect(classifyTerminalState({ prNumber: 423 }).verdict).toBe(
      VERDICT_UNVERIFIABLE,
    );
  });
});

describe('classifyPosition — fix #3, ask position and refuse a reflexive compare', () => {
  it('refuses to compare a source to itself', () => {
    const result = classifyPosition({
      sourceA: 'ls-remote:origin',
      valueA: HEAD_A,
      sourceB: 'ls-remote:origin',
      valueB: HEAD_A,
    });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(result.reason).toMatch(/compare .* to itself/);
  });

  it('reports genuine agreement between two independently named sources', () => {
    const result = classifyPosition({
      sourceA: 'gh-api:pulls.head.sha',
      valueA: HEAD_A,
      sourceB: 'ls-remote:origin/branch',
      valueB: HEAD_A,
    });
    expect(result.verdict).toBe(VERDICT_NO_GATE_NEEDED);
  });

  it('reports divergence when two independent sources disagree — the #423 shape', () => {
    const result = classifyPosition({
      sourceA: 'gh-api:pulls.head.sha',
      valueA: HEAD_A,
      sourceB: 'remembered:round-1',
      valueB: HEAD_B,
    });
    expect(result.verdict).toBe(VERDICT_GATE_REQUIRED);
    expect(result.reason).toMatch(/stale/);
  });

  it('is UNVERIFIABLE when a value is missing rather than treating it as equal or different', () => {
    expect(
      classifyPosition({
        sourceA: 'gh-api',
        valueA: HEAD_A,
        sourceB: 'ls-remote',
        valueB: null,
      }).verdict,
    ).toBe(VERDICT_UNVERIFIABLE);
  });

  it('is UNVERIFIABLE when either source name is missing', () => {
    expect(
      classifyPosition({ valueA: HEAD_A, sourceB: 'ls-remote', valueB: HEAD_A })
        .verdict,
    ).toBe(VERDICT_UNVERIFIABLE);
  });
});

describe('classifyRoundBudget — fix #5, bound the loop', () => {
  it('stays within budget for the first round on a premise', () => {
    const result = classifyRoundBudget({ history: [], currentHash: 'p1' });
    expect(result.verdict).toBe('within-budget');
    expect(result.consecutive).toBe(1);
  });

  it('stays within budget while under the threshold', () => {
    const result = classifyRoundBudget({
      history: ['p1', 'p1'],
      currentHash: 'p1',
      threshold: 3,
    });
    expect(result.verdict).toBe('within-budget');
    expect(result.consecutive).toBe(3);
  });

  it('signals re-derive once the threshold is exceeded — the #423 sixth round', () => {
    const result = classifyRoundBudget({
      history: ['p1', 'p1', 'p1'],
      currentHash: 'p1',
      threshold: 3,
    });
    expect(result.verdict).toBe('rederive');
    expect(result.consecutive).toBe(4);
    expect(result.reason).toMatch(/re-derive every input from scratch/);
  });

  it('resets once a new observation breaks the run', () => {
    const result = classifyRoundBudget({
      history: ['p1', 'p1', 'p1'],
      currentHash: 'p2',
      threshold: 3,
    });
    expect(result.verdict).toBe('within-budget');
    expect(result.consecutive).toBe(1);
  });

  it('is UNVERIFIABLE with no usable hash rather than silently passing', () => {
    expect(classifyRoundBudget({ history: [], currentHash: '' }).verdict).toBe(
      VERDICT_UNVERIFIABLE,
    );
  });
});

describe('formatVerdict', () => {
  it('carries the label and the reason', () => {
    const rendered = formatVerdict('terminal-state', {
      reason: '#423 is closed and merged',
    });
    expect(rendered).toContain('terminal-state');
    expect(rendered).toContain('#423 is closed and merged');
  });
});

describe('exit code shape', () => {
  it('exposes distinct, non-overlapping exit codes', () => {
    const codes = new Set([EXIT_OK, EXIT_GATE_REQUIRED, EXIT_UNVERIFIABLE]);
    expect(codes.size).toBe(3);
  });
});
