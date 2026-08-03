// @vitest-environment node

/**
 * Reference integrity for the calibration operator documentation (issue #160).
 *
 * Issue #160's last acceptance criterion: "a docs test that extracts referenced
 * command names and log field names from the runbooks and fails on any that is
 * not present in the repo."
 *
 * ## Why this test is shaped the way it is
 *
 * An extractor that extracts nothing satisfies "no unknown references found".
 * So does one whose pattern stops matching after a heading style changes, one
 * pointed at a renamed directory, and one that resolves to zero runbook files.
 * In every case the suite stays green and the guarantee is gone — silently.
 *
 * Four structural defences, in the order they would fail:
 *
 * 1. **The file set is named, not globbed, and checked from both sides.** A
 *    glob that drifts resolves to fewer files and still passes every "no
 *    unknown token" assertion. The named list is pinned to a cardinality, every
 *    entry must exist on disk, and no `.md` on disk may be absent from the
 *    list. This is the pattern established by `tests/calibrationLogPolicy.test.ts`.
 * 2. **The extraction itself has a floor.** The distinct field, event and
 *    channel counts pulled out of the docs must clear a plausible minimum, so
 *    an extractor that silently matches nothing fails loudly rather than
 *    reporting a clean bill of health.
 * 3. **A positive control.** A fixture referencing a field, an event, a channel
 *    and a script that do *not* exist is fed to the same extractor and every
 *    one must be reported. Without it, "no unknown references" is
 *    indistinguishable from "the extractor found nothing".
 * 4. **Every failure names the file and the token.** An operator-facing docs
 *    test whose failure reads `expected [] to deeply equal [...]` costs the
 *    next person an hour.
 *
 * ## What counts as a reference
 *
 * The docs are prose, so the extractor keys off inline code spans and then
 * classifies by shape:
 *
 * - `calibration:someChannel` — an IPC channel; must be a value of `IpcChannel`.
 * - `some.dottedName` — a structured log `component` or `event`; must appear in
 *   the calibration main-process source.
 * - `someCamelCaseName` — a log field or contract field; must be a member of the
 *   vocabulary assembled from `calibrationLog.ts` and the shared IPC schemas.
 * - `npm run something` — must be a script in package.json.
 *
 * Anything else in an inline code span (paths, SQL, SCREAMING_CASE constants,
 * lowercase words, hyphenated placeholders) is deliberately not a reference and
 * is not checked. That is a real limit of this test, stated rather than hidden:
 * it constrains the identifier shapes an operator would grep for, not every
 * word in the documents.
 */

import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IpcChannel,
  CalibrationAvailability,
  CalibrationCapabilitySnapshot,
  CalibrationCapabilityFlags,
  CalibrationGetDiagnosticsResponse,
  CalibrationLastSyncSnapshot,
  CalibrationOrchestrationStatus,
  CalibrationOutboxSnapshot,
  CalibrationPrinterCandidate,
  CalibrationPrinterContext,
  CalibrationPrinterEligibility,
  CalibrationQueueJobState,
  CalibrationQueueState,
  CalibrationStartPrintRequest,
  CalibrationUnavailableReason,
} from '@shared/ipc';
import type { ZodTypeAny } from 'zod';
import {
  CALIBRATION_CORRELATION_ORIGINS,
  CALIBRATION_LOG_COMPONENTS,
  CALIBRATION_LOG_ERROR_CODES,
  CALIBRATION_LOG_FIELDS,
  CALIBRATION_LOG_OUTCOMES,
} from '../src/main/calibrationLog.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const docsDir = path.join(repoRoot, 'docs');
const runbookDir = path.join(docsDir, 'runbooks');
const mainDir = path.join(repoRoot, 'src', 'main');

// --- The documented surface, named rather than globbed ----------------------

/** The seven scenarios issue #160 names. Written out; see the module docblock. */
const RUNBOOKS: readonly string[] = [
  'failed-migration.md',
  'unhealthy-worker.md',
  'stuck-orchestration.md',
  'uncertain-printer-start.md',
  'stale-dispatch-lease.md',
  'profile-restore.md',
  'interrupted-import.md',
];

/** Pinned so deleting a runbook is loud rather than merely smaller. */
const EXPECTED_RUNBOOK_COUNT = 7;

const ADMIN_GUIDE = 'printer-calibration-admin-guide.md';

/** The five sections every runbook must have, in this order and no others. */
const REQUIRED_SECTIONS: readonly string[] = [
  'Trigger',
  'Diagnose',
  'Recover',
  'Verify',
  'If this fails',
];

// --- Vocabulary assembled from the repo -------------------------------------

/**
 * The calibration modules scanned for structured event names. Named for the
 * same reason the runbook list is: a glob that drifts scans fewer files, finds
 * fewer events, and turns a real reference into an unknown one — or, worse,
 * finds none and makes the floor assertion the only thing standing.
 */
const EVENT_SOURCE_FILES: readonly string[] = [
  'ipc.ts',
  'syncEngine.ts',
  'serverProfiles.ts',
  'sidecar.ts',
  'calibrationEngine.ts',
];

/** A dotted lowercase-first identifier: `sync.failed`, `calibration.http`. */
const DOTTED = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/;
const DOTTED_LITERAL = /'([a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+)'/g;

/**
 * Structured event names as the source actually emits them.
 *
 * Scans lines carrying an `event:` key and takes every dotted string literal on
 * that line, because one call site chooses its event with a ternary
 * (`event: outcome === 'failed' ? 'sync.failed' : 'sync.completed'`) and a
 * regex anchored to `event: '` would miss both halves of it.
 */
function emittedEventNames(): Set<string> {
  const events = new Set<string>();
  for (const file of EVENT_SOURCE_FILES) {
    const source = readFileSync(path.join(mainDir, file), 'utf8');
    for (const line of source.split('\n')) {
      if (!line.includes('event:')) continue;
      for (const match of line.matchAll(DOTTED_LITERAL)) events.add(match[1]!);
    }
  }
  return events;
}

/**
 * Every key reachable in a Zod schema, including nested objects and arrays.
 *
 * Reads the field names out of the contract itself rather than restating them,
 * so a renamed contract field turns every document that names it into a
 * failure instead of leaving the documentation quietly wrong.
 */
function collectSchemaKeys(schema: ZodTypeAny, into: Set<string>): void {
  const definition = schema._def as {
    typeName?: string;
    shape?: () => Record<string, ZodTypeAny>;
    innerType?: ZodTypeAny;
    type?: ZodTypeAny;
    schema?: ZodTypeAny;
    options?: ZodTypeAny[];
  };
  switch (definition.typeName) {
    case 'ZodObject': {
      const shape = definition.shape?.() ?? {};
      for (const [key, child] of Object.entries(shape)) {
        into.add(key);
        collectSchemaKeys(child, into);
      }
      return;
    }
    case 'ZodArray':
      if (definition.type) collectSchemaKeys(definition.type, into);
      return;
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      if (definition.innerType) collectSchemaKeys(definition.innerType, into);
      return;
    case 'ZodEffects':
      if (definition.schema) collectSchemaKeys(definition.schema, into);
      return;
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      for (const option of definition.options ?? []) {
        collectSchemaKeys(option, into);
      }
      return;
    default:
      return;
  }
}

/** Contract schemas an operator-facing document may name a field from. */
const CONTRACT_SCHEMAS: readonly ZodTypeAny[] = [
  CalibrationAvailability,
  CalibrationCapabilityFlags,
  CalibrationCapabilitySnapshot,
  CalibrationOutboxSnapshot,
  CalibrationLastSyncSnapshot,
  CalibrationGetDiagnosticsResponse,
  CalibrationOrchestrationStatus,
  CalibrationPrinterCandidate,
  CalibrationPrinterContext,
  CalibrationPrinterEligibility,
  CalibrationQueueJobState,
  CalibrationQueueState,
  CalibrationStartPrintRequest,
];

/** Every camelCase identifier an operator may legitimately be told to read. */
function knownFieldNames(): Set<string> {
  const names = new Set<string>([
    ...CALIBRATION_LOG_FIELDS,
    ...CALIBRATION_LOG_ERROR_CODES,
    ...CALIBRATION_CORRELATION_ORIGINS,
    ...CALIBRATION_LOG_OUTCOMES,
    ...CalibrationUnavailableReason.options,
  ]);
  for (const schema of CONTRACT_SCHEMAS) collectSchemaKeys(schema, names);
  return names;
}

function knownDottedNames(): Set<string> {
  return new Set<string>([
    ...CALIBRATION_LOG_COMPONENTS,
    ...emittedEventNames(),
  ]);
}

function knownChannels(): Set<string> {
  return new Set<string>(Object.values(IpcChannel));
}

function knownScripts(): Set<string> {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  return new Set<string>(Object.keys(manifest.scripts ?? {}));
}

// --- Extraction -------------------------------------------------------------

/** An inline code span. Fenced blocks are stripped before this runs. */
const CODE_SPAN = /`([^`\n]+)`/g;
/** `someCamelCaseName` — at least one internal capital, no separators. */
const CAMEL_FIELD = /^[a-z]+(?:[A-Z0-9][A-Za-z0-9]*)+$/;
const CHANNEL = /^calibration:[A-Za-z]+$/;
const NPM_SCRIPT = /^npm run ([A-Za-z0-9:_-]+)$/;

export interface DocReferences {
  fields: string[];
  dotted: string[];
  channels: string[];
  scripts: string[];
}

/** Classify every inline code span in a document. Fenced blocks are excluded. */
export function extractReferences(markdown: string): DocReferences {
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  const references: DocReferences = {
    fields: [],
    dotted: [],
    channels: [],
    scripts: [],
  };
  for (const match of prose.matchAll(CODE_SPAN)) {
    const token = match[1]!.trim();
    const script = NPM_SCRIPT.exec(token);
    if (script !== null) {
      references.scripts.push(script[1]!);
    } else if (CHANNEL.test(token)) {
      references.channels.push(token);
    } else if (DOTTED.test(token)) {
      references.dotted.push(token);
    } else if (CAMEL_FIELD.test(token)) {
      references.fields.push(token);
    }
  }
  return references;
}

// --- Fixtures ---------------------------------------------------------------

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

function runbookPath(name: string): string {
  return path.join(runbookDir, name);
}

const DOCUMENTS: readonly { label: string; file: string }[] = [
  { label: `docs/${ADMIN_GUIDE}`, file: path.join(docsDir, ADMIN_GUIDE) },
  ...RUNBOOKS.map((name) => ({
    label: `docs/runbooks/${name}`,
    file: runbookPath(name),
  })),
];

/**
 * A document referencing four things that do not exist, plus one of each kind
 * that does. Drives the positive control below.
 */
const PLANTED_DOC = [
  '# Planted',
  '',
  'Read `calibrationSessionId` from the record and check `correlationId` too.',
  'Look for `sync.neverEmitted` alongside `sync.failed`.',
  'Call `calibration:bogusChannel`, not `calibration:getDiagnostics`.',
  'Run `npm run definitely-not-a-script` and then `npm run typecheck`.',
].join('\n');

describe('calibration documentation reference integrity', () => {
  it('resolves the seven named runbooks and the administrator guide', () => {
    // Without this the scans below are vacuous: an empty document set passes
    // every "no unknown reference" assertion while proving nothing.
    expect(RUNBOOKS.length).toBe(EXPECTED_RUNBOOK_COUNT);
    expect(new Set(RUNBOOKS).size).toBe(EXPECTED_RUNBOOK_COUNT);
    const missing = DOCUMENTS.filter(
      (document) => !existsSync(document.file),
    ).map((document) => document.label);
    expect(
      missing,
      `documentation named by the test is not on disk: ${missing.join(', ') || '(none)'}`,
    ).toEqual([]);
  });

  it('names every runbook present on disk', () => {
    // The other half of the symmetry. A runbook nobody adds to the list would
    // otherwise be exempt from every check in this file forever.
    const onDisk = readdirSync(runbookDir).filter((name) =>
      name.endsWith('.md'),
    );
    const unlisted = onDisk.filter((name) => !RUNBOOKS.includes(name));
    expect(
      unlisted,
      `runbooks exist that the named list omits: ${unlisted.join(', ') || '(none)'}`,
    ).toEqual([]);
    expect(
      onDisk.length,
      `docs/runbooks holds ${String(onDisk.length)} markdown files; expected ${String(EXPECTED_RUNBOOK_COUNT)}`,
    ).toBe(EXPECTED_RUNBOOK_COUNT);
  });

  it('gives every runbook exactly the five mandated sections in order', () => {
    for (const name of RUNBOOKS) {
      const headings = [...read(runbookPath(name)).matchAll(/^## (.+)$/gm)].map(
        (match) => match[1]!.trim(),
      );
      expect(
        headings,
        `docs/runbooks/${name} must have exactly the sections ${REQUIRED_SECTIONS.join(', ')}`,
      ).toEqual([...REQUIRED_SECTIONS]);
    }
  });

  it('reports a reference that does not exist in the repo', () => {
    // Positive control. Without it, "no unknown references" below is
    // indistinguishable from "the extractor matched nothing at all".
    const planted = extractReferences(PLANTED_DOC);
    expect(planted.fields).toContain('calibrationSessionId');
    expect(planted.dotted).toContain('sync.neverEmitted');
    expect(planted.channels).toContain('calibration:bogusChannel');
    expect(planted.scripts).toContain('definitely-not-a-script');

    const fields = knownFieldNames();
    const dotted = knownDottedNames();
    const channels = knownChannels();
    const scripts = knownScripts();
    expect(planted.fields.filter((token) => !fields.has(token))).toEqual([
      'calibrationSessionId',
    ]);
    expect(planted.dotted.filter((token) => !dotted.has(token))).toEqual([
      'sync.neverEmitted',
    ]);
    expect(planted.channels.filter((token) => !channels.has(token))).toEqual([
      'calibration:bogusChannel',
    ]);
    expect(planted.scripts.filter((token) => !scripts.has(token))).toEqual([
      'definitely-not-a-script',
    ]);

    // And the real tokens in the same fixture must survive, so the check is not
    // simply rejecting everything.
    expect(planted.fields).toContain('correlationId');
    expect(fields.has('correlationId')).toBe(true);
    expect(dotted.has('sync.failed')).toBe(true);
    expect(channels.has('calibration:getDiagnostics')).toBe(true);
    expect(scripts.has('typecheck')).toBe(true);
  });

  it('scans a source event vocabulary that is neither empty nor truncated', () => {
    const events = emittedEventNames();
    expect(
      events.size,
      `only ${String(events.size)} structured events were found in the calibration source; the scan has stopped matching`,
    ).toBeGreaterThanOrEqual(16);
    // Anchors covering both emission shapes: a plain `event:` literal and the
    // ternary in calibrationEngine.ts. If the scan regressed to the simple form
    // the second of these would vanish.
    expect(events).toContain('generation.requested');
    expect(events).toContain('sync.failed');
    expect(events).toContain('sync.completed');
    expect(events).toContain('sceneCache.recipeAdoptionFailed');
  });

  it('assembles a contract vocabulary that is neither empty nor truncated', () => {
    // The walker reads zod internals. If a zod upgrade changes `_def`, it would
    // silently return nothing and every documented field would become an
    // "unknown field" — or, if the docs were then trimmed to match, the check
    // would quietly stop constraining anything.
    const fields = knownFieldNames();
    expect(
      fields.size,
      `only ${String(fields.size)} contract field names were assembled; the schema walker has stopped descending`,
    ).toBeGreaterThanOrEqual(120);
    // Anchors at three depths: top level, nested object, nested array element.
    expect(fields.has('negotiatedApiVersion')).toBe(true);
    expect(fields.has('thermalProtectionConfirmed')).toBe(true);
    expect(fields.has('extruderType')).toBe(true);
  });

  it('extracts a non-empty reference set from the documentation', () => {
    // The floor that makes every assertion after this one meaningful.
    const all = DOCUMENTS.map((document) =>
      extractReferences(read(document.file)),
    );
    const distinct = (pick: (refs: DocReferences) => string[]): number =>
      new Set(all.flatMap(pick)).size;
    const fieldCount = distinct((refs) => refs.fields);
    const dottedCount = distinct((refs) => refs.dotted);
    const channelCount = distinct((refs) => refs.channels);
    expect(
      fieldCount,
      `only ${String(fieldCount)} distinct field references were extracted from the documentation; the extractor has stopped matching`,
    ).toBeGreaterThanOrEqual(20);
    expect(
      dottedCount,
      `only ${String(dottedCount)} distinct component/event references were extracted; the extractor has stopped matching`,
    ).toBeGreaterThanOrEqual(10);
    expect(
      channelCount,
      `only ${String(channelCount)} distinct IPC channel references were extracted; the extractor has stopped matching`,
    ).toBeGreaterThanOrEqual(3);
  });

  it('references only fields, events, channels and scripts that exist', () => {
    const fields = knownFieldNames();
    const dotted = knownDottedNames();
    const channels = knownChannels();
    const scripts = knownScripts();
    const offenders: string[] = [];
    for (const document of DOCUMENTS) {
      const refs = extractReferences(read(document.file));
      for (const token of refs.fields) {
        if (!fields.has(token)) {
          offenders.push(
            `${document.label}: unknown log/contract field '${token}'`,
          );
        }
      }
      for (const token of refs.dotted) {
        if (!dotted.has(token)) {
          offenders.push(
            `${document.label}: unknown log component or event '${token}'`,
          );
        }
      }
      for (const token of refs.channels) {
        if (!channels.has(token)) {
          offenders.push(`${document.label}: unknown IPC channel '${token}'`);
        }
      }
      for (const token of refs.scripts) {
        if (!scripts.has(token)) {
          offenders.push(`${document.label}: unknown npm script '${token}'`);
        }
      }
    }
    expect(
      offenders,
      `documentation references something the repository does not contain:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('gives every runbook a Diagnose step naming something that exists', () => {
    const fields = knownFieldNames();
    const dotted = knownDottedNames();
    const channels = knownChannels();
    const thin: string[] = [];
    for (const name of RUNBOOKS) {
      const source = read(runbookPath(name));
      const body = source
        .split(/^## /m)
        .find((chunk) => chunk.startsWith('Diagnose'));
      if (body === undefined) {
        thin.push(`docs/runbooks/${name}: no Diagnose section`);
        continue;
      }
      const refs = extractReferences(body);
      const named = [
        ...refs.fields.filter((token) => fields.has(token)),
        ...refs.dotted.filter((token) => dotted.has(token)),
        ...refs.channels.filter((token) => channels.has(token)),
      ];
      if (named.length === 0) {
        thin.push(
          `docs/runbooks/${name}: Diagnose names no log field, structured event or diagnostics channel that exists`,
        );
      }
    }
    expect(thin, thin.join('\n  ')).toEqual([]);
  });
});
