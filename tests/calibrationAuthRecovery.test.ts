// @vitest-environment node

/**
 * Bounds on re-authentication, tested in isolation from the transport.
 *
 * These properties are load-bearing but easy to lose: the handler-level suite
 * still passes with the single-flight removed, because the token provider
 * coalesces forced exchanges as well. Two layers holding the same bound is
 * defence in depth; a test that cannot tell which one is holding it is not a
 * test of either.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_RECOVERY_COOLDOWN_MS,
  CalibrationAuthRecovery,
} from '../src/main/calibrationAuthRecovery.js';
import { ServerProfileCalibrationTokenProvider } from '../src/main/calibrationService.js';

const PROFILE = '11111111-1111-4111-8111-111111111111';

describe('recovery attempts are bounded per profile', () => {
  it('performs one exchange for concurrent rejections and reports the shared result', async () => {
    const recovery = new CalibrationAuthRecovery<string>();
    let attempts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempt = async () => {
      attempts += 1;
      await gate;
      return { status: 'reauthenticated' as const, evidence: 'caps-v2' };
    };

    const all = Promise.all([
      recovery.noteUnauthenticated(PROFILE, attempt),
      recovery.noteUnauthenticated(PROFILE, attempt),
      recovery.noteUnauthenticated(PROFILE, attempt),
    ]);
    release?.();
    const outcomes = await all;

    expect(attempts).toBe(1);
    expect(outcomes.filter((outcome) => outcome.attempted)).toHaveLength(1);
    // The callers that joined still learn whether they have a session, because
    // that is what decides the guidance they show.
    expect(outcomes.every((outcome) => outcome.authenticated)).toBe(true);
    expect(outcomes.every((outcome) => outcome.evidence === 'caps-v2')).toBe(
      true,
    );
  });

  it('absorbs a rejection that arrives inside the cooldown', async () => {
    let clock = 1_000;
    const recovery = new CalibrationAuthRecovery<string>(() => clock);
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      return Promise.resolve({
        status: 'stillUnauthenticated' as const,
        evidence: null,
      });
    };

    const first = await recovery.noteUnauthenticated(PROFILE, attempt);
    clock += AUTH_RECOVERY_COOLDOWN_MS - 1;
    const second = await recovery.noteUnauthenticated(PROFILE, attempt);

    expect(first.attempted).toBe(true);
    expect(second.attempted).toBe(false);
    expect(second.status).toBe('cooldown');
    // A revoked key answering 401 to every request must not produce an
    // exchange per request.
    expect(attempts).toBe(1);
  });

  it('attempts again once the cooldown has passed', async () => {
    let clock = 1_000;
    const recovery = new CalibrationAuthRecovery<string>(() => clock);
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      return Promise.resolve({
        status: 'reauthenticated' as const,
        evidence: 'caps-v2',
      });
    };

    await recovery.noteUnauthenticated(PROFILE, attempt);
    clock += AUTH_RECOVERY_COOLDOWN_MS + 1;
    await recovery.noteUnauthenticated(PROFILE, attempt);

    expect(attempts).toBe(2);
  });

  it('reports a throwing attempt as a failed exchange rather than raising', async () => {
    const recovery = new CalibrationAuthRecovery<string>();
    const outcome = await recovery.noteUnauthenticated(PROFILE, () => {
      throw new Error('identity endpoint unreachable');
    });

    // The operator is acting on the original rejection. An error about the
    // diagnostic attempt would replace something they can act on with
    // something they cannot.
    expect(outcome.status).toBe('exchangeFailed');
    expect(outcome.authenticated).toBe(false);
    expect(outcome.evidence).toBeNull();
  });

  it('forgets the cooldown when a profile is discarded', async () => {
    const clock = 1_000;
    const recovery = new CalibrationAuthRecovery<string>(() => clock);
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      return Promise.resolve({
        status: 'reauthenticated' as const,
        evidence: 'caps-v2',
      });
    };

    await recovery.noteUnauthenticated(PROFILE, attempt);
    recovery.forgetProfile(PROFILE);
    await recovery.noteUnauthenticated(PROFILE, attempt);

    expect(attempts).toBe(2);
  });
});

describe('forced token exchanges are coalesced across layers', () => {
  const profileService = (counter: { exchanges: number }) =>
    ({
      getAuthenticatedContext: () =>
        Promise.resolve({
          profile: { id: PROFILE, baseUrl: 'http://farm.local' },
          token: `jwt-${counter.exchanges}`,
          serverBinding: 'binding-abc',
        }),
      getAuthenticatedServerContext: () => {
        counter.exchanges += 1;
        return Promise.resolve({
          baseUrl: 'http://farm.local',
          token: `jwt-${counter.exchanges}`,
          binding: 'binding-abc',
        });
      },
    }) as never;

  it('exchanges once when both layers react to the same rejection', async () => {
    const counter = { exchanges: 0 };
    let clock = 5_000;
    const provider = new ServerProfileCalibrationTokenProvider(
      profileService(counter),
      () => clock,
    );

    // The HTTP client renews for the read it may retry...
    const first = await provider.getAuthenticatedContext(
      PROFILE,
      'http://farm.local',
      true,
    );
    clock += 5;
    // ...and the recovery path renews to re-read capabilities.
    const second = await provider.getAuthenticatedContext(
      PROFILE,
      'http://farm.local',
      true,
    );

    expect(counter.exchanges).toBe(1);
    expect(second.token).toBe(first.token);
  });

  it('exchanges again for a rejection that is genuinely later', async () => {
    const counter = { exchanges: 0 };
    let clock = 5_000;
    const provider = new ServerProfileCalibrationTokenProvider(
      profileService(counter),
      () => clock,
    );

    await provider.getAuthenticatedContext(PROFILE, 'http://farm.local', true);
    // Well beyond the coalescing window — a token minted this long ago can
    // legitimately have been revoked or aged out since.
    clock += 15 * 60 * 1000;
    await provider.getAuthenticatedContext(PROFILE, 'http://farm.local', true);

    expect(counter.exchanges).toBe(2);
  });

  it('shares one exchange between concurrent forced refreshes', async () => {
    const counter = { exchanges: 0 };
    const provider = new ServerProfileCalibrationTokenProvider(
      profileService(counter),
      () => 0,
    );

    await Promise.all([
      provider.getAuthenticatedContext(PROFILE, 'http://farm.local', true),
      provider.getAuthenticatedContext(PROFILE, 'http://farm.local', true),
    ]);

    expect(counter.exchanges).toBe(1);
  });
});

// Keeps vitest's unhandled-rejection reporting honest if a test above leaks.
afterEach(() => {
  vi.restoreAllMocks();
});
