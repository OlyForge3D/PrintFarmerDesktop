// @vitest-environment node
/**
 * REAL server-route parity guard for calibration dispatch.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `tests/calibrationServerContractParity.test.ts` is named as if it verifies
 * server parity, but both sides of that comparison live inside this
 * repository: it parses `docs/printer-calibration-admin-guide.md` §10 (in
 * repo) and diffs it against `CALIBRATION_QUEUE_ROUTE_TEMPLATES` (in repo).
 * When the server changes, that test happily stays green until someone
 * remembers to update the admin guide by hand.
 *
 * This file closes the gap. When the sibling PrintFarmer server checkout is
 * on disk, we read the real `[HttpPost]`/`[HttpGet]` attributes off the C#
 * controllers and prove each template the desktop uses corresponds to a
 * route the server actually mounts. When the checkout is not present, the
 * test skips explicitly — the skip is loud, not silent, so nobody can claim
 * server parity has been verified without either the sibling repo or a live
 * probe.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CALIBRATION_QUEUE_ROUTE_TEMPLATES } from '../src/main/calibrationHttp.js';
import { resolveServerRepo } from './fixtures/server-contract/serverContractSnapshotDrift.js';

interface ServerRouteFact {
  file: string;
  verb: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  template: string;
}

/**
 * Read a C# controller and extract the routes it mounts. Handles files with
 * multiple controller classes: we walk the source, and each `[Route(...)]`
 * anchors the following actions until we see the next `[Route(...)]`.
 */
function extractControllerRoutes(
  repoRoot: string,
  relPath: string,
): ServerRouteFact[] {
  const abs = path.join(repoRoot, relPath);
  const source = readFileSync(abs, 'utf8');

  const anchorRe =
    /\[Route\("([^"]+)"\)\]|\[Http(Get|Post|Put|Delete|Patch)(?:\("([^"]*)"\))?\]/g;
  const facts: ServerRouteFact[] = [];
  let classRoute: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(source)) !== null) {
    if (match[1] !== undefined) {
      classRoute = match[1].replace(/^\/+/, '');
      continue;
    }
    if (classRoute === null) {
      // Action attribute before any class-level route — skip (shouldn't
      // happen for well-formed controllers).
      continue;
    }
    const rawVerb = match[2];
    if (rawVerb === undefined) continue;
    const verb = rawVerb.toUpperCase() as ServerRouteFact['verb'];
    const actionPath = match[3] ?? '';
    const template = actionPath
      ? `/${classRoute}/${actionPath.replace(/^\/+/, '')}`
      : `/${classRoute}`;
    facts.push({ file: relPath, verb, template });
  }
  if (classRoute === null) {
    throw new Error(
      `extractControllerRoutes: no class-level [Route] attribute found in ${relPath}`,
    );
  }
  return facts;
}

/**
 * Normalise a route template into a wildcard shape so placeholder NAMES don't
 * cause spurious mismatches. The desktop uses `{jobId}` where the server uses
 * `{id}`; both are the same route for an HTTP client that interpolates a real
 * GUID. We compare structurally (segment count + literal segments), not by
 * placeholder identifier.
 */
function normaliseServerTemplate(template: string): string {
  return template
    .replace(/\{[^}]+\}/g, '{*}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function normaliseDesktopTemplate(template: string): string {
  return template
    .replace(/\{[^}]+\}/g, '{*}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

describe('calibration dispatch — desktop templates ↔ real server routes', () => {
  const serverRepo = resolveServerRepo();

  it(
    serverRepo === null
      ? 'skips: PrintFarmer server checkout not present at D:\\\\s\\\\pfarm1 (set PRINTFARMER_SERVER_REPO to enable)'
      : 'every desktop CALIBRATION_QUEUE_ROUTE_TEMPLATES entry corresponds to a real server route',
    () => {
      if (serverRepo === null) {
        // Deliberately no-op — see message above. This is not a substitute
        // for a live probe; it is a hedge for CI environments without the
        // sibling checkout. The desktop-side parity test still runs.
        return;
      }

      const controllerFiles = [
        'src/api/Controllers/JobQueueController.cs',
        'src/api/Controllers/CalibrationGenerationController.cs',
      ];

      const serverFacts: ServerRouteFact[] = [];
      for (const rel of controllerFiles) {
        const abs = path.join(serverRepo, rel);
        try {
          readFileSync(abs, 'utf8');
        } catch {
          // A controller file being absent is a real parity concern —
          // report it clearly rather than trying to guess where the route
          // moved.
          throw new Error(
            `Server controller expected at ${rel} but not found in ${serverRepo}; ` +
              'update this parity test after resolving the route ownership.',
          );
        }
        serverFacts.push(...extractControllerRoutes(serverRepo, rel));
      }
      const serverTemplates = new Set(
        serverFacts.map((f) => normaliseServerTemplate(f.template)),
      );

      const desktopTemplates = Object.entries(
        CALIBRATION_QUEUE_ROUTE_TEMPLATES,
      );
      const missing = desktopTemplates.filter(
        ([, template]) =>
          !serverTemplates.has(normaliseDesktopTemplate(template)),
      );
      expect(
        missing.map(([name, template]) => `${name}: ${template}`),
        `Desktop routes not present in server: the desktop will POST/GET to a URL the server does not mount.`,
      ).toEqual([]);
    },
  );

  // Control: a desktop template we know cannot exist on the server (a decoy
  // route) MUST be flagged as missing. Same predicate, same data, opposite
  // expected result — proving the assertion above is load-bearing and not
  // silently passing on an empty comparison.
  it('control (server-shape): a fabricated desktop route is flagged as missing', () => {
    if (serverRepo === null) return;

    const controllerFiles = [
      'src/api/Controllers/JobQueueController.cs',
      'src/api/Controllers/CalibrationGenerationController.cs',
    ];
    const serverFacts: ServerRouteFact[] = [];
    for (const rel of controllerFiles) {
      serverFacts.push(...extractControllerRoutes(serverRepo, rel));
    }
    const serverTemplates = new Set(
      serverFacts.map((f) => normaliseServerTemplate(f.template)),
    );

    const decoyDesktopTemplates = {
      ...CALIBRATION_QUEUE_ROUTE_TEMPLATES,
      // Fabricated — no controller mounts this path. If the assertion in the
      // preceding test is silently passing on an empty diff, this decoy would
      // also pass. It must not.
      fabricatedDecoy: '/api/definitely-not-a-real-endpoint',
    };
    const missing = Object.entries(decoyDesktopTemplates).filter(
      ([, template]) =>
        !serverTemplates.has(normaliseDesktopTemplate(template)),
    );
    expect(missing.map(([name]) => name)).toEqual(['fabricatedDecoy']);
  });
});
