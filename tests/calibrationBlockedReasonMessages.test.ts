/**
 * Bishop's diagnosis of #740: when PrintFarmer's dispatch-safety gates refuse
 * a calibration print, the server names the specific gate with a machine
 * identifier (`firmware_family_mismatch`, `capabilities_unsatisfied`, and so
 * on). The desktop used to strip that identifier at the IPC boundary, so an
 * operator saw a generic catalogue sentence — the button looked broken.
 *
 * `blockedReasonMessages.ts` is the renderer's translation of that
 * vocabulary. The point of this test file is *not* that a translation exists
 * (compile-time exhaustiveness guarantees that — see the property test
 * below), but that:
 *
 *   1. Every code the server can emit today has an operator-actionable
 *      sentence — not a placeholder, not a blank string.
 *   2. An unknown code is quoted rather than swallowed, so a server that
 *      ships a new gate without a matching client update produces a
 *      *visible*, debuggable message rather than the generic wording this
 *      module exists to remove.
 *   3. The absence of a code (`null`, `undefined`, `''`) returns null — the
 *      caller expresses "no code" once at the call site rather than hunting
 *      for a placeholder sentence.
 *
 * The compile-time property — every value in the union is a key in the
 * record — is enforced by TypeScript itself: adding a code to
 * `KNOWN_BLOCKED_REASON_CODES` without adding wording to
 * `BLOCKED_REASON_MESSAGES` is a `tsc` error. A runtime test cannot express
 * "the type-checker fails," but the pinning test below ensures the runtime
 * mirror of that guarantee is real: every code in the const array returns a
 * non-empty sentence at runtime.
 */

import { describe, expect, it } from 'vitest';
import {
  KNOWN_BLOCKED_REASON_CODES,
  describeBlockedReasonCode,
} from '../src/renderer/calibration/blockedReasonMessages';

describe('describeBlockedReasonCode', () => {
  it('returns null when no code is present', () => {
    // A caller that has no code to translate calls this with `null`,
    // `undefined`, or the empty string (all three appear on the wire in one
    // corner of the server or another). The function returns null in every
    // case, so `calibrationErrorText` can suppress the leading sentence
    // rather than emitting a placeholder like "PrintFarmer refused (no
    // code)".
    expect(describeBlockedReasonCode(null)).toBeNull();
    expect(describeBlockedReasonCode(undefined)).toBeNull();
    expect(describeBlockedReasonCode('')).toBeNull();
  });

  // Every known code returns a specific, non-empty sentence. Regressing any
  // one of these to a generic message reproduces #740. The test loops over
  // the runtime `KNOWN_BLOCKED_REASON_CODES` const rather than a hard-coded
  // list here because it mirrors the type union at runtime — a new code in
  // the array is automatically covered without editing this file.
  it.each(KNOWN_BLOCKED_REASON_CODES)(
    'names the specific dispatch gate for code %s',
    (code) => {
      const message = describeBlockedReasonCode(code);
      expect(message).not.toBeNull();
      // A single space is not a message. Neither is the placeholder sentence
      // an early cut of this module used ("PrintFarmer refused" with no
      // detail): a specific message must be at least a short sentence.
      expect((message ?? '').trim().length).toBeGreaterThanOrEqual(20);
      // "PrintFarmer" is the vocabulary the server uses; the sentence must
      // explain what PrintFarmer did, not what the desktop did. This catches
      // a copy regression where a wording is edited to a generic
      // "the server refused" fallback.
      expect(message).toMatch(/PrintFarmer/);
    },
  );

  it('quotes an unrecognised code rather than swallowing it', () => {
    // A future server-side gate ships before the client is updated. The
    // renderer must not fall back to the generic wording — an operator has
    // to be able to quote the raw token to support. The test asserts the
    // exact token appears in the returned string, which is the debuggable
    // property.
    const unknown = 'made_up_reason_shipped_by_a_new_server';
    const message = describeBlockedReasonCode(unknown);
    expect(message).not.toBeNull();
    expect(message).toContain(unknown);
  });

  it('has no duplicate codes in the const array', () => {
    // A duplicate would still typecheck (a repeated string literal is a
    // valid tuple entry), but would silently double-cover a case in
    // `it.each`. The `Record<Union, string>` map would also collapse a
    // duplicated key into one property. This test pins the array shape.
    const seen = new Set(KNOWN_BLOCKED_REASON_CODES);
    expect(seen.size).toBe(KNOWN_BLOCKED_REASON_CODES.length);
  });
});
