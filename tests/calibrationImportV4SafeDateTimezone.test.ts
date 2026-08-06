/**
 * #381 — `SafeDate` must accept or reject a date on the strength of the input
 * alone, not on the strength of the machine's timezone.
 *
 * WHY THIS FILE EXISTS AND WHY IT LOOKS LIKE THIS
 *
 * The defect these specs pin is invisible to CI *by construction*: UTC is the
 * unique frame in which both range boundaries pass, and every runner in this
 * project is UTC. A spec that does not change the ambient frame therefore
 * cannot fail on the pre-#381 code, no matter which dates it feeds in.
 *
 * That creates a specific trap. `process.env.TZ` is read by V8 when it computes
 * a local-frame value, and a spec that sets it and then quietly keeps running in
 * UTC — because the mutation did not take effect, or because a previous spec
 * left the variable somewhere unexpected — would pass against the broken
 * implementation while appearing to test it. An assertion that cannot fail
 * proves nothing, and a *frame* that never changed is exactly that: the whole
 * experiment silently degenerates into the UTC case.
 *
 * So `inTimeZone` refuses to run its body until it has *measured* that the frame
 * moved, by reading `getTimezoneOffset()` at the very instant under test and
 * comparing it to the offset that timezone must produce there. The frame check
 * is not decoration around the assertion; it is the precondition that makes the
 * assertion mean anything.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { runLegacyBackupPreflight } from '../src/main/calibrationImportV4';

// ---------------------------------------------------------------------------
// Boundary inputs. Both are inside the contract's stated 2000..2100 range.
// ---------------------------------------------------------------------------

/** The first instant the contract admits. */
const LOWER_BOUNDARY = '2000-01-01T00:00:00Z';
/** The last instant the contract admits. */
const UPPER_BOUNDARY = '2100-12-31T23:59:59Z';
/** Mid-range: unaffected by any offset, so it isolates the boundary effect. */
const MID_RANGE = '2050-06-15T12:00:00Z';

/** Genuinely outside the range, and near enough to the edge to be a real test. */
const BELOW_RANGE = '1999-12-31T00:00:00Z';
const ABOVE_RANGE = '2101-01-01T12:00:00Z';

/**
 * Timezones chosen because they bracket UTC.
 *
 * `offsetMinutes` uses `Date.prototype.getTimezoneOffset`'s sign convention:
 * positive means *behind* UTC. It is stated at a fixed `referenceInstant`
 * rather than as a constant for the zone, because an offset is a function of
 * the instant as well as the zone — `America/Los_Angeles` is 480 in January and
 * 420 in June. An earlier draft of this file asserted one constant per zone and
 * was caught by its own frame guard on a June date, which is the behaviour the
 * guard exists for: it refused to run an assertion in a frame it could not
 * confirm, rather than proceeding and reporting a pass.
 */
const WEST_OF_UTC = {
  tz: 'America/Los_Angeles',
  direction: 'behind' as const,
  referenceInstant: '2000-01-01T00:00:00Z',
  referenceOffset: 480,
};
const EAST_OF_UTC = {
  tz: 'Asia/Tokyo',
  direction: 'ahead' as const,
  referenceInstant: '2000-01-01T00:00:00Z',
  referenceOffset: -540,
};

type Zone = typeof WEST_OF_UTC | typeof EAST_OF_UTC;

// ---------------------------------------------------------------------------
// Frame control
// ---------------------------------------------------------------------------

let originalTz: string | undefined;

beforeEach(() => {
  originalTz = process.env.TZ;
});

afterEach(() => {
  // Restore rather than delete: an absent TZ and a TZ of '' are different
  // states, and other specs sharing this worker must see the one they started
  // with.
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

/**
 * Run `body` with the process pinned to `zone`, having first proven the pin
 * took effect.
 *
 * Three checks, and each rules out a different way this file could pass while
 * testing nothing:
 *
 *  - the offset at a fixed reference instant must be exactly the one that zone
 *    mandates, which establishes that the mutation reached V8 *as that specific
 *    zone* rather than merely reaching `process.env`;
 *  - the offset at the instant actually under test must be non-zero, which
 *    establishes the frame is genuinely not UTC — the one frame in which the
 *    pre-#381 defect is unobservable;
 *  - that offset must fall on the expected side of UTC, so a zone that resolved
 *    to some other non-UTC frame cannot satisfy the check by accident.
 *
 * The offset at the instant under test is deliberately *not* compared to a
 * constant: it varies with daylight saving, and pinning it would make the guard
 * fail for reasons that have nothing to do with the property being tested.
 */
async function inTimeZone(
  zone: Zone,
  instant: string,
  body: () => Promise<void>,
): Promise<void> {
  process.env.TZ = zone.tz;

  const referenceOffset = new Date(zone.referenceInstant).getTimezoneOffset();
  expect(
    referenceOffset,
    `TZ=${zone.tz} did not take effect: this spec would have run in the ` +
      `ambient frame and passed against the pre-#381 implementation`,
  ).toBe(zone.referenceOffset);

  const measuredOffset = new Date(instant).getTimezoneOffset();
  expect(
    measuredOffset,
    'the pinned frame must not be UTC, or the boundary defect is unobservable',
  ).not.toBe(0);
  expect(
    measuredOffset > 0 ? 'behind' : 'ahead',
    `TZ=${zone.tz} must sit ${zone.direction} UTC at ${instant}`,
  ).toBe(zone.direction);

  await body();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    tmpdir(),
    `pfd-safedate-tz-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

/**
 * Write a v4 backup whose only unusual property is `exportedAt`.
 *
 * `exportedAt` is the one `SafeDate` field that is required rather than
 * optional, so a rejection here fails the whole import rather than dropping a
 * field — and it is reached through the real preflight entry point, so nothing
 * upstream of the validator can repair the value on its way in.
 */
async function writeBackupWithExportedAt(exportedAt: string): Promise<string> {
  const dir = await createTmpDir();
  const filePath = path.join(dir, 'backup.json');
  await writeFile(
    filePath,
    JSON.stringify({ schemaVersion: 4, exportedAt, projects: [] }),
  );
  return filePath;
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe("#381 SafeDate's verdict is a property of the input, not of the machine", () => {
  it('accepts the lower boundary west of UTC, where the local year reads 1999', async () => {
    await inTimeZone(WEST_OF_UTC, LOWER_BOUNDARY, async () => {
      // Stated as a measurement rather than a comment: this is the precise
      // condition that made the pre-#381 implementation refuse a valid input.
      expect(new Date(LOWER_BOUNDARY).getFullYear()).toBe(1999);
      expect(new Date(LOWER_BOUNDARY).getUTCFullYear()).toBe(2000);

      const filePath = await writeBackupWithExportedAt(LOWER_BOUNDARY);
      const result = await runLegacyBackupPreflight(filePath);

      expect(result.summary.detectedVersion).toBe(4);
      expect(result.parsedBackup).not.toBeNull();
    });
  });

  it('accepts the upper boundary east of UTC, where the local year reads 2101', async () => {
    await inTimeZone(EAST_OF_UTC, UPPER_BOUNDARY, async () => {
      expect(new Date(UPPER_BOUNDARY).getFullYear()).toBe(2101);
      expect(new Date(UPPER_BOUNDARY).getUTCFullYear()).toBe(2100);

      const filePath = await writeBackupWithExportedAt(UPPER_BOUNDARY);
      const result = await runLegacyBackupPreflight(filePath);

      expect(result.summary.detectedVersion).toBe(4);
      expect(result.parsedBackup).not.toBeNull();
    });
  });

  it('accepts both boundaries in both frames, so the verdict no longer varies', async () => {
    // The defect was bidirectional: west of UTC the lower bound over-rejected,
    // east of UTC the upper bound over-rejected. Asserting one direction in one
    // zone would leave the other half unpinned, and a half-fix would stay green.
    for (const zone of [WEST_OF_UTC, EAST_OF_UTC]) {
      for (const boundary of [LOWER_BOUNDARY, UPPER_BOUNDARY, MID_RANGE]) {
        await inTimeZone(zone, boundary, async () => {
          const filePath = await writeBackupWithExportedAt(boundary);
          const result = await runLegacyBackupPreflight(filePath);
          expect(
            result.parsedBackup,
            `${boundary} must be accepted under TZ=${zone.tz}`,
          ).not.toBeNull();
        });
      }
    }
  });
});

describe('#381 the range itself is unchanged: out-of-range dates are still refused', () => {
  // NEGATIVE CONTROL for the fix as a whole. Reading the bound in UTC could in
  // principle have been achieved by weakening the check; these specs establish
  // that it was not. Without them, every assertion above is equally satisfied
  // by a `SafeDate` that accepts everything.

  it('refuses a date below the range, in a frame that would flatter it', async () => {
    // West of UTC, 1999-12-31T00:00:00Z has a local year of 1999 too, so this
    // input is refused under both implementations. The point is that widening
    // the accepted set would show up here.
    await inTimeZone(WEST_OF_UTC, BELOW_RANGE, async () => {
      expect(new Date(BELOW_RANGE).getUTCFullYear()).toBe(1999);

      const filePath = await writeBackupWithExportedAt(BELOW_RANGE);
      await expect(runLegacyBackupPreflight(filePath)).rejects.toMatchObject({
        code: 'LEGACY_BACKUP_INVALID_SCHEMA',
      });
    });
  });

  it('refuses a date above the range, in a frame that would flatter it', async () => {
    await inTimeZone(EAST_OF_UTC, ABOVE_RANGE, async () => {
      expect(new Date(ABOVE_RANGE).getUTCFullYear()).toBe(2101);

      const filePath = await writeBackupWithExportedAt(ABOVE_RANGE);
      await expect(runLegacyBackupPreflight(filePath)).rejects.toMatchObject({
        code: 'LEGACY_BACKUP_INVALID_SCHEMA',
      });
    });
  });

  it('refuses an unparseable date', async () => {
    await inTimeZone(WEST_OF_UTC, MID_RANGE, async () => {
      const filePath = await writeBackupWithExportedAt('not-a-date');
      await expect(runLegacyBackupPreflight(filePath)).rejects.toMatchObject({
        code: 'LEGACY_BACKUP_INVALID_SCHEMA',
      });
    });
  });
});

describe('#381 the frame guard itself', () => {
  it('reports a different offset in each pinned zone, so the pin is doing work', () => {
    // A control on the control. If `process.env.TZ` stopped reaching V8 — a
    // runtime change, a different engine, a worker that pins its own frame —
    // every spec above would degenerate into the UTC case and pass against the
    // very code they exist to reject. This spec fails loudly in that event
    // instead, and it names the reason.
    const measured: number[] = [];
    for (const zone of [WEST_OF_UTC, EAST_OF_UTC]) {
      process.env.TZ = zone.tz;
      measured.push(new Date(zone.referenceInstant).getTimezoneOffset());
    }

    expect(measured).toHaveLength(2);
    expect(new Set(measured).size, 'the two zones must not agree').toBe(2);
    expect(measured).toEqual([
      WEST_OF_UTC.referenceOffset,
      EAST_OF_UTC.referenceOffset,
    ]);
  });
});
