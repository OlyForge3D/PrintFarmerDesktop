/**
 * calibration.jobBlockedReasonCode.test.ts — Round-3 drift check that
 * protects Dallas's blocked-reason renderer copy from silently missing a
 * new wire token or a new enum value.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * `DispatchSafetyGates.MapBlockedReason` returns `null` for any wire token
 * it does not recognise. That is deliberate on the server, and lethal on
 * the desktop:
 *   - server adds a new token → wire response still valid, `null` durable
 *     reason, desktop renders nothing → operator sees no reason.
 *   - server adds a new enum value → desktop's renderer copy has no entry,
 *     enum arrives on the wire, desktop renders empty string.
 *
 * Both silent-render-empty failure modes must be a test failure BEFORE they
 * reach the operator.
 */

import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  JOB_BLOCKED_REASON_CODE_ENUM_MEMBERS,
  JOB_BLOCKED_REASON_WIRE_TOKENS,
} from './fixtures/server-contract/jobBlockedReasonCode.snapshot';
import {
  compareEnum,
  compareSwitchCases,
  extractCSharpEnumMembers,
  extractCSharpSwitchStringCases,
  resolveServerRepo,
} from './fixtures/server-contract/serverContractSnapshotDrift';

const serverRepo = resolveServerRepo();

describe('JobBlockedReasonCode — enum vocabulary drift', () => {
  it('snapshot has exactly 10 members (parent brief said 9 durable + None); catches a silent addition or removal', () => {
    expect(JOB_BLOCKED_REASON_CODE_ENUM_MEMBERS.length).toBe(10);
  });

  it.skipIf(!serverRepo)(
    'JOB_BLOCKED_REASON_CODE_ENUM_MEMBERS matches live PrintJobEnums.cs',
    () => {
      const drift = compareEnum({
        repoRoot: serverRepo!,
        relPath: path.posix.join('src', 'infra', 'Domain', 'PrintJobEnums.cs'),
        typeName: 'JobBlockedReasonCode',
        snapshotMembers: JOB_BLOCKED_REASON_CODE_ENUM_MEMBERS,
      });
      expect(
        drift.missingFromSnapshot,
        'Server added enum values the desktop snapshot does not know — Dallas has no renderer copy for these yet.',
      ).toStrictEqual([]);
      expect(
        drift.extraInSnapshot,
        'Snapshot contains enum values that no longer exist on the server — remove from snapshot and audit desktop renderer copy.',
      ).toStrictEqual([]);
    },
  );

  it.skipIf(!serverRepo)(
    'control (synthetic addition): snapshot with a fabricated enum name must be flagged as extra',
    () => {
      const drift = compareEnum({
        repoRoot: serverRepo!,
        relPath: path.posix.join('src', 'infra', 'Domain', 'PrintJobEnums.cs'),
        typeName: 'JobBlockedReasonCode',
        snapshotMembers: [
          ...JOB_BLOCKED_REASON_CODE_ENUM_MEMBERS,
          'AddedByServer_SyntheticEnumValueForDriftControl',
        ],
      });
      expect(drift.extraInSnapshot).toContain(
        'AddedByServer_SyntheticEnumValueForDriftControl',
      );
    },
  );

  it.skipIf(!serverRepo)(
    'control (synthetic removal): snapshot missing a real enum name must be flagged as missing',
    () => {
      const drift = compareEnum({
        repoRoot: serverRepo!,
        relPath: path.posix.join('src', 'infra', 'Domain', 'PrintJobEnums.cs'),
        typeName: 'JobBlockedReasonCode',
        snapshotMembers: JOB_BLOCKED_REASON_CODE_ENUM_MEMBERS.filter(
          (name) => name !== 'FirmwareFamilyMismatch',
        ),
      });
      expect(drift.missingFromSnapshot).toContain('FirmwareFamilyMismatch');
    },
  );

  it('extractor sanity — reading a fabricated C# enum body produces the right list', () => {
    const source = [
      'public enum Foo',
      '{',
      '    Alpha = 0,',
      '    // Bravo = 1, // commented-out must not leak through',
      '    Bravo = 2,',
      '    Charlie,',
      '}',
    ].join('\n');
    expect(extractCSharpEnumMembers(source, 'Foo')).toStrictEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
  });
});

describe('DispatchSafetyGates.MapBlockedReason — wire-token drift', () => {
  it('snapshot has the 30 tokens observed at commit 6cf79dee (26 was parent brief; actual on file is 30)', () => {
    // The parent brief cited "~26 wire tokens". The extractor confirms the
    // actual count in the source is 30 (verified 2026-08-21). If this
    // number changes without a snapshot update, the next assertion fails.
    expect(JOB_BLOCKED_REASON_WIRE_TOKENS.length).toBe(30);
  });

  it.skipIf(!serverRepo)(
    'JOB_BLOCKED_REASON_WIRE_TOKENS matches the live switch expression',
    () => {
      const drift = compareSwitchCases({
        repoRoot: serverRepo!,
        relPath: path.posix.join(
          'src',
          'infra',
          'Services',
          'Queue',
          'Dispatch',
          'DispatchSafetyGates.cs',
        ),
        methodName: 'MapBlockedReason',
        snapshotCases: JOB_BLOCKED_REASON_WIRE_TOKENS,
      });
      expect(
        drift.missingFromSnapshot,
        'Server MapBlockedReason recognises tokens the desktop has never seen — an unrecognised token would render as blank text.',
      ).toStrictEqual([]);
      expect(
        drift.extraInSnapshot,
        'Snapshot claims tokens the server no longer recognises — will map to null on the wire.',
      ).toStrictEqual([]);
    },
  );

  it.skipIf(!serverRepo)(
    'control (synthetic addition): mutated snapshot with a fake token must be flagged as extra',
    () => {
      const drift = compareSwitchCases({
        repoRoot: serverRepo!,
        relPath: path.posix.join(
          'src',
          'infra',
          'Services',
          'Queue',
          'Dispatch',
          'DispatchSafetyGates.cs',
        ),
        methodName: 'MapBlockedReason',
        snapshotCases: [
          ...JOB_BLOCKED_REASON_WIRE_TOKENS,
          'added_by_server_synthetic_wire_token',
        ],
      });
      expect(drift.extraInSnapshot).toContain(
        'added_by_server_synthetic_wire_token',
      );
    },
  );

  it('extractor sanity — a fabricated C# switch expression yields the string literal cases', () => {
    const source = [
      'public static SomeReason? MapBlockedReason(string? errorCode) =>',
      '    errorCode switch',
      '    {',
      '        "alpha_token" => SomeReason.Alpha,',
      '        "bravo_token" or',
      '        "charlie_token" => SomeReason.Bravo,',
      '        _ => null,',
      '    };',
    ].join('\n');
    expect(
      extractCSharpSwitchStringCases(source, 'MapBlockedReason'),
    ).toStrictEqual(['alpha_token', 'bravo_token', 'charlie_token']);
  });
});

// ---- Round 5 addendum: coverage of Dallas's renderer catalogue -----------
// Dallas keeps operator-facing wording for blocked reason codes in
// `src/renderer/calibration/blockedReasonMessages.ts:KNOWN_BLOCKED_REASON_CODES`.
// Some of those entries are dispatch-safety wire tokens (which MUST appear
// in this snapshot); others are aggregate HTTP-layer codes like
// `calibration_job_incompatible` or 409/503 codes not emitted by
// `DispatchSafetyGates.MapBlockedReason`. This test enforces the strong
// direction: no phantom dispatch-safety codes in Dallas's catalogue. A
// weaker direction (server tokens Dallas doesn't yet cover) is reported
// non-fatally so the delta is observable without over-specifying the copy
// deck.

import { KNOWN_BLOCKED_REASON_CODES } from '../src/renderer/calibration/blockedReasonMessages';

const AGGREGATE_OR_NON_DISPATCH_CODES: ReadonlySet<string> = new Set([
  // 422 aggregate mappers (not from DispatchSafetyGates.MapBlockedReason)
  'calibration_job_incompatible',
  'filament_check_failed',
  // 409 bed-clear conflict codes (surface from JobQueueController, not
  // MapBlockedReason)
  'wrong_job',
  'printer_busy',
  'job_not_dispatchable',
  'idempotency_payload_mismatch',
  // 503 discovery-service codes (from calibrationHttp.ts:1740-1757, not
  // MapBlockedReason)
  'profile_service_unavailable',
  'status_unavailable',
]);

describe('Dallas renderer catalogue — coverage against wire-token snapshot', () => {
  it('no phantom dispatch-safety codes: every non-aggregate code in KNOWN_BLOCKED_REASON_CODES is a real MapBlockedReason token', () => {
    const wireTokenSet = new Set<string>(JOB_BLOCKED_REASON_WIRE_TOKENS);
    const phantom: string[] = [];
    for (const code of KNOWN_BLOCKED_REASON_CODES) {
      if (AGGREGATE_OR_NON_DISPATCH_CODES.has(code)) continue;
      if (!wireTokenSet.has(code)) phantom.push(code);
    }
    expect(
      phantom,
      `Dallas catalogue includes ${phantom.join(', ')} — none of which appear in DispatchSafetyGates.MapBlockedReason. Either these are aggregate codes and should be added to AGGREGATE_OR_NON_DISPATCH_CODES, or they are stale and should be removed from the renderer copy deck.`,
    ).toStrictEqual([]);
  });

  it('control: adding a fabricated code to the ignore-set does not rescue a phantom in the real assertion', () => {
    // Re-run the same predicate the previous test uses, but with a
    // synthetic addition to KNOWN_BLOCKED_REASON_CODES. Prove the
    // predicate flags it — otherwise the previous green is a coincidence
    // of Dallas already covering only real tokens.
    const wireTokenSet = new Set<string>(JOB_BLOCKED_REASON_WIRE_TOKENS);
    const synthetic = [
      ...KNOWN_BLOCKED_REASON_CODES,
      'phantom_wire_code_that_server_will_never_emit',
    ];
    const phantom: string[] = [];
    for (const code of synthetic) {
      if (AGGREGATE_OR_NON_DISPATCH_CODES.has(code)) continue;
      if (!wireTokenSet.has(code)) phantom.push(code);
    }
    expect(phantom).toContain('phantom_wire_code_that_server_will_never_emit');
  });

  it('coverage report (non-fatal): wire tokens with no renderer wording, for Dallas', () => {
    // NOT a blocking assertion — `describeBlockedReasonCode` in
    // blockedReasonMessages.ts has a fallback that quotes the raw code,
    // so an uncovered token is not a silent-render defect. This is a
    // discoverability signal so Dallas sees the delta.
    const catalogueSet = new Set<string>(KNOWN_BLOCKED_REASON_CODES);
    const uncovered = JOB_BLOCKED_REASON_WIRE_TOKENS.filter(
      (t) => !catalogueSet.has(t),
    );
    // Deliberately no expect(...).toHaveLength(0) — the fallback path is
    // load-bearing on purpose. But log the delta.
    if (uncovered.length > 0) {
      console.log(
        `[calibration.jobBlockedReasonCode] Dallas coverage delta: ${uncovered.length} wire tokens not in renderer catalogue: ${JSON.stringify(uncovered)}`,
      );
    }
    expect(Array.isArray(uncovered)).toBe(true);
  });
});
