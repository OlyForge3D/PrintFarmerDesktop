// Verifies the machine-resolvable `line@commit` citations in admin-guide section 10
// against the public OlyForge3D/PrintFarmer repository.
//
// Citation grammar:
//   - The corpus is section `## 10.` through the next level-two heading.
//   - A citation is a decimal line or inclusive line range followed by `@` and a
//     7-40 character hexadecimal prefix, for example `95@167a3b13` or
//     `19-20@167a3b13`.
//   - The prefix must resolve unambiguously to a full SHA declared in section 10's
//     introductory pin list.
//   - The cited path is a `src/.../*.cs` path in the same subsection. A bare
//     `Foo.cs` is accepted only when its basename uniquely identifies one of those
//     explicit paths. Filename-like prose with no `line@commit` is not a citation.
//   - The nearest code/symbol token before the line reference is the content
//     anchor. The exact cited range must contain that anchor.
//
// The corpus floor is therefore a floor over parsed path+line+commit+anchor rows,
// not over filenames, SHAs, or prose mentions. It is intentionally local to this
// corpus; citation-corpus.mjs shares the refusal mechanism, never this number.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INCONCLUSIVE,
  loadCorpus,
  requireCorpusFloor,
  requireScanRoots,
} from './citation-corpus.mjs';

export const GUIDE_PATH = 'docs/printer-calibration-admin-guide.md';
export const SERVER_REPOSITORY = 'OlyForge3D/PrintFarmer';
export const ADMIN_GUIDE_CITATION_FLOOR = 20;

const API_ROOT = 'https://api.github.com';
const FULL_PATH = /\b(src\/[A-Za-z0-9_./-]+\.cs)\b/g;
const LINE_CITATION =
  /\b(?:lines?\s+)?(\d+)(?:\s*[-\u2013]\s*(\d+))?@([0-9a-f]{7,40})\b/g;
const FULL_SHA = /`([0-9a-f]{40})`/g;

export class CitationParseError extends Error {}
export class CitationFetchError extends Error {}

export function section10Of(guide) {
  const start = guide.search(/^## 10\.\s+/m);
  if (start < 0)
    throw new CitationParseError('admin guide section 10 is absent');
  const rest = guide.slice(start);
  const next = rest.slice(1).search(/^##\s+/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const unique = (values) => [...new Set(values)];

const pathsIn = (text) =>
  unique([...text.matchAll(FULL_PATH)].map((match) => match[1]));

const paragraphsAround = (text, offset) => {
  let start = text.lastIndexOf('\n\n', offset);
  let end = text.indexOf('\n\n', offset);
  if (start < 0) start = 0;
  else start += 2;
  if (end < 0) end = text.length;
  return text.slice(start, end);
};

const lineAround = (text, offset) => {
  const start = text.lastIndexOf('\n', offset);
  const end = text.indexOf('\n', offset);
  return text.slice(start < 0 ? 0 : start + 1, end < 0 ? text.length : end);
};

const subsectionAt = (section, offset) => {
  const headings = [...section.matchAll(/^###\s+/gm)];
  const start =
    headings.filter((heading) => (heading.index ?? 0) <= offset).at(-1)
      ?.index ?? 0;
  const next = headings.find((heading) => (heading.index ?? 0) > offset)?.index;
  return section.slice(start, next ?? section.length);
};

const matchingPathsIn = (context, allPaths) => {
  const basenames = [
    ...context.matchAll(/\b([A-Za-z][A-Za-z0-9_]+\.cs)\b/g),
  ].map((match) => match[1]);
  const qualifiedTypes = [
    ...context.matchAll(/\b([A-Z][A-Za-z0-9_]+)\.[A-Za-z_][A-Za-z0-9_]*\b/g),
  ].map((match) => `${match[1]}.cs`);
  return unique([...basenames, ...qualifiedTypes]).flatMap((basename) =>
    allPaths.filter((candidate) => path.posix.basename(candidate) === basename),
  );
};

const lastMentionedPath = (section, offset, allPaths) => {
  const before = section.slice(0, offset);
  const mentions = [];
  for (const candidate of allPaths) {
    for (const spelling of [candidate, path.posix.basename(candidate)]) {
      let at = before.lastIndexOf(spelling);
      if (at >= 0) mentions.push({ at, candidate });
    }
  }
  return mentions.sort((left, right) => left.at - right.at).at(-1)?.candidate;
};

const nearestContextPath = (context, citationOffset, allPaths) => {
  const mentions = [];
  for (const candidate of allPaths) {
    for (const spelling of [candidate, path.posix.basename(candidate)]) {
      for (const match of context.matchAll(
        new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      )) {
        mentions.push({
          distance: Math.abs((match.index ?? 0) - citationOffset),
          candidate,
        });
      }
    }
  }
  return mentions.sort((left, right) => left.distance - right.distance).at(0)
    ?.candidate;
};

const nearestPriorExplicitPath = (context, citationOffset) => {
  const before = context.slice(0, citationOffset);
  return [...before.matchAll(FULL_PATH)].at(-1)?.[1];
};

const resolvePath = ({ section, offset, context, anchor }) => {
  const allPaths = pathsIn(section);
  const rowPaths = pathsIn(lineAround(section, offset));
  if (rowPaths.length === 1) return rowPaths[0];

  const contextOffset = offset - section.indexOf(context);
  const priorExplicit = nearestPriorExplicitPath(context, contextOffset);
  if (priorExplicit !== undefined) return priorExplicit;

  const localPaths = pathsIn(context);
  if (localPaths.length === 1) return localPaths[0];

  const rowMatching = unique(
    matchingPathsIn(lineAround(section, offset), allPaths),
  );
  if (rowMatching.length === 1) return rowMatching[0];

  const owner = new RegExp(
    `\\b([A-Z][A-Za-z0-9_]+)\\.${anchor.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    )}\\b`,
  ).exec(subsectionAt(section, offset))?.[1];
  if (owner !== undefined) {
    const owned = allPaths.filter(
      (candidate) => path.posix.basename(candidate) === `${owner}.cs`,
    );
    if (owned.length === 1) return owned[0];
  }

  const nearestContext = nearestContextPath(context, contextOffset, allPaths);
  if (nearestContext !== undefined) return nearestContext;

  const precedingMatching = unique(
    matchingPathsIn(context.slice(0, contextOffset), allPaths),
  );
  if (precedingMatching.length > 0) return precedingMatching.at(-1);

  const matching = matchingPathsIn(context, allPaths);
  const distinctMatching = unique(matching);
  if (distinctMatching.length === 1) return distinctMatching[0];

  const subsectionPaths = pathsIn(subsectionAt(section, offset));
  if (subsectionPaths.length === 1) return subsectionPaths[0];

  const nearest = lastMentionedPath(section, offset, allPaths);
  if (nearest !== undefined) return nearest;

  throw new CitationParseError(
    `citation near ${JSON.stringify(context.trim())} has ${
      distinctMatching.length || subsectionPaths.length
    } possible server paths`,
  );
};

const anchorBefore = (context, citationOffset) => {
  const before = context.slice(0, citationOffset);
  const tokens = [...before.matchAll(/`([^`\n]+)`|_([A-Za-z][A-Za-z0-9_]*)_/g)]
    .map((match) => ({
      value: match[1] ?? match[2],
      index: match.index ?? 0,
    }))
    .filter(({ value }) => {
      if (value === undefined) return false;
      if (value.includes('/') || value.endsWith('.cs')) return false;
      if (/^[0-9a-f]{7,40}$/.test(value)) return false;
      if (/^\d/.test(value)) return false;
      return /[A-Za-z_]/.test(value);
    });
  const token = tokens.at(-1)?.value;
  if (token === undefined) {
    throw new CitationParseError(
      `citation near ${JSON.stringify(context.trim())} has no content anchor`,
    );
  }
  const qualified = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(token)?.[1];
  return qualified ?? token;
};

export function parseAdminGuideCitations(guide) {
  const section = section10Of(guide);
  const pins = unique(
    [...section.slice(0, section.indexOf('### 10.1')).matchAll(FULL_SHA)].map(
      (match) => match[1],
    ),
  );
  if (pins.length < 3) {
    throw new CitationParseError(
      `section 10 declares only ${pins.length} full commit pins; expected at least 3`,
    );
  }

  const citations = [];
  for (const match of section.matchAll(LINE_CITATION)) {
    const offset = match.index ?? 0;
    const context = paragraphsAround(section, offset);
    const contextOffset = offset - section.indexOf(context);
    const prefix = match[3];
    const commits = pins.filter((pin) => pin.startsWith(prefix));
    if (commits.length !== 1) {
      throw new CitationParseError(
        `${match[0]} resolves to ${commits.length} declared commit pins`,
      );
    }
    const startLine = Number(match[1]);
    const endLine = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    ) {
      throw new CitationParseError(`invalid line range in ${match[0]}`);
    }
    const anchor = anchorBefore(context, contextOffset);
    citations.push({
      raw: match[0],
      path: resolvePath({ section, offset, context, anchor }),
      commit: commits[0],
      startLine,
      endLine,
      anchor,
    });
  }

  return { section, pins, citations };
}

export function verifyCitationContent(citation, contents) {
  if (contents.length === 0) {
    return `${citation.path}@${citation.commit.slice(0, 8)} returned an empty file`;
  }
  const lines = contents.split(/\r?\n/);
  if (citation.endLine > lines.length) {
    return `${citation.path}:${citation.raw} exceeds the file's ${lines.length} lines`;
  }
  const cited = lines
    .slice(citation.startLine - 1, citation.endLine)
    .join('\n');
  if (!cited.includes(citation.anchor)) {
    return `${citation.path}:${citation.raw} does not contain anchor ${JSON.stringify(
      citation.anchor,
    )}`;
  }
  return null;
}

const responseMessage = async (response) => {
  try {
    const body = await response.json();
    return typeof body?.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
};

const rateLimited = (response, message) =>
  response.status === 429 ||
  (response.status === 403 &&
    (response.headers.get('x-ratelimit-remaining') === '0' ||
      /rate limit|abuse detection/i.test(message)));

async function requestJson(fetchImpl, url, token, purpose) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
  } catch (error) {
    throw new CitationFetchError(`${purpose}: ${error.message}`);
  }
  if (!response.ok) {
    const message = await responseMessage(response);
    if (rateLimited(response, message)) {
      throw new CitationFetchError(
        `${purpose}: GitHub rate limit prevented a complete read (${response.status} ${message})`,
      );
    }
    return { response, body: null, message };
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new CitationFetchError(
      `${purpose}: malformed JSON (${error.message})`,
    );
  }
  return { response, body, message: '' };
}

const endpoint = (suffix) =>
  `${API_ROOT}/repos/${SERVER_REPOSITORY}${suffix ? `/${suffix}` : ''}`;

export async function verifyRemoteCitations({
  parsed,
  token,
  fetchImpl = fetch,
}) {
  const repoRead = await requestJson(
    fetchImpl,
    endpoint(''),
    token,
    'positive repository control',
  );
  if (
    repoRead.response.status !== 200 ||
    repoRead.body?.full_name !== SERVER_REPOSITORY
  ) {
    throw new CitationFetchError(
      `positive repository control returned ${repoRead.response.status}`,
    );
  }
  const remaining = Number(
    repoRead.response.headers.get('x-ratelimit-remaining'),
  );
  const uniqueFiles = unique(
    parsed.citations.map((citation) => `${citation.commit}:${citation.path}`),
  );
  const plannedRequests = 3 + parsed.pins.length * 2 + uniqueFiles.length;
  if (!Number.isSafeInteger(remaining) || remaining < plannedRequests) {
    throw new CitationFetchError(
      `rate-limit allowance is ${String(
        repoRead.response.headers.get('x-ratelimit-remaining'),
      )}; ${plannedRequests} complete follow-up reads are required`,
    );
  }

  const missingRepo = await requestJson(
    fetchImpl,
    `${API_ROOT}/repos/OlyForge3D/PrintFarmer-citation-negative-control`,
    token,
    'negative repository control',
  );
  if (missingRepo.response.status !== 404) {
    throw new CitationFetchError(
      `negative repository control returned ${missingRepo.response.status}, expected 404`,
    );
  }

  const headRead = await requestJson(
    fetchImpl,
    endpoint(`commits/${repoRead.body.default_branch}`),
    token,
    'positive commit control',
  );
  if (
    headRead.response.status !== 200 ||
    !/^[0-9a-f]{40}$/.test(headRead.body?.sha ?? '')
  ) {
    throw new CitationFetchError(
      `positive commit control returned ${headRead.response.status} without a full SHA`,
    );
  }
  const remoteHead = headRead.body.sha;

  const missingCommit = await requestJson(
    fetchImpl,
    endpoint(`commits/${'0'.repeat(40)}`),
    token,
    'negative commit control',
  );
  if (![404, 422].includes(missingCommit.response.status)) {
    throw new CitationFetchError(
      `negative commit control returned ${missingCommit.response.status}, expected 404 or 422`,
    );
  }

  const stale = [];
  const unresolvedPins = new Set();
  for (const pin of parsed.pins) {
    const pinRead = await requestJson(
      fetchImpl,
      endpoint(`commits/${pin}`),
      token,
      `commit pin ${pin}`,
    );
    if (pinRead.response.status !== 200 || pinRead.body?.sha !== pin) {
      stale.push(`${pin}: commit does not resolve`);
      unresolvedPins.add(pin);
      continue;
    }
    const ancestry = await requestJson(
      fetchImpl,
      endpoint(`compare/${pin}...${remoteHead}`),
      token,
      `ancestry for ${pin}`,
    );
    if (ancestry.response.status !== 200) {
      throw new CitationFetchError(
        `ancestry for ${pin}: ${ancestry.response.status} ${ancestry.message}`,
      );
    }
    // Only the compare status is consumed. Its files array is capped at 300 and
    // is deliberately ignored; deletion/path truth comes from pinned contents.
    if (!['ahead', 'identical'].includes(ancestry.body?.status)) {
      stale.push(
        `${pin}: not an ancestor of ${repoRead.body.default_branch} (${String(
          ancestry.body?.status,
        )})`,
      );
    }
  }

  const files = new Map();
  for (const key of uniqueFiles) {
    const separator = key.indexOf(':');
    const commit = key.slice(0, separator);
    const filePath = key.slice(separator + 1);
    if (unresolvedPins.has(commit)) continue;
    const read = await requestJson(
      fetchImpl,
      endpoint(
        `contents/${filePath
          .split('/')
          .map(encodeURIComponent)
          .join('/')}?ref=${commit}`,
      ),
      token,
      `citation file ${filePath}@${commit}`,
    );
    if (read.response.status === 404) {
      files.set(key, null);
      continue;
    }
    if (
      read.response.status !== 200 ||
      read.body?.type !== 'file' ||
      read.body?.encoding !== 'base64' ||
      typeof read.body?.content !== 'string'
    ) {
      throw new CitationFetchError(
        `citation file ${filePath}@${commit}: incomplete response`,
      );
    }
    const decoded = Buffer.from(
      read.body.content.replace(/\s/g, ''),
      'base64',
    ).toString('utf8');
    if (decoded.length === 0 || Buffer.byteLength(decoded) !== read.body.size) {
      throw new CitationFetchError(
        `citation file ${filePath}@${commit}: empty or partial content (${Buffer.byteLength(
          decoded,
        )}/${String(read.body.size)} bytes)`,
      );
    }
    files.set(key, decoded);
  }

  const broken = [];
  for (const citation of parsed.citations) {
    if (unresolvedPins.has(citation.commit)) continue;
    const contents = files.get(`${citation.commit}:${citation.path}`);
    if (contents === null || contents === undefined) {
      broken.push(
        `${citation.path}:${citation.raw} is absent at ${citation.commit}`,
      );
      continue;
    }
    const finding = verifyCitationContent(citation, contents);
    if (finding !== null) broken.push(finding);
  }

  return {
    broken,
    stale,
    remoteHead,
    remaining,
    requestsRequired: plannedRequests,
    uniqueFiles: uniqueFiles.length,
  };
}

export async function main() {
  const sources = requireScanRoots(loadCorpus([GUIDE_PATH]));
  const guide = sources.get(GUIDE_PATH);
  const parsed = parseAdminGuideCitations(guide);
  requireCorpusFloor({
    count: parsed.citations.length,
    floor: ADMIN_GUIDE_CITATION_FLOOR,
    subject: 'parsed section-10 path+line+commit+anchor citations',
  });
  console.log(
    `admin-guide corpus: ${parsed.citations.length} citations, ${parsed.pins.length} pins, floor ${ADMIN_GUIDE_CITATION_FLOOR}`,
  );

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new CitationFetchError(
      'GITHUB_TOKEN is required; this check uses only the workflow default token and no secret',
    );
  }
  const result = await verifyRemoteCitations({ parsed, token });
  console.log(
    `remote corpus: ${result.uniqueFiles} pinned files; allowance ${result.remaining}, required ${result.requestsRequired}; head ${result.remoteHead}`,
  );

  for (const finding of result.stale) console.error(`STALE PIN: ${finding}`);
  for (const finding of result.broken)
    console.error(`FALSE CITATION: ${finding}`);
  if (result.stale.length > 0 || result.broken.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    'OK - every parsed admin-guide section-10 server citation resolves at its pinned path, line, and anchor.',
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    if (
      error instanceof CitationFetchError ||
      error instanceof CitationParseError
    ) {
      console.error(`INCONCLUSIVE: ${error.message}`);
      process.exitCode = INCONCLUSIVE;
      return;
    }
    throw error;
  });
}
