import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_GUIDE_CITATION_FLOOR,
  CitationFetchError,
  parseAdminGuideCitations,
  verifyCitationContent,
  verifyRemoteCitations,
  type AdminGuideCitation,
  type ParsedAdminGuideCitations,
} from '../scripts/check-admin-guide-citations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guide = readFileSync(
  path.join(root, 'docs', 'printer-calibration-admin-guide.md'),
  'utf8',
);

const PIN_A = '1'.repeat(40);
const PIN_B = '2'.repeat(40);
const PIN_HEAD = '3'.repeat(40);

const fixtureGuide = (citation = '7@11111111') => `# Guide

## 10. Contract

- **Pinned:** \`${PIN_A}\`
- **Contract snapshot:** \`${PIN_B}\`
- **Default-branch HEAD:** \`${PIN_HEAD}\`

### 10.1 Route

Symbol \`QueueJobAsync\` is at ${citation}.

Source: \`src/api/Controllers/JobQueueController.cs\`.

## 11. Next
`;

const headers = (remaining = '4999') =>
  new Headers({ 'x-ratelimit-remaining': remaining });

const response = (
  status: number,
  body: unknown,
  remaining = '4999',
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...Object.fromEntries(headers(remaining)),
      'content-type': 'application/json',
    },
  });

const fileResponse = (contents: string): Response =>
  response(200, {
    type: 'file',
    encoding: 'base64',
    size: Buffer.byteLength(contents),
    content: Buffer.from(contents).toString('base64'),
  });

const parsedFixture = (): ParsedAdminGuideCitations =>
  parseAdminGuideCitations(fixtureGuide());

const requestUrl = (input: string | URL | Request): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

const happyFetch = (overrides: Record<string, Response> = {}) =>
  vi.fn((input: string | URL | Request) => {
    const url = requestUrl(input);
    for (const [needle, value] of Object.entries(overrides)) {
      if (url.includes(needle)) return Promise.resolve(value.clone());
    }
    if (url.endsWith('/repos/OlyForge3D/PrintFarmer')) {
      return Promise.resolve(
        response(200, {
          full_name: 'OlyForge3D/PrintFarmer',
          default_branch: 'development',
        }),
      );
    }
    if (url.includes('PrintFarmer-citation-negative-control')) {
      return Promise.resolve(response(404, { message: 'Not Found' }));
    }
    if (url.includes(`/commits/${'0'.repeat(40)}`)) {
      return Promise.resolve(response(422, { message: 'No commit found' }));
    }
    if (url.includes('/commits/development')) {
      return Promise.resolve(response(200, { sha: PIN_HEAD }));
    }
    for (const pin of [PIN_A, PIN_B, PIN_HEAD]) {
      if (url.includes(`/commits/${pin}`)) {
        return Promise.resolve(response(200, { sha: pin }));
      }
      if (url.includes(`/compare/${pin}...${PIN_HEAD}`)) {
        return Promise.resolve(
          response(200, {
            status: pin === PIN_HEAD ? 'identical' : 'ahead',
            files: [],
          }),
        );
      }
    }
    if (url.includes('/contents/')) {
      return Promise.resolve(
        fileResponse(
          [
            'line 1',
            '',
            '',
            '',
            '',
            '',
            'public void QueueJobAsync()',
            '',
          ].join('\n'),
        ),
      );
    }
    throw new Error(`unexpected request ${url}`);
  });

describe('admin-guide section 10 citation grammar', () => {
  it('parses the live corpus above an absolute, printed floor', () => {
    const parsed = parseAdminGuideCitations(guide);

    expect(parsed.citations.length).toBeGreaterThanOrEqual(
      ADMIN_GUIDE_CITATION_FLOOR,
    );
    expect(parsed.pins.length).toBeGreaterThanOrEqual(3);
    expect(
      new Set(parsed.citations.map((citation) => citation.path)).size,
    ).toBeGreaterThanOrEqual(6);
    expect(
      parsed.citations.every(
        (citation) =>
          citation.anchor.length > 0 &&
          citation.path.startsWith('src/') &&
          citation.path.endsWith('.cs'),
      ),
    ).toBe(true);
  });

  it('resolves a bare filename only through a unique explicit section path', () => {
    const parsed = parseAdminGuideCitations(
      fixtureGuide().replace(
        'Source:',
        'Source: `JobQueueController.cs`, resolved by the explicit path',
      ),
    );

    expect(parsed.citations[0]?.path).toBe(
      'src/api/Controllers/JobQueueController.cs',
    );
  });

  it('does not count an unpinned filename-like prose mention as a citation', () => {
    const parsed = parseAdminGuideCitations(
      fixtureGuide().replace(
        '### 10.1 Route',
        'A design-only change mentioned DESIGN_SYSTEM.md.\n\n### 10.1 Route',
      ),
    );

    expect(parsed.citations).toHaveLength(1);
  });

  it('rejects an undeclared commit prefix instead of silently shrinking the corpus', () => {
    expect(() => parseAdminGuideCitations(fixtureGuide('7@abcdef12'))).toThrow(
      /resolves to 0 declared commit pins/,
    );
  });
});

describe('citation line, path, and commit mutations', () => {
  const citation = (): AdminGuideCitation => parsedFixture().citations[0]!;
  const content = [
    'line 1',
    '',
    '',
    '',
    '',
    '',
    'public void QueueJobAsync()',
    '',
  ].join('\n');

  it('accepts the exact cited line and anchor', () => {
    expect(verifyCitationContent(citation(), content)).toBeNull();
  });

  it('kills a line-number mutation', () => {
    expect(
      verifyCitationContent(
        { ...citation(), startLine: 6, endLine: 6 },
        content,
      ),
    ).toMatch(/does not contain anchor/);
  });

  it('does not let a range-wide anchor hide a shifted first line', () => {
    const repeated = [
      'line 1',
      '',
      '',
      '',
      '',
      'nearby context',
      'public void QueueJobAsync()',
      '',
    ].join('\n');

    expect(
      verifyCitationContent(
        { ...citation(), startLine: 6, endLine: 7 },
        repeated,
      ),
    ).not.toBeNull();
    expect(verifyCitationContent(citation(), repeated)).toBeNull();
  });

  it('kills a path mutation and names the broken citation', async () => {
    const parsed = parsedFixture();
    parsed.citations[0] = {
      ...parsed.citations[0]!,
      path: 'src/api/Controllers/MissingController.cs',
    };
    const fetchImpl = happyFetch({
      'MissingController.cs': response(404, { message: 'Not Found' }),
    });

    const result = await verifyRemoteCitations({
      parsed,
      token: 'default-token',
      fetchImpl,
    });

    expect(result.broken).toEqual([
      expect.stringContaining('MissingController.cs:7@11111111 is absent'),
    ]);
  });

  it('separates a stale commit mutation from a false citation', async () => {
    const fetchImpl = happyFetch({
      [`/compare/${PIN_A}...${PIN_HEAD}`]: response(200, {
        status: 'diverged',
        files: [],
      }),
    });

    const result = await verifyRemoteCitations({
      parsed: parsedFixture(),
      token: 'default-token',
      fetchImpl,
    });

    expect(result.stale).toEqual([expect.stringContaining('not an ancestor')]);
    expect(result.broken).toEqual([]);
  });

  it('reports a dead pinned-commit mutation only as staleness', async () => {
    const dead = '4'.repeat(40);
    const parsed = parseAdminGuideCitations(
      fixtureGuide('7@44444444').replace(PIN_A, dead),
    );
    const fetchImpl = happyFetch({
      [`/commits/${dead}`]: response(404, { message: 'No commit found' }),
    });

    const result = await verifyRemoteCitations({
      parsed,
      token: 'default-token',
      fetchImpl,
    });

    expect(result.stale).toEqual([
      expect.stringContaining(`${dead}: commit does not resolve`),
    ]);
    expect(result.broken).toEqual([]);
  });
});

describe('remote fetch controls and completeness', () => {
  it('runs positive and negative repository and commit controls on the live path', async () => {
    const fetchImpl = happyFetch();
    const result = await verifyRemoteCitations({
      parsed: parsedFixture(),
      token: 'default-token',
      fetchImpl,
    });

    expect(result.broken).toEqual([]);
    expect(result.stale).toEqual([]);
    const urls = fetchImpl.mock.calls.map(([url]) => requestUrl(url));
    expect(urls).toContain(
      'https://api.github.com/repos/OlyForge3D/PrintFarmer',
    );
    expect(
      urls.some((url) => url.includes('PrintFarmer-citation-negative-control')),
    ).toBe(true);
    expect(urls.some((url) => url.includes(`/commits/${PIN_HEAD}`))).toBe(true);
    expect(urls.some((url) => url.includes(`/commits/${'0'.repeat(40)}`))).toBe(
      true,
    );
  });

  it('refuses before partial work when the authenticated allowance is too small', async () => {
    const fetchImpl = happyFetch({
      '/repos/OlyForge3D/PrintFarmer': response(
        200,
        {
          full_name: 'OlyForge3D/PrintFarmer',
          default_branch: 'development',
        },
        '1',
      ),
    });

    await expect(
      verifyRemoteCitations({
        parsed: parsedFixture(),
        token: 'default-token',
        fetchImpl,
      }),
    ).rejects.toThrow(/complete follow-up reads are required/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a rate-limited response instead of turning it into a broken citation', async () => {
    const fetchImpl = happyFetch({
      '/commits/development': response(
        403,
        { message: 'API rate limit exceeded' },
        '0',
      ),
    });

    await expect(
      verifyRemoteCitations({
        parsed: parsedFixture(),
        token: 'default-token',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CitationFetchError);
  });

  it('refuses a server error while reading a pin instead of calling it stale', async () => {
    const fetchImpl = happyFetch({
      [`/commits/${PIN_A}`]: response(500, {
        message: 'Internal Server Error',
      }),
    });

    await expect(
      verifyRemoteCitations({
        parsed: parsedFixture(),
        token: 'default-token',
        fetchImpl,
      }),
    ).rejects.toThrow(/commit pin .*500 Internal Server Error/);
  });

  it('refuses empty or partial file payloads', async () => {
    const fetchImpl = happyFetch({
      '/contents/': response(200, {
        type: 'file',
        encoding: 'base64',
        size: 99,
        content: Buffer.from('short').toString('base64'),
      }),
    });

    await expect(
      verifyRemoteCitations({
        parsed: parsedFixture(),
        token: 'default-token',
        fetchImpl,
      }),
    ).rejects.toThrow(/empty or partial content/);
  });
});
