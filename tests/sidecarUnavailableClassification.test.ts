// @vitest-environment node

/**
 * #404: `loadScene`'s `catch` fabricated `sidecarUnavailable`.
 *
 * The `try` awaits exactly one thing, so the arm looked single-caused. It was
 * not. `sidecar.loadRetargetScene` rejects both when the sidecar could not be
 * *asked* and when it *was* asked and answered with an error, and both arrived
 * as a bare `Error`.
 *
 * #404 is explicit that the remedy is not "change the default": one of the two
 * populations was being reported correctly, and replacing the default without
 * splitting them first deletes a true classification while presenting as a
 * repair. So the load-bearing spec in this file is not the one asserting the
 * new code — it is the CONTROL asserting the old code survives on the arm that
 * always deserved it. Without that control, the honest-code assertion is
 * equally satisfied by an unconditional replacement.
 *
 * MUTATIONS RUN (each reverted; control green after)
 *
 *   M-1  `sceneLoadFailure` returns `error('sidecarUnavailable')` for every
 *        cause -- i.e. the pre-#404 behaviour restored.
 *        -> RED. "answered error is not reported as sidecarUnavailable" fails,
 *           naming the fabricated code, and the distinctness spec fails too.
 *
 *   M-2  `sceneLoadFailure` returns the `internalError` envelope for every
 *        cause -- the naive "just change the default" fix #404 warns against.
 *        -> RED. The unreachable-sidecar CONTROL fails, showing the true
 *           classification was deleted. This is the mutation that proves the
 *           control is load-bearing rather than decorative.
 *
 *   M-3  `SidecarRespondedError` reverted to a plain `Error` at its throw site
 *        in `sidecar.ts`, leaving the discriminator in place.
 *        -> RED. Both arms collapse onto `sidecarUnavailable`; proves the
 *           discrimination comes from the thrown type and not from the shape
 *           of the `catch`.
 *
 *   M-4  `loadRetargetScene` stub made to resolve instead of reject.
 *        -> RED. The positive control fails first, so a fixture that stopped
 *           exercising the failure path cannot pass this file silently.
 *
 *   CONTROL  all reverted -> GREEN.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetargetArtifactService } from '../src/main/retargetArtifacts.js';
import { SidecarRespondedError } from '../src/main/sidecar.js';

const temporaryDirectories: string[] = [];
const profileId =
  'snapmaker-u1-orca-presets:profiles/Snapmaker/process/standard.json';

type Outcome = {
  status: string;
  error?: { code?: string; message?: string; action?: string };
};

/**
 * The two ways `loadRetargetScene` can reject, named so the specs below read as
 * claims about causes rather than about fixtures.
 *
 * `unreachable` covers every rejection this client raises when the sidecar
 * could not be asked -- disposed, no channel, timeout, restart mid-request.
 * They are all bare `Error`s, which is exactly why the arm could not be split
 * before #404 introduced a type for the other case.
 */
const causes = {
  unreachable: () =>
    new Error('sidecar unavailable after 3 consecutive failures'),
  answered: () => new SidecarRespondedError('scene could not be parsed'),
};

async function fixture(reject?: () => Error) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u1-404-'));
  temporaryDirectories.push(root);
  const source = path.join(root, 'source.3mf');
  const bytes = Buffer.from('editable');
  await writeFile(source, bytes);
  const sourceHash = createHash('sha256').update(bytes).digest('hex');

  const loadRetargetScene = vi.fn(() =>
    reject ? Promise.reject(reject()) : Promise.resolve({ sceneVersion: 2 }),
  );

  const sidecar = {
    listModels: vi.fn(() =>
      Promise.resolve([
        {
          hash: sourceHash,
          format: 'threeMf',
          locations: [
            {
              rootId: 'root-1',
              path: source,
              rootRelative: 'source.3mf',
              available: true,
            },
          ],
        },
      ]),
    ),
    preflightRetarget: vi.fn(() =>
      Promise.resolve({
        status: 'ok',
        value: {
          accepted: true,
          source: {
            fileName: 'source.3mf',
            byteSize: 8,
            sha256: sourceHash,
            producer: 'OrcaSlicer',
            objectCount: 1,
            buildItemCount: 1,
            plateCount: 1,
            materials: ['PLA'],
            colors: ['#ffffff'],
          },
          recommendation: null,
          blockers: [],
          warnings: [],
          proposedChanges: {},
        },
      }),
    ),
    buildRetarget: vi.fn(),
    validateRetargetOutput: vi.fn(),
    loadRetargetScene,
    scanRoot: vi.fn(() => Promise.resolve({})),
  };

  const service = new RetargetArtifactService({
    sidecar,
    profiles: {
      getPrivateReference: () => ({
        kind: 'bundled',
        targetProfileId: profileId,
      }),
      getFingerprint: () => 'e'.repeat(64),
    },
    dialogs: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
    tempPath: root,
  });
  await service.initialize();

  const preflight = (await service.preflight(1, {
    modelHash: sourceHash,
    rootId: 'root-1',
    profileId,
    objectExclusion: false,
  })) as { status: string; value: { token: string } };

  // Non-vacuity: every spec below reads the response of a `loadScene` call that
  // must actually have been reached. A preflight that failed would leave every
  // later assertion talking about `artifactNotFound` instead.
  expect(preflight.status).toBe('ok');
  expect(preflight.value.token).toEqual(expect.any(String));

  return { service, token: preflight.value.token, loadRetargetScene };
}

async function loadScene(reject?: () => Error): Promise<Outcome> {
  const { service, token, loadRetargetScene } = await fixture(reject);
  const outcome = (await service.loadScene(1, {
    token,
    source: 'source',
  })) as Outcome;

  // Proves the call under test was actually made. A fixture that stopped
  // reaching the sidecar would satisfy an absence assertion with nothing.
  expect(loadRetargetScene).toHaveBeenCalledTimes(1);
  return outcome;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('loadScene splits the two populations that shared its catch', () => {
  it('reports an answered error as something other than an unavailable sidecar', async () => {
    const outcome = await loadScene(causes.answered);

    expect(outcome.status).toBe('error');
    // The fabrication, named. `sidecarUnavailable` tells the operator to
    // restart because the sidecar is not running -- a claim this cause
    // positively excludes, since answering required it to be running.
    expect(outcome.error?.code).not.toBe('sidecarUnavailable');
    expect(outcome.error?.code).toBe('internalError');
  });

  it('CONTROL: still reports an unreachable sidecar as sidecarUnavailable', async () => {
    // The spec that makes the one above mean anything. #404's warning is that
    // replacing the default without splitting the populations deletes a true
    // classification while looking like a repair; this is the assertion that
    // notices. Measured: with `sceneLoadFailure` returning the honest envelope
    // unconditionally, the spec above still passes and this one fails.
    const outcome = await loadScene(causes.unreachable);

    expect(outcome.status).toBe('error');
    expect(outcome.error?.code).toBe('sidecarUnavailable');
  });

  it('gives the two causes different codes rather than a single new default', async () => {
    // Asserts the *relationship*, not two absolute values. A change that moves
    // both arms to the same code -- in either direction -- satisfies neither
    // this nor the pair above, and this one states why in one line.
    const answered = await loadScene(causes.answered);
    const unreachable = await loadScene(causes.unreachable);

    expect(answered.error?.code).toBeDefined();
    expect(unreachable.error?.code).toBeDefined();
    expect(answered.error?.code).not.toBe(unreachable.error?.code);
  });

  it('does not tell the operator to restart when the sidecar demonstrably ran', async () => {
    // The envelope is what an operator acts on at 2am, so the remedy text is
    // part of the contract and not decoration. The old envelope's action was
    // "Try again." with a code that means "the sidecar is down".
    const outcome = await loadScene(causes.answered);

    expect(outcome.error?.message).toBe('The scene could not be loaded.');
    expect(outcome.error?.action).toContain(
      'The sidecar answered, so it is running',
    );
  });

  it('POSITIVE CONTROL: resolves when the sidecar returns a scene', async () => {
    // Guards the fixture itself. Without this, every spec above is satisfiable
    // by a harness whose `loadScene` fails for some unrelated reason -- an
    // expired token, a forbidden owner -- and reports an error code that
    // happens not to be `sidecarUnavailable`.
    const outcome = await loadScene();

    expect(outcome.status).toBe('ok');
    expect(outcome.error).toBeUndefined();
  });
});
