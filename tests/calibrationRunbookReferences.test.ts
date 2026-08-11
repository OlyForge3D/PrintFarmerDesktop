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
 * Defences 3 and 4 are load-bearing together and neither is alone: the positive
 * control and the loop that reports real offenders **share no code**, so the
 * control cannot prove `offenders.push` still fires, and the offender loop
 * cannot prove the extractor still matches. Each covers the other's blind spot.
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
 *
 * ## Fenced blocks are scanned, but only for the two command-shaped classes
 *
 * Inline code spans are prose; fenced blocks are not. Scanning fenced blocks for
 * every class would be wrong, because a fenced sample log record legitimately
 * contains `"correlationId"` and a fenced sample response legitimately contains
 * contract field names — that is good documentation, not a reference to police,
 * and treating it as one would either produce noise or push authors to stop
 * showing real records.
 *
 * But excluding fenced blocks entirely has a specific cost that has to be named
 * rather than implied: **a command is the reference class that most naturally
 * lives inside a fence**, so a prose-only extractor leaves the `npm run` and
 * IPC-channel checks close to inert exactly where they would matter most, while
 * still looking like coverage.
 *
 * So the split is by shape, not by location. `calibration:<channel>` and
 * `npm run <script>` are unambiguous and self-delimiting, so they are matched
 * **inside fenced blocks as well as in prose**, with or without backticks.
 * camelCase and dotted-name classification stays prose-only, because in a fence
 * those shapes are indistinguishable from sample data.
 *
 * The residual limit, stated: a fenced block that deliberately shows a
 * *hypothetical* channel or script will fail this test. That is the intended
 * trade — a hypothetical command in operator documentation is a bug report
 * waiting to happen — but it is a constraint on authors, so it is written down.
 *
 * ## Diagnose must name something relevant, not merely something real (#387)
 *
 * The Diagnose-section guard originally asked only "does this section name a
 * known field, event or channel?" — existential, not relevance-based. Because
 * a handful of fields (`correlationId`, `outcome`, `errorCode`, …) exist in
 * essentially every runbook's vocabulary, a runbook could name one of those
 * while diagnosing nothing about its own actual failure mode and still pass.
 * `diagnoseRelevance` (below) additionally requires the named token to recur
 * elsewhere in the *same* runbook's Trigger, Recover, Verify or "If this
 * fails" section, which ties the requirement to that runbook's own incident
 * rather than to the shared vocabulary at large — without hand-maintaining a
 * per-runbook allowlist of "the right field for this one". See its doc
 * comment for the full reasoning and the control test below for the
 * anti-vacuity pair (a real-but-irrelevant field, and a nonexistent one).
 */

import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_PERMISSIONS,
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
  CalibrationAssetManifestEntry,
  CalibrationUnavailableReason,
  CalibrationWorkspaceStageId,
  CalibrationOutboxUnavailableReason,
  RetargetErrorCode,
  isJobScopedEnvelope,
} from '@shared/ipc';
import type { ZodTypeAny } from 'zod';
import {
  CALIBRATION_CORRELATION_ORIGINS,
  CALIBRATION_LOG_COMPONENTS,
  CALIBRATION_LOG_ERROR_CODES,
  CALIBRATION_LOG_FIELDS,
  CALIBRATION_LOG_LEVELS,
  CALIBRATION_LOG_OUTCOMES,
} from '../src/main/calibrationLog.js';
import { CalibrationHttpClient } from '../src/main/calibrationHttp.js';
import { detectQueueChangeFeedGap } from '../src/main/ipc.js';
import {
  RemoteCalibrationApplyRequest,
  RemoteCalibrationCapabilities,
  RemoteQueueEventEnvelope,
} from '../src/main/calibrationWire.js';

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

/**
 * Documents that live in `docs/runbooks/` but are not incident recovery
 * runbooks, and so do not carry the five mandated sections.
 *
 * `docs/runbooks/` now holds two genres. #160's seven are *incident* documents:
 * something is broken, and Trigger/Diagnose/Recover/Verify/If this fails is the
 * right shape for that. `calibration-rollout.md` is #161's deliverable and is a
 * *planned procedure* — eight ordered stages, each with a precondition, a health
 * signal and a rollback. It has no trigger because nothing has gone wrong, and
 * its structure is fixed by #161's acceptance criteria and read by the parity
 * test in `tests/calibrationRolloutRunbook.test.ts`.
 *
 * Named and pinned exactly like RUNBOOKS rather than globbed or pattern-matched,
 * so this stays an explicit two-list partition and not an escape hatch. The
 * property the on-disk check exists to protect is unchanged: **every `.md` in
 * the directory must appear in exactly one list**, so a new document is still
 * forced to declare itself and cannot become exempt from this file by being
 * quietly dropped in. What genre buys is exemption from the *section shape*
 * only — every document here is still scanned for reference integrity below.
 */
const PROCEDURES: readonly string[] = ['calibration-rollout.md'];

/** Pinned for the same reason as EXPECTED_RUNBOOK_COUNT. */
const EXPECTED_PROCEDURE_COUNT = 1;

const ADMIN_GUIDE = 'printer-calibration-admin-guide.md';

/**
 * The operator-facing guide added by #207. It was outside DOCUMENTS entirely, so
 * nothing checked that the channels, log fields and npm scripts it tells a user
 * to type still exist. It is the document most likely to be read by somebody who
 * cannot check, which makes it the worst one to leave unverified.
 */
const USER_GUIDE = 'printer-calibration-user-guide.md';

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
  // The asset manifest an operator reads when a gated download is refused:
  // disabledReason, sourceUrl, expectedSha256.
  CalibrationAssetManifestEntry,
  // The *server-advertised* capability flags. These are a different vocabulary
  // from CalibrationCapabilityFlags above, and the gap was invisible until a
  // document named one: calibrationWire.ts maps server calibrationSyncEnabled
  // onto client calibrationChangeFeedEnabled *and* calibrationOfflineDraftEnabled,
  // so the two sets share no names and neither is derivable from the other.
  // Without this entry every correct reference to a server switch is reported as
  // a name the repository does not contain.
  RemoteCalibrationCapabilities,
  RemoteCalibrationApplyRequest,
  RemoteQueueEventEnvelope,
];

/** Every camelCase contract field or local symbol an operator may be told to read. */
function knownFieldNames(): Set<string> {
  const names = new Set<string>([
    ...CALIBRATION_LOG_FIELDS,
    ...CALIBRATION_LOG_ERROR_CODES,
    ...CALIBRATION_CORRELATION_ORIGINS,
    ...CALIBRATION_LOG_LEVELS,
    ...CALIBRATION_LOG_OUTCOMES,
    ...CalibrationUnavailableReason.options,
    // Workspace stage IDs. An operator guide walks a user through the stages
    // by name, so these are exactly the identifiers a document is expected to say.
    ...CalibrationWorkspaceStageId.options,
    ...CalibrationOutboxUnavailableReason.options,
    // Renderer-visible retarget error codes. These are the identifiers an
    // operator actually reads out of a failure dialog, and until #316 they were
    // the one class the runbooks could not cite: the vocabulary above is
    // assembled from log fields and calibration contracts, so a runbook naming
    // `sidecarUnavailable` failed this test while the operator staring at that
    // exact string had nowhere to look it up.
    ...RetargetErrorCode.options,
    // Implementation symbols named by the source-backed server contract guide.
    // Derive their spellings from the actual exports/prototype so a rename makes
    // the guide fail rather than leaving a duplicated allow-list behind.
    CalibrationHttpClient.prototype.acknowledgeBedClearAndStart.name,
    isJobScopedEnvelope.name,
    detectQueueChangeFeedGap.name,
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
/**
 * Canonical calibration permissions, which share the `calibration:` prefix with
 * the IPC channels but are a different vocabulary entirely.
 *
 * Taken from the production constant rather than restated, so a permission
 * renamed in one place cannot stay "documented" here. Without this split the
 * checker read `calibration:read` as an IPC channel and reported the guides as
 * referencing a channel that does not exist.
 */
const CALIBRATION_PERMISSION_TOKENS = new Set<string>(
  Object.values(CALIBRATION_PERMISSIONS),
);
const NPM_SCRIPT = /^npm run ([A-Za-z0-9:_-]+)$/;
/** The same two classes, matched unanchored so a fenced block is covered. */
const CHANNEL_ANYWHERE = /calibration:([A-Za-z]+)/g;
const NPM_SCRIPT_ANYWHERE = /npm run ([A-Za-z0-9:_-]+)/g;
const FENCED_BLOCK = /```[\s\S]*?```/g;

export interface DocReferences {
  fields: string[];
  dotted: string[];
  channels: string[];
  scripts: string[];
}

/**
 * Classify every inline code span in a document, then sweep the fenced blocks
 * for the two command-shaped classes. See the module docblock for why the two
 * passes see different amounts of the document.
 */
export function extractReferences(markdown: string): DocReferences {
  const fenced = markdown.match(FENCED_BLOCK) ?? [];
  const prose = markdown.replace(FENCED_BLOCK, '');
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
    } else if (CALIBRATION_PERMISSION_TOKENS.has(token)) {
      // A canonical permission, already validated by membership above. It is
      // not an IPC channel and must not be checked as one.
      continue;
    } else if (CHANNEL.test(token)) {
      references.channels.push(token);
    } else if (DOTTED.test(token)) {
      references.dotted.push(token);
    } else if (CAMEL_FIELD.test(token)) {
      references.fields.push(token);
    }
  }
  for (const block of fenced) {
    for (const match of block.matchAll(NPM_SCRIPT_ANYWHERE)) {
      references.scripts.push(match[1]!);
    }
    for (const match of block.matchAll(CHANNEL_ANYWHERE)) {
      references.channels.push(`calibration:${match[1]!}`);
    }
  }
  return references;
}

/**
 * A definition bullet: `- \`token\` — meaning`, the shape the documentation uses
 * to teach an operator what a value means. The em dash or hyphen is required so
 * an ordinary bullet that merely opens with a code span is not treated as a
 * definition.
 *
 * This exists because the three shape predicates above gate on **orthography**:
 * `CAMEL_FIELD` requires a hump, so an enum member that is an ordinary English
 * word — `resumed`, `continued`, `ok` — matches nothing, falls out of the
 * `else if` chain in `extractReferences`, and is never checked against anything.
 * The documentation can therefore define a value that does not exist and stay
 * green. See issue #243.
 *
 * A definition bullet is the one position where a bare word is unambiguously a
 * *value being taught* rather than incidental prose, which is what makes
 * checking it safe without an exact-match allowlist. An allowlist would be
 * useless here: a fictional word is absent from the allowlist exactly as a
 * dropped word is, so filtering on membership cannot distinguish them.
 */
const VALUE_DEFINITION = /^[ \t]*[-*][ \t]+`([^`\n]+)`[ \t]+[\u2014-]/gm;

/**
 * Tokens the document defines in a bullet that none of the shape classes claim.
 * These are the word-shaped values; the shaped ones are already covered by
 * `extractReferences`.
 */
export function definedValues(markdown: string): string[] {
  const prose = markdown.replace(FENCED_BLOCK, '');
  const values: string[] = [];
  for (const match of prose.matchAll(VALUE_DEFINITION)) {
    const token = match[1]!.trim();
    if (
      CHANNEL.test(token) ||
      DOTTED.test(token) ||
      CAMEL_FIELD.test(token) ||
      NPM_SCRIPT.test(token)
    ) {
      continue;
    }
    values.push(token);
  }
  return values;
}

/**
 * A word-shaped status value **mentioned** outside a definition bullet (issue
 * #262).
 *
 * `definedValues` above closes #243 for the one position where a bare word is
 * unambiguously a value: the bullet that introduces it. Everywhere else a
 * word-shaped token appears in prose — `A value of \`resumed\` on an
 * \`orchestration.polled\` record…`, `` `correlationOrigin` = `resumed` ``,
 * `` `continued` rather than `resumed` `` — none of the shape predicates in
 * `extractReferences` claim it (no hump, no dot, no colon), so it fell out of
 * the `else if` chain and was never checked. That is exactly the gap #262
 * reports: mutating only these mentions, leaving the definition bullet
 * intact, left the suite green, and both runbook occurrences of `resumed`
 * were among the four mentions that gap covers.
 *
 * A bare word in prose is still ambiguous between a status value and an
 * ordinary emphasised word — extending the shape predicate itself to all of
 * prose was proposed for #243 and withdrawn for exactly that reason. So this
 * does the same trick #243 did, one level up: rather than guessing from
 * shape, it keys off the small set of syntactic constructs this documentation
 * actually uses to *say* "this word is the value of a field", each of which
 * disambiguates by position the same way a definition bullet does:
 *
 * - `` `field` = `value` `` — an explicit equation.
 * - `A value of \`value\`` — the explicit noun phrase.
 * - `` `value` rather than `value` `` — a contrast between two values of the
 *   same field.
 * - `` `value` origin`` — this documentation's own idiom for naming a
 *   `correlationOrigin` value (`` A `resumed` origin… ``).
 *
 * Anything else stays unchecked, same as it does for `extractReferences`:
 * this is a real, stated limit, not a claim of exhaustive prose coverage.
 */
const MENTION_VALUE_OF = /\bvalue\s+of\s+`([^`\n]+)`/gi;
const MENTION_FIELD_EQUALS = /`[A-Za-z][A-Za-z0-9]*`\s*=\s*`([^`\n]+)`/g;
const MENTION_RATHER_THAN = /`([^`\n]+)`\s+rather than\s+`([^`\n]+)`/gi;
const MENTION_ORIGIN_SUFFIX = /`([^`\n]+)`\s+origin\b/gi;

/**
 * Word-shaped tokens named at one of the mention positions above. Shaped
 * tokens (camelCase fields, dotted names, channels, scripts) are excluded
 * because those are already checked everywhere they appear in prose by
 * `extractReferences`; this only has to cover the class that check cannot
 * see.
 */
export function mentionedValues(markdown: string): string[] {
  const prose = markdown.replace(FENCED_BLOCK, '');
  const values: string[] = [];
  const collect = (token: string): void => {
    const trimmed = token.trim();
    if (
      CHANNEL.test(trimmed) ||
      DOTTED.test(trimmed) ||
      CAMEL_FIELD.test(trimmed) ||
      NPM_SCRIPT.test(trimmed)
    ) {
      return;
    }
    values.push(trimmed);
  };
  for (const match of prose.matchAll(MENTION_VALUE_OF)) collect(match[1]!);
  for (const match of prose.matchAll(MENTION_FIELD_EQUALS)) collect(match[1]!);
  for (const match of prose.matchAll(MENTION_RATHER_THAN)) {
    collect(match[1]!);
    collect(match[2]!);
  }
  for (const match of prose.matchAll(MENTION_ORIGIN_SUFFIX)) collect(match[1]!);
  return values;
}

/**
 * Whether a `Diagnose` section names something *relevant*, not merely
 * something that exists (issue #387).
 *
 * The straightforward existential version of this check — "does Diagnose
 * name at least one known field/event/channel?" — passes on any real token,
 * including one that has nothing to do with the runbook's own failure mode.
 * `correlationId` exists in the shared vocabulary and would satisfy that
 * check in every runbook regardless of what it is actually diagnosing.
 *
 * A hand-maintained per-runbook allowlist of "the right field for this
 * runbook" was considered and rejected: it only knows what someone
 * remembered to type, and stops growing the moment the vocabulary does.
 *
 * Instead, relevance is derived from the runbook's own structure: a known
 * token named in `Diagnose` counts as relevant only if it also **recurs**
 * in one of the other four mandated sections — `Trigger`, `Recover`,
 * `Verify` or `If this fails` — of the *same* document. The document's title
 * and intro paragraph, which precede the first `## ` heading, deliberately do
 * not count: they are free-form prose, not one of the mandated sections, and
 * counting a recurrence there would let an author satisfy this guard by
 * mentioning an irrelevant field once in the intro and once in Diagnose.
 * Every one of the seven shipped runbooks already satisfies this — verified
 * directly by the loop test below, not merely asserted — because a runbook's
 * other mandated sections necessarily talk about the same signal Diagnose is
 * supposed to be reading. This is not an allowlist: it is computed fresh
 * from each document's own text and the same emitter-backed vocabulary
 * functions (`knownFieldNames`, `knownDottedNames`, `knownChannels`) used by
 * every other check in this file, so it grows automatically as the
 * vocabulary and the runbooks do.
 */
export function diagnoseRelevance(
  markdown: string,
  fields: Set<string>,
  dotted: Set<string>,
  channels: Set<string>,
): { known: string[]; relevant: string[] } | undefined {
  const sections = markdown.split(/^## /m);
  const diagnoseIndex = sections.findIndex((chunk) =>
    chunk.startsWith('Diagnose'),
  );
  if (diagnoseIndex === -1) return undefined;
  const knownTokens = (body: string): string[] => {
    const refs = extractReferences(body);
    return [
      ...refs.fields.filter((token) => fields.has(token)),
      ...refs.dotted.filter((token) => dotted.has(token)),
      ...refs.channels.filter((token) => channels.has(token)),
    ];
  };
  const known = [...new Set(knownTokens(sections[diagnoseIndex]!))];
  // Only the other four mandated sections count as "elsewhere". The chunk at
  // index 0 is the document's title and intro paragraph, preceding the first
  // `## ` heading — free-form prose, not one of Trigger/Recover/Verify/If
  // this fails. Including it would let a token recur once in the intro and
  // once in Diagnose with no connection to the runbook's actual incident
  // narrative, reopening exactly the "existential check in disguise" gap
  // this function exists to close, so it is excluded explicitly rather than
  // by an "everything but Diagnose" complement.
  const OTHER_MANDATED_SECTIONS = REQUIRED_SECTIONS.filter(
    (section) => section !== 'Diagnose',
  );
  const elsewhere = new Set(
    knownTokens(
      sections
        .filter((chunk) =>
          OTHER_MANDATED_SECTIONS.some((section) => chunk.startsWith(section)),
        )
        .join('\n'),
    ),
  );
  const relevant = known.filter((token) => elsewhere.has(token));
  return { known, relevant };
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
  { label: `docs/${USER_GUIDE}`, file: path.join(docsDir, USER_GUIDE) },
  ...RUNBOOKS.map((name) => ({
    label: `docs/runbooks/${name}`,
    file: runbookPath(name),
  })),
  // Deliberately included. Genre exempts a document from the section shape, not
  // from reference integrity — a rollout procedure names channels, log fields
  // and npm scripts an operator will type, and those are exactly what this file
  // exists to keep true.
  ...PROCEDURES.map((name) => ({
    label: `docs/runbooks/${name}`,
    file: runbookPath(name),
  })),
];

/**
 * A document referencing things that do not exist, plus one of each kind that
 * does. Drives the positive control below.
 *
 * The fenced block at the end is the second half of the control: it proves the
 * fenced sweep sees a command-shaped reference, and that it does *not* promote
 * sample data (`calibrationSessionIdInFence`) into a field reference.
 */
const PLANTED_DOC = [
  '# Planted',
  '',
  'Read `calibrationSessionId` from the record and check `correlationId` too.',
  'Look for `sync.neverEmitted` alongside `sync.failed`.',
  'Call `calibration:bogusChannel`, not `calibration:getDiagnostics`.',
  'Run `npm run definitely-not-a-script` and then `npm run typecheck`.',
  '',
  '```sh',
  'npm run also-not-a-script',
  'invoke calibration:alsoBogusChannel',
  'echo \'{"calibrationSessionIdInFence": "sample", "sync.alsoNeverEmitted": 1}\'',
  '```',
].join('\n');

/**
 * Fixtures for the Diagnose relevance guard (issue #387). Built the same way
 * `PLANTED_DOC` is: small, self-contained, and driving `diagnoseRelevance`
 * directly rather than the runbook loop, so a bug in the loop's reporting
 * cannot mask a bug in the classification itself.
 *
 * `correlationId` and `sync.failed` are real tokens (present in
 * `knownFieldNames()`/`knownDottedNames()`), so all three fixtures below
 * exercise the *relevance* question, not the existence question — that one is
 * already covered by `PLANTED_DOC` above.
 */

/**
 * Arm A: an existing-but-irrelevant field. `correlationId` is real and is
 * named in Diagnose, but never recurs anywhere else in the document — this
 * is exactly the shape the issue demonstrated as a false pass under the old
 * existential guard.
 */
const DIAGNOSE_IRRELEVANT_REAL_FIELD = [
  '# Planted irrelevant',
  '',
  '## Trigger',
  '',
  'Something in the system is broken.',
  '',
  '## Diagnose',
  '',
  'Read `correlationId` from the record.',
  '',
  '## Recover',
  '',
  'Restart the affected process.',
  '',
  '## Verify',
  '',
  'Confirm the process is healthy again.',
  '',
  '## If this fails',
  '',
  'Escalate to the on-call engineer.',
].join('\n');

/** Arm B: the existing anti-vacuity control, restated as a fabricated token. */
const DIAGNOSE_NONEXISTENT_FIELD = DIAGNOSE_IRRELEVANT_REAL_FIELD.replace(
  'correlationId',
  'definitelyNotARealFieldOrEvent',
);

/**
 * Positive control: `sync.failed` is real *and* recurs in Trigger and
 * Verify, so it is the token this runbook's own narrative is actually about.
 */
const DIAGNOSE_RELEVANT_FIELD = [
  '# Planted relevant',
  '',
  '## Trigger',
  '',
  'A `sync.failed` record appears in the structured log.',
  '',
  '## Diagnose',
  '',
  'Read the `sync.failed` record and check its error code.',
  '',
  '## Recover',
  '',
  'Retry the sync operation.',
  '',
  '## Verify',
  '',
  'Confirm a `sync.failed` record no longer appears on retry.',
  '',
  '## If this fails',
  '',
  'Escalate with the record contents.',
].join('\n');

/**
 * Regression fixture for the preamble-leak defect caught in review: a token
 * that recurs only in the document's title/intro paragraph (before the
 * first `## ` heading) and in Diagnose, with no appearance in Trigger,
 * Recover, Verify or If this fails. The intro paragraph is free-form prose,
 * not one of the four mandated sections, so a token recurring only there
 * must not count as relevant — otherwise an author could satisfy the guard
 * by mentioning an irrelevant field once in the intro and once in Diagnose,
 * reopening the exact "existential check in disguise" gap issue #387 is
 * about.
 */
const DIAGNOSE_PREAMBLE_ONLY_RECURRENCE = [
  '# Planted preamble leak',
  '',
  'This intro mentions `correlationId` in passing, which must not count.',
  '',
  '## Trigger',
  '',
  'Something in the system is broken.',
  '',
  '## Diagnose',
  '',
  'Read `correlationId` from the record.',
  '',
  '## Recover',
  '',
  'Restart the affected process.',
  '',
  '## Verify',
  '',
  'Confirm the process is healthy again.',
  '',
  '## If this fails',
  '',
  'Escalate to the on-call engineer.',
].join('\n');

describe('calibration documentation reference integrity', () => {
  it('resolves the seven named runbooks, the rollout procedure and both operator guides', () => {
    // Without this the scans below are vacuous: an empty document set passes
    // every "no unknown reference" assertion while proving nothing.
    expect(RUNBOOKS.length).toBe(EXPECTED_RUNBOOK_COUNT);
    expect(new Set(RUNBOOKS).size).toBe(EXPECTED_RUNBOOK_COUNT);
    expect(PROCEDURES.length).toBe(EXPECTED_PROCEDURE_COUNT);
    expect(new Set(PROCEDURES).size).toBe(EXPECTED_PROCEDURE_COUNT);
    // The two lists partition the directory, so an entry in both would let a
    // document claim recovery shape and procedure exemption at once.
    const inBoth = PROCEDURES.filter((name) => RUNBOOKS.includes(name));
    expect(
      inBoth,
      `documents claim both genres at once: ${inBoth.join(', ') || '(none)'}`,
    ).toEqual([]);
    const missing = DOCUMENTS.filter(
      (document) => !existsSync(document.file),
    ).map((document) => document.label);
    expect(
      missing,
      `documentation named by the test is not on disk: ${missing.join(', ') || '(none)'}`,
    ).toEqual([]);
  });

  it('names every document present on disk, in exactly one genre', () => {
    // The other half of the symmetry. A document nobody adds to a list would
    // otherwise be exempt from every check in this file forever — which is what
    // happened when docs/runbooks/calibration-rollout.md landed and this
    // assertion caught it on the merge, not on either branch alone.
    const onDisk = readdirSync(runbookDir).filter((name) =>
      name.endsWith('.md'),
    );
    const unlisted = onDisk.filter(
      (name) => !RUNBOOKS.includes(name) && !PROCEDURES.includes(name),
    );
    expect(
      unlisted,
      `documents exist in docs/runbooks that neither named list claims: ${unlisted.join(', ') || '(none)'}. Add it to RUNBOOKS if it is an incident runbook with the five mandated sections, or to PROCEDURES if it is a planned procedure.`,
    ).toEqual([]);
    expect(
      onDisk.length,
      `docs/runbooks holds ${String(onDisk.length)} markdown files; expected ${String(EXPECTED_RUNBOOK_COUNT + EXPECTED_PROCEDURE_COUNT)}`,
    ).toBe(EXPECTED_RUNBOOK_COUNT + EXPECTED_PROCEDURE_COUNT);
  });

  it('gives every recovery runbook exactly the five mandated sections in order', () => {
    // PROCEDURES are deliberately not in this loop; that exemption is the whole
    // reason the second list exists, and it is why they stay in DOCUMENTS.
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
    // The fenced sweep, proven live rather than assumed from the prose pass.
    expect(planted.channels).toContain('calibration:alsoBogusChannel');
    expect(planted.scripts).toContain('also-not-a-script');

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
      'calibration:alsoBogusChannel',
    ]);
    expect(planted.scripts.filter((token) => !scripts.has(token))).toEqual([
      'definitely-not-a-script',
      'also-not-a-script',
    ]);

    // Sample data inside a fence stays sample data: the fenced sweep carries
    // only the two command-shaped classes, so a JSON key in an example record
    // is not promoted into a field or event reference. Documentation that shows
    // a real log line must not be punished for it.
    expect(planted.fields).not.toContain('calibrationSessionIdInFence');
    expect(planted.dotted).not.toContain('sync.alsoNeverEmitted');

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

  it('defines only values that exist, including word-shaped ones', () => {
    // #243: the shape predicates gate on orthography, so `resumed` and
    // `continued` were documented and unguarded while `notAttempted` was
    // checked. A definition bullet is the position where a bare word is
    // certainly a value, so it can be checked without guessing at shape.
    const fields = knownFieldNames();
    const defined = DOCUMENTS.flatMap((document) =>
      definedValues(read(document.file)).map((token) => ({
        label: document.label,
        token,
      })),
    );
    // Non-vacuity: if the bullet pattern stops matching, every assertion below
    // passes over an empty list and the check silently stops constraining.
    expect(
      defined.length,
      `only ${String(defined.length)} word-shaped value definitions were extracted; the definition-bullet pattern has stopped matching`,
    ).toBeGreaterThanOrEqual(3);
    const offenders = defined
      .filter(({ token }) => !fields.has(token))
      .map(({ label, token }) => `${label}: defines unknown value '${token}'`);
    expect(
      offenders,
      `documentation defines a value the repository does not contain:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('mentions only word-shaped values that exist, not just definitions of them (#262)', () => {
    // #262: the definition-site guard above only checks the bullet that
    // *introduces* a value. It says nothing about a *mention* of that value
    // elsewhere — including in the runbooks, which is where an operator
    // actually reads it. This checks every mention position named in
    // `mentionedValues`'s doc comment against the same source-of-truth
    // vocabulary the definition-site guard uses.
    const fields = knownFieldNames();
    const mentioned = DOCUMENTS.flatMap((document) =>
      mentionedValues(read(document.file)).map((token) => ({
        label: document.label,
        token,
      })),
    );
    // Non-vacuity: if every mention pattern stops matching, the assertion
    // below passes over an empty list and silently stops constraining
    // anything, which is precisely the failure mode #262 reports.
    expect(
      mentioned.length,
      `only ${String(mentioned.length)} word-shaped value mentions were extracted; the mention patterns have stopped matching`,
    ).toBeGreaterThanOrEqual(4);
    const offenders = mentioned
      .filter(({ token }) => !fields.has(token))
      .map(({ label, token }) => `${label}: mentions unknown value '${token}'`);
    expect(
      offenders,
      `documentation mentions a value the repository does not contain:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('control: the mention guard rejects a stale mentioned value and accepts a real one (#262)', () => {
    // Positive control + anti-vacuity pair: a fixture built from the exact
    // syntactic shapes #262 reports as unguarded (`stuck-orchestration.md:34`
    // and `:59`), with one real value and one invented one at each position,
    // proves the guard both fires on the offender and does not reject the
    // real thing alongside it.
    const fixture = [
      '## Diagnose',
      '',
      '4. **Check `correlationOrigin` on the polls.** A value of `resumed` on an',
      '   `orchestration.polled` record means the flow lost correlation. A value',
      '   of `abandoned` would not, because that word is never emitted.',
      '',
      '## Verify',
      '',
      '1. Confirm the record now carries `correlationOrigin`',
      '   `continued` rather than `resumed`, and not `halted` rather than `stalled`.',
      '2. `outcome` = `failed`, not `outcome` = `nothinghappened`.',
      '3. A `resumed` origin should not recur; nor should a `phantom` origin.',
      '',
    ].join('\n');
    const fields = knownFieldNames();
    const mentioned = new Set(mentionedValues(fixture));
    // The real values survive: the guard does not reject everything it sees.
    expect(mentioned.has('resumed')).toBe(true);
    expect(mentioned.has('continued')).toBe(true);
    expect(mentioned.has('failed')).toBe(true);
    expect(fields.has('resumed')).toBe(true);
    expect(fields.has('continued')).toBe(true);
    expect(fields.has('failed')).toBe(true);
    // The invented values at each of the four mention positions are extracted
    // and are not in the known vocabulary, so the guard reports them.
    for (const invented of [
      'abandoned',
      'halted',
      'stalled',
      'nothinghappened',
      'phantom',
    ]) {
      expect(mentioned.has(invented)).toBe(true);
      expect(fields.has(invented)).toBe(false);
    }
  });

  it('documents every correlationOrigin an operator can see', () => {
    // The other direction: the check above catches a value that does not exist,
    // this one catches a value that exists and stopped being explained. Scoped
    // to correlation origins because that is the vocabulary the guide teaches
    // as a definition list; log levels and outcomes are ordinary English words
    // the documentation does not enumerate, and requiring them would assert a
    // convention the docs do not follow.
    const guide = read(path.join(docsDir, ADMIN_GUIDE));
    const defined = new Set(definedValues(guide));
    const documented = new Set(extractReferences(guide).fields);
    const missing = CALIBRATION_CORRELATION_ORIGINS.filter(
      (origin) => !defined.has(origin) && !documented.has(origin),
    );
    expect(
      missing,
      `the admin guide no longer explains these correlationOrigin values: ${missing.join(', ')}`,
    ).toEqual([]);
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

  it('gives every recovery runbook a Diagnose step naming something real and relevant to its own failure mode', () => {
    // #387: naming *something that exists* is not enough — `correlationId`
    // exists in every runbook's vocabulary and would satisfy that alone
    // regardless of what the runbook is actually diagnosing. `diagnoseRelevance`
    // additionally requires the named token to recur elsewhere in the same
    // runbook (Trigger/Recover/Verify/If this fails), which ties the check to
    // this runbook's own incident rather than to the vocabulary at large. See
    // `diagnoseRelevance`'s doc comment for why this is not a hand-maintained
    // per-runbook allowlist.
    const fields = knownFieldNames();
    const dotted = knownDottedNames();
    const channels = knownChannels();
    const thin: string[] = [];
    for (const name of RUNBOOKS) {
      const source = read(runbookPath(name));
      const result = diagnoseRelevance(source, fields, dotted, channels);
      if (result === undefined) {
        thin.push(`docs/runbooks/${name}: no Diagnose section`);
        continue;
      }
      if (result.known.length === 0) {
        thin.push(
          `docs/runbooks/${name}: Diagnose names no log field, structured event or diagnostics channel that exists`,
        );
      } else if (result.relevant.length === 0) {
        thin.push(
          `docs/runbooks/${name}: Diagnose names only real values (${result.known.join(', ')}) that do not recur anywhere else in the runbook — naming something that exists is not enough; it must be tied to this runbook's own Trigger/Recover/Verify/If-this-fails narrative`,
        );
      }
    }
    expect(thin, thin.join('\n  ')).toEqual([]);
  });

  it('control: the Diagnose relevance guard rejects an irrelevant real field and a nonexistent one, but accepts a relevant one', () => {
    // Positive control + anti-vacuity pair (issue #387), run through the same
    // `diagnoseRelevance` helper the loop above uses, on fixtures independent
    // of any shipped runbook — proving the guard cannot pass vacuously in
    // either direction and that a genuinely relevant reference does pass.
    const fields = knownFieldNames();
    const dotted = knownDottedNames();
    const channels = knownChannels();

    // Arm A: a real field named only in Diagnose, tied to nothing else in the
    // document. This is exactly the false pass the issue demonstrated under
    // the old existential guard.
    const irrelevant = diagnoseRelevance(
      DIAGNOSE_IRRELEVANT_REAL_FIELD,
      fields,
      dotted,
      channels,
    );
    expect(irrelevant).toBeDefined();
    expect(irrelevant?.known).toEqual(['correlationId']);
    expect(
      irrelevant?.relevant,
      'a real field named only in Diagnose, with no recurrence elsewhere in the document, must not count as relevant',
    ).toEqual([]);

    // Arm B: the same shape, but the token does not exist at all. Confirms
    // the relevance requirement did not quietly relax the existence check.
    const nonexistent = diagnoseRelevance(
      DIAGNOSE_NONEXISTENT_FIELD,
      fields,
      dotted,
      channels,
    );
    expect(nonexistent).toBeDefined();
    expect(nonexistent?.known).toEqual([]);
    expect(nonexistent?.relevant).toEqual([]);

    // Positive control: a real field that recurs in Trigger and Verify must
    // be reported as relevant, so the guard is not simply rejecting everything.
    const relevant = diagnoseRelevance(
      DIAGNOSE_RELEVANT_FIELD,
      fields,
      dotted,
      channels,
    );
    expect(relevant).toBeDefined();
    expect(relevant?.known).toContain('sync.failed');
    expect(
      relevant?.relevant,
      'a field that recurs in Trigger/Verify must be reported as relevant',
    ).toContain('sync.failed');

    // Regression for a defect caught in review: a token recurring only in
    // the document's title/intro paragraph (before the first `## ` heading)
    // must not count as relevant. That paragraph is free-form prose, not one
    // of Trigger/Recover/Verify/If this fails, so counting it would let an
    // author satisfy the guard by mentioning an irrelevant field once in the
    // intro and once in Diagnose.
    const preambleLeak = diagnoseRelevance(
      DIAGNOSE_PREAMBLE_ONLY_RECURRENCE,
      fields,
      dotted,
      channels,
    );
    expect(preambleLeak).toBeDefined();
    expect(preambleLeak?.known).toEqual(['correlationId']);
    expect(
      preambleLeak?.relevant,
      'a token recurring only in the title/intro paragraph, not in Trigger/Recover/Verify/If this fails, must not count as relevant',
    ).toEqual([]);
  });
});
