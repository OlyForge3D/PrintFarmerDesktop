import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RetargetWorkflow } from '../src/renderer/retarget/RetargetWorkflow';

vi.mock('../src/renderer/viewer/ModelViewer', () => ({
  ModelViewer: ({ mesh }: { mesh: { objects: Array<{ name: string }> } }) => (
    <div data-testid="retarget-scene">{mesh.objects[0]?.name}</div>
  ),
}));

const profile = {
  id: 'imported:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  source: 'imported' as const,
  displayName: 'Imported U1',
  processName: 'Imported U1',
  machineName: 'Snapmaker U1',
  compatibleFilaments: ['PLA'],
  layerHeight: 0.2,
  category: null,
  bundleCommit: null,
  settingCount: 1,
  settingsSummary: {},
  importedAt: 1,
  fingerprint:
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};
const bundledProfile = {
  ...profile,
  id: 'snapmaker-u1-orca-presets:profiles/Snapmaker/process/standard.json',
  source: 'bundled' as const,
  displayName: 'Bundled U1',
  processName: 'Bundled U1',
  bundleCommit: 'b'.repeat(40),
  importedAt: null,
  fingerprint:
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function preflight(token: string) {
  return {
    status: 'ok' as const,
    value: {
      token,
      report: {
        accepted: true,
        source: {
          fileName: 'project.3mf',
          byteSize: 1,
          sha256: 'a'.repeat(64),
          producer: 'OrcaSlicer',
          machineId: null,
          processId: null,
          layerHeight: 0.2,
          objectCount: 1,
          buildItemCount: 1,
          plateCount: 1,
          materials: ['PLA'],
          colors: ['#fff'],
        },
        recommendation: null,
        blockers: [],
        warnings: [],
        proposedChanges: {},
      },
    },
  };
}

function built() {
  return {
    status: 'ok' as const,
    value: {
      sourceSha256: 'a'.repeat(64),
      outputSha256: 'b'.repeat(64),
      outputFileName: 'project-Snapmaker-U1.3mf',
      targetProfileId: bundledProfile.id,
      removedPartCount: 1,
      preservedPartCount: 4,
      appliedChanges: {},
      warnings: [],
      validation: {
        valid: true,
        sourceSha256: 'a'.repeat(64),
        outputSha256: 'b'.repeat(64),
        sourcePreserved: true,
        sceneCompatibility: { compatible: true, differences: [] },
        invariants: {},
        warnings: [],
        errors: [],
      },
    },
  };
}

function scene(name: string) {
  return {
    status: 'ok' as const,
    value: {
      sceneVersion: 2 as const,
      positions: [],
      indices: [],
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      sourceFormat: 'threeMf' as const,
      faceColors: null,
      parts: [],
      objects: [{ name }],
      rootObjectIds: [],
      plates: [],
    },
  };
}

describe('RetargetWorkflow', () => {
  it('reloads the profile catalog after an initial failure', async () => {
    const api = {
      listRetargetProfiles: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'error',
          error: {
            domain: 'electron',
            code: 'sidecarUnavailable',
            message: 'Profiles are temporarily unavailable.',
            action: 'Retry.',
            part: null,
            setting: null,
          },
        })
        .mockResolvedValueOnce({
          status: 'ok',
          value: { profiles: [bundledProfile], warnings: [] },
        }),
      disposeRetarget: vi.fn().mockResolvedValue({ disposed: true }),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });
    render(
      <RetargetWorkflow
        target={{ modelHash: 'a'.repeat(64), rootId: 'root', name: 'Project' }}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Profiles are temporarily unavailable.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('radio', { name: /Bundled U1/ }),
    ).toBeInTheDocument();
    expect(api.listRetargetProfiles).toHaveBeenCalledTimes(2);
  });

  it('surfaces profile import and catalog refresh errors', async () => {
    const api = {
      listRetargetProfiles: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'ok',
          value: { profiles: [bundledProfile], warnings: [] },
        })
        .mockResolvedValueOnce({
          status: 'error',
          error: {
            domain: 'native',
            code: 'profileHashMismatch',
            message: 'The bundled profile hash does not match.',
            action: 'Restore the application profile bundle.',
            part: null,
            setting: null,
          },
        }),
      importRetargetProfile: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'error',
          error: {
            domain: 'electron',
            code: 'profileImportFailed',
            message: 'The reference contains unsupported settings.',
            action: 'Remove the unsupported settings.',
            part: null,
            setting: null,
          },
        })
        .mockResolvedValueOnce({
          status: 'ok',
          profile,
          duplicate: false,
        }),
      disposeRetarget: vi.fn().mockResolvedValue({ disposed: true }),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });
    render(
      <RetargetWorkflow
        target={{ modelHash: 'a'.repeat(64), rootId: 'root', name: 'Project' }}
        onClose={vi.fn()}
      />,
    );
    const importButton = await screen.findByRole('button', {
      name: 'Import U1 reference',
    });

    fireEvent.click(importButton);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The reference contains unsupported settings.',
    );

    fireEvent.click(importButton);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The bundled profile hash does not match.',
      ),
    );
  });

  it('requires an explicit imported target selection', async () => {
    const api = {
      listRetargetProfiles: vi.fn().mockResolvedValue({
        status: 'ok',
        value: { profiles: [profile], warnings: [] },
      }),
      preflightRetarget: vi.fn().mockResolvedValue({
        status: 'error',
        error: {
          domain: 'electron',
          code: 'sourceChanged',
          message: 'changed',
          action: 'retry',
          part: null,
          setting: null,
        },
      }),
      disposeRetarget: vi.fn().mockResolvedValue({ disposed: true }),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });
    render(
      <RetargetWorkflow
        target={{ modelHash: 'a'.repeat(64), rootId: 'root', name: 'Project' }}
        onClose={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'Prepare for Snapmaker U1' }),
    ).toBeInTheDocument();
    const build = screen.getByRole('button', { name: 'Build review copy' });
    expect(build).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Imported U1/ }));
    await waitFor(() => expect(api.preflightRetarget).toHaveBeenCalledTimes(1));
    expect(api.disposeRetarget).toHaveBeenCalledTimes(0);
  });

  it('contains focus and suppresses Escape while a build is active', async () => {
    const onClose = vi.fn();
    const build = new Promise<never>(() => {});
    const api = {
      listRetargetProfiles: vi.fn().mockResolvedValue({
        status: 'ok',
        value: { profiles: [profile], warnings: [] },
      }),
      preflightRetarget: vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          token: 't'.repeat(43),
          report: {
            accepted: true,
            source: {
              fileName: 'project.3mf',
              byteSize: 1,
              sha256: 'a'.repeat(64),
              producer: 'OrcaSlicer',
              machineId: null,
              processId: null,
              layerHeight: 0.2,
              objectCount: 1,
              buildItemCount: 1,
              plateCount: 1,
              materials: ['PLA'],
              colors: ['#fff'],
            },
            recommendation: null,
            blockers: [],
            warnings: [],
            proposedChanges: {},
          },
        },
      }),
      buildRetarget: vi.fn(() => build),
      disposeRetarget: vi.fn().mockResolvedValue({ disposed: true }),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });
    render(
      <>
        <button type="button">Background action</button>
        <RetargetWorkflow
          target={{
            modelHash: 'a'.repeat(64),
            rootId: 'root',
            name: 'Project',
          }}
          onClose={onClose}
        />
      </>,
    );

    const close = await screen.findByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    screen.getByRole('button', { name: 'Background action' }).focus();
    expect(close).toHaveFocus();

    fireEvent.click(screen.getByRole('radio', { name: /Imported U1/ }));
    const buildButton = await screen.findByRole('button', {
      name: 'Build review copy',
    });
    await waitFor(() => expect(buildButton).toBeEnabled());
    fireEvent.click(buildButton);
    await screen.findByText('Working…');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(close).toBeDisabled();
  });

  it('ignores stale imported catalog responses and disposes a late preflight on unmount', async () => {
    const firstImport = deferred<{
      status: 'ok';
      profile: typeof profile;
      duplicate: boolean;
    }>();
    const secondImport = deferred<{
      status: 'ok';
      profile: typeof profile;
      duplicate: boolean;
    }>();
    const latePreflight = deferred<ReturnType<typeof preflight>>();
    const importedB = {
      ...profile,
      id: `imported:${'c'.repeat(64)}`,
      displayName: 'Imported B',
      fingerprint: 'c'.repeat(64),
    };
    const api = {
      listRetargetProfiles: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'ok',
          value: { profiles: [bundledProfile], warnings: [] },
        })
        .mockResolvedValueOnce({
          status: 'ok',
          value: { profiles: [bundledProfile, importedB], warnings: [] },
        }),
      importRetargetProfile: vi
        .fn()
        .mockReturnValueOnce(firstImport.promise)
        .mockReturnValueOnce(secondImport.promise),
      preflightRetarget: vi.fn(() => latePreflight.promise),
      disposeRetarget: vi.fn().mockResolvedValue({ disposed: true }),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });
    const rendered = render(
      <RetargetWorkflow
        target={{ modelHash: 'a'.repeat(64), rootId: 'root', name: 'Project' }}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole('radio', { name: /Bundled U1/ });
    const importButton = screen.getByRole('button', {
      name: 'Import U1 reference',
    });
    fireEvent.click(importButton);
    fireEvent.click(importButton);
    secondImport.resolve({
      status: 'ok',
      profile: importedB,
      duplicate: false,
    });
    await waitFor(() =>
      expect(api.preflightRetarget).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: importedB.id }),
      ),
    );
    firstImport.resolve({
      status: 'ok',
      profile,
      duplicate: false,
    });
    await Promise.resolve();
    expect(api.listRetargetProfiles).toHaveBeenCalledTimes(2);
    expect(api.preflightRetarget).toHaveBeenCalledTimes(1);

    rendered.unmount();
    latePreflight.resolve(preflight('z'.repeat(43)));
    await waitFor(() =>
      expect(api.disposeRetarget).toHaveBeenCalledWith({
        token: 'z'.repeat(43),
      }),
    );
  });

  it('keeps the newest source/output scene response', async () => {
    const initialOutputScene = deferred<ReturnType<typeof scene>>();
    const newestOutputScene = deferred<ReturnType<typeof scene>>();
    const sourceScene = deferred<ReturnType<typeof scene>>();
    let outputRequests = 0;
    let sourceRequests = 0;
    const api = {
      listRetargetProfiles: vi.fn().mockResolvedValue({
        status: 'ok',
        value: { profiles: [bundledProfile, profile], warnings: [] },
      }),
      preflightRetarget: vi.fn().mockResolvedValue(preflight('t'.repeat(43))),
      buildRetarget: vi.fn().mockResolvedValue(built()),
      loadRetargetScene: vi.fn(({ source }: { source: 'source' | 'output' }) =>
        source === 'source'
          ? ++sourceRequests === 1
            ? sourceScene.promise
            : sourceRequests === 2
              ? Promise.resolve({
                  status: 'error' as const,
                  error: {
                    domain: 'electron' as const,
                    code: 'artifactNotFound' as const,
                    message: 'The source scene is temporarily unavailable.',
                    action: 'Retry the scene.',
                    part: null,
                    setting: null,
                  },
                })
              : Promise.resolve(scene('retried-source-scene'))
          : ++outputRequests === 1
            ? initialOutputScene.promise
            : newestOutputScene.promise,
      ),
      disposeRetarget: vi.fn().mockResolvedValue({ disposed: true }),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });
    render(
      <RetargetWorkflow
        target={{ modelHash: 'a'.repeat(64), rootId: 'root', name: 'Project' }}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: /Bundled U1/ }));
    const buildButton = await screen.findByRole('button', {
      name: 'Build review copy',
    });
    await waitFor(() => expect(buildButton).toBeEnabled());
    fireEvent.click(buildButton);
    await screen.findByRole('heading', { name: 'Review changes' });
    initialOutputScene.resolve(scene('initial-output-scene'));
    expect(await screen.findByTestId('retarget-scene')).toHaveTextContent(
      'initial-output-scene',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.queryByTestId('retarget-scene')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading comparison scene',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Snapmaker U1 output' }),
    );
    newestOutputScene.resolve(scene('newest-output-scene'));
    expect(await screen.findByTestId('retarget-scene')).toHaveTextContent(
      'newest-output-scene',
    );
    sourceScene.resolve(scene('stale-source-scene'));
    await Promise.resolve();
    expect(screen.getByTestId('retarget-scene')).toHaveTextContent(
      'newest-output-scene',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The source scene is temporarily unavailable.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry scene' }));
    expect(await screen.findByTestId('retarget-scene')).toHaveTextContent(
      'retried-source-scene',
    );
  });

  it('keeps a built artifact reviewable after save cancel and collision', async () => {
    const api = {
      listRetargetProfiles: vi.fn().mockResolvedValue({
        status: 'ok',
        value: { profiles: [bundledProfile], warnings: [] },
      }),
      preflightRetarget: vi.fn().mockResolvedValue(preflight('t'.repeat(43))),
      buildRetarget: vi.fn().mockResolvedValue(built()),
      loadRetargetScene: vi.fn().mockResolvedValue(scene('output-scene')),
      saveRetargetAs: vi
        .fn()
        .mockResolvedValueOnce({ status: 'canceled' })
        .mockResolvedValueOnce({
          status: 'error',
          error: {
            domain: 'electron',
            code: 'saveDestinationExists',
            message: 'That file already exists.',
            action: 'Pick another name.',
            part: null,
            setting: null,
          },
        })
        .mockResolvedValueOnce({
          status: 'ok',
          fileName: 'saved.3mf',
          refreshWarning: null,
        }),
      disposeRetarget: vi.fn().mockResolvedValue({ disposed: true }),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });
    render(
      <RetargetWorkflow
        target={{ modelHash: 'a'.repeat(64), rootId: 'root', name: 'Project' }}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('radio', { name: /Bundled U1/ }));
    const buildButton = await screen.findByRole('button', {
      name: 'Build review copy',
    });
    await waitFor(() => expect(buildButton).toBeEnabled());
    fireEvent.click(buildButton);
    await screen.findByRole('heading', { name: 'Review changes' });

    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Review changes' }),
      ).toBeVisible(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That file already exists.',
    );
    expect(
      screen.getByRole('heading', { name: 'Review changes' }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
    expect(await screen.findAllByText(/Saved saved\.3mf/)).toHaveLength(2);
  });
});
