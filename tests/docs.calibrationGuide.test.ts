import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CALIBRATION_STAGES } from '../src/renderer/calibration/domain/catalog';

/*
 * Guards `docs/printer-calibration-user-guide.md` against drifting away from
 * shipped behaviour.
 *
 * Two extraction arms:
 *
 *   - the catalog arm is an *import*, not a parse, so it cannot drift from the
 *     module the application actually runs;
 *   - the guide arm is a regex over the stage headings, so it can drift, and it
 *     is the arm that has to prove it found anything.
 *
 * The guide arm is asserted non-empty AND of cardinality nine BEFORE any
 * comparison runs. Symmetric comparison defeats one side going empty; it does
 * not defeat both sides going empty, and it does not defeat an extractor that
 * silently matches nothing.
 *
 * If you change either extractor — the heading format below, or the shape of
 * CALIBRATION_STAGES — re-run the mutations recorded in the PR for this file
 * and observe the diagnostics yourself. A failure observed against the previous
 * extractor says nothing about the new one.
 */

const GUIDE_PATH = resolve(
  __dirname,
  '..',
  'docs',
  'printer-calibration-user-guide.md',
);

const guide = readFileSync(GUIDE_PATH, 'utf8');

/** Heading format the guide uses for each stage: `### 3. Flow pass 2 — \`flowPass2\`` */
const STAGE_HEADING = /^### \d+\. (.+?) — `([A-Za-z0-9]+)`$/gm;

interface ExtractedStage {
  readonly title: string;
  readonly id: string;
}

function extractGuideStages(markdown: string): readonly ExtractedStage[] {
  const found: ExtractedStage[] = [];
  for (const match of markdown.matchAll(STAGE_HEADING)) {
    const [, title, id] = match;
    if (title === undefined || id === undefined) {
      continue;
    }
    found.push({ title, id });
  }
  return found;
}

/**
 * Sentences are the unit the macOS claim has to be checked over. Markdown hard-wraps
 * mid-sentence, so single newlines are collapsed first — splitting on raw newlines
 * would slice one claim into fragments and let a fragment escape the check.
 */
function sentences(markdown: string): readonly string[] {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/([^\n])\n(?!\n)/g, '$1 ')
    .split(/(?<=[.!?])\s+|\n/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

describe('printer calibration user guide', () => {
  const guideStages = extractGuideStages(guide);

  describe('stage list', () => {
    it('extracts a non-empty stage list from the guide', () => {
      expect(
        guideStages.length,
        `the guide stage-heading extractor matched nothing in ${GUIDE_PATH}. ` +
          `It looks for headings of the form "### 1. Temperature — \`temperature\`". ` +
          `Either the stage section is missing or its heading format changed; ` +
          `until this matches, every comparison below would pass vacuously.`,
      ).toBeGreaterThan(0);
    });

    it('documents exactly as many stages as the catalog defines', () => {
      expect(
        CALIBRATION_STAGES.length,
        'CALIBRATION_STAGES no longer holds nine stages; the guide describes nine ' +
          'and must be rewritten, not just re-checked.',
      ).toBe(9);
      expect(
        guideStages.length,
        `the guide documents ${guideStages.length} stage heading(s) but the catalog ` +
          `defines ${CALIBRATION_STAGES.length}. Documented: ` +
          `[${guideStages.map((stage) => stage.id).join(', ')}].`,
      ).toBe(CALIBRATION_STAGES.length);
    });

    it('documents every stage the catalog defines', () => {
      const documented = new Set(guideStages.map((stage) => stage.id));
      const undocumented = CALIBRATION_STAGES.filter(
        (stage) => !documented.has(stage.id),
      ).map((stage) => `${stage.id} (${stage.title})`);
      expect(
        undocumented,
        `these calibration stages exist in catalog.ts but are not documented in the ` +
          `user guide: [${undocumented.join(', ')}]. A stage a user must perform and ` +
          `cannot read about is an undocumented stage.`,
      ).toEqual([]);
    });

    it('documents no stage the catalog does not define', () => {
      const defined = new Set<string>(
        CALIBRATION_STAGES.map((stage) => stage.id),
      );
      const invented = guideStages
        .filter((stage) => !defined.has(stage.id))
        .map((stage) => `${stage.id} (${stage.title})`);
      expect(
        invented,
        `the user guide documents these stages, which do not exist in catalog.ts: ` +
          `[${invented.join(', ')}]. A documented stage the application does not ` +
          `implement is a false claim, and it survives longer than the code that ` +
          `would have contradicted it.`,
      ).toEqual([]);
    });

    it('gives each stage the title the catalog gives it, in catalog order', () => {
      expect(
        guideStages.map((stage) => `${stage.id}:${stage.title}`),
        'the guide stage headings do not match catalog.ts pairwise or in order.',
      ).toEqual(
        CALIBRATION_STAGES.map((stage) => `${stage.id}:${stage.title}`),
      );
    });
  });

  describe('platform capability claims', () => {
    const macSentences = sentences(guide).filter((sentence) =>
      /\bmac ?os\b|\bmacintosh\b|\bdarwin\b/i.test(sentence),
    );

    it('discusses macOS at all', () => {
      // Control for the negative assertion below: if the sentence splitter or the
      // macOS pattern matches nothing, "no sentence claims macOS can install"
      // passes without having read anything.
      expect(
        macSentences.length,
        'no sentence in the user guide mentions macOS, so the assertion that none of ' +
          'them claims macOS can install a profile would prove nothing.',
      ).toBeGreaterThan(0);
    });

    it('states plainly that macOS is export-only', () => {
      expect(
        /does\s+not\s+install\s+a\s+profile\s+directly\s+on\s+macOS/i.test(
          guide,
        ),
        'the guide never states that PFD does not install a profile directly on macOS. ' +
          'CalibrationReportAndProfile.tsx offers only "Export profile…" on darwin and ' +
          'linux; a guide that omits this leaves macOS users looking for a button that ' +
          'is not there.',
      ).toBe(true);
    });

    it('never states or implies that macOS can install a profile', () => {
      const installVerb =
        /\b(install|installs|installed|installing|installation)\b/i;
      const negated =
        /\b(not|never|cannot|can't|no|only|instead of|rather than)\b/i;
      const offending = macSentences.filter(
        (sentence) => installVerb.test(sentence) && !negated.test(sentence),
      );
      expect(
        offending,
        `these sentences mention macOS and an install without negating it: ` +
          `[${offending.join(' | ')}]. macOS is export-only — the workspace writes a ` +
          `file you import through OrcaSlicer yourself, and there is no rollback ` +
          `because nothing was modified.`,
      ).toEqual([]);
    });
  });

  describe('eligibility claims', () => {
    it('states that identity fields never establish eligibility', () => {
      expect(
        /manufacturer, model, alias and transport backend never establish\s+eligibility/i.test(
          guide,
        ),
        'the guide does not state that manufacturer, model, alias and transport backend ' +
          'never establish eligibility. CalibrationPrinterEligibility requires exact ' +
          'literals from PrintFarmer; a printer that merely looks Klipper-shaped is not ' +
          'eligible, and readers assume the opposite unless told.',
      ).toBe(true);
    });

    it('links the official OrcaSlicer calibration wiki', () => {
      expect(
        guide,
        'the guide does not link the official OrcaSlicer calibration wiki, which is the ' +
          'upstream source for what each stage measures.',
      ).toContain('https://github.com/SoftFever/OrcaSlicer/wiki/Calibration');
    });
  });
});
