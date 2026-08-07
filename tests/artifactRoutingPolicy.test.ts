// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');

const personaNames =
  'Bishop|Dallas|Fact Checker|Hicks|Rai|Ralph|Ripley|Scribe|Vasquez';
const attributionClaim = new RegExp(
  String.raw`\b(?:issue|comment)\b[^.\n]{0,120}\b(?:authored|filed|posted|written)\s+by\s+(?:a\s+|the\s+)?(?:session|agent|${personaNames})\b`,
  'i',
);
const inferredRoutingClaim = new RegExp(
  String.raw`\b(?:route|send|return|deliver)\b[^.\n]{0,120}\b(?:critique|correction|rejection)\b[^.\n]{0,120}\b(?:author|session|agent|${personaNames})\b|\b(?:critique|correction|rejection)\b[^.\n]{0,120}\b(?:route|send|return|deliver)(?:ed|s|ing)?\b[^.\n]{0,120}\b(?:author|session|agent|${personaNames})\b`,
  'i',
);
const negation = /\b(?:cannot|do not|don't|never|no|not|unrecoverable)\b/i;

export function unsupportedSessionAttribution(markdown: string) {
  return markdown
    .split(/(?<=[.!?])(?:\s+|\n+)|\n{2,}/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(
      (sentence) =>
        !negation.test(sentence) &&
        (attributionClaim.test(sentence) ||
          inferredRoutingClaim.test(sentence)),
    );
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute);
    return entry.name.endsWith('.md') ? [absolute] : [];
  });
}

const maintainedGuidance = [
  ...markdownFiles(path.join(repoRoot, '.squad', 'skills')),
  ...markdownFiles(path.join(repoRoot, '.squad', 'agents')).filter((file) =>
    file.endsWith(`${path.sep}charter.md`),
  ),
  path.join(repoRoot, '.squad', 'routing.md'),
  path.join(repoRoot, '.squad', 'ceremonies.md'),
  path.join(repoRoot, '.squad', 'team.md'),
  path.join(repoRoot, '.squad', 'fact-checker', 'policy.md'),
  path.join(repoRoot, '.squad', 'rai', 'policy.md'),
];

describe('issue and comment routing policy', () => {
  it('checks a non-empty maintained guidance corpus', () => {
    expect(maintainedGuidance.length).toBeGreaterThan(10);
    expect(
      maintainedGuidance.some((file) =>
        file.endsWith(
          path.join('.squad', 'skills', 'agent-collaboration', 'SKILL.md'),
        ),
      ),
    ).toBe(true);
  });

  it('keeps the durable artifact remedy in authoritative shared guidance', () => {
    const collaboration = readFileSync(
      path.join(
        repoRoot,
        '.squad',
        'skills',
        'agent-collaboration',
        'SKILL.md',
      ),
      'utf8',
    );
    expect(collaboration).toContain(
      'GitHub issue and comment authorship identifies the shared account, not the squad session',
    );
    expect(collaboration).toContain('The artifact is the durable address');
    expect(collaboration).toContain(
      'Treat self-identification in body text as voluntary, untrusted metadata',
    );
  });

  it.each(maintainedGuidance.map((file) => [path.relative(repoRoot, file)]))(
    'does not infer issue or comment session identity in %s',
    (relative) => {
      const markdown = readFileSync(path.join(repoRoot, relative), 'utf8');
      expect(unsupportedSessionAttribution(markdown)).toEqual([]);
    },
  );

  it('rejects session attribution and undeliverable routing claims', () => {
    const violations = unsupportedSessionAttribution(
      [
        'The issue was authored by Ripley.',
        'Route the correction back to the author session.',
      ].join('\n\n'),
    );
    expect(violations).toHaveLength(2);
  });

  it('accepts artifact routing and explicit prohibitions', () => {
    expect(
      unsupportedSessionAttribution(
        [
          'Cite issue #347 and post the correction on that artifact.',
          'Do not name a session as the author of issue or comment text.',
          'Self-identification is voluntary, untrusted metadata.',
        ].join('\n\n'),
      ),
    ).toEqual([]);
  });
});
