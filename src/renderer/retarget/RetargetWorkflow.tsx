import { useEffect, useRef, useState } from 'react';
import { ModelViewer } from '../viewer/ModelViewer';
import { toViewerSceneMesh, type SceneMesh } from '../viewer/types';
import {
  useRetargetWorkflow,
  type RetargetTarget,
} from './useRetargetWorkflow';

export function RetargetWorkflow({
  target,
  onClose,
}: {
  target: RetargetTarget;
  onClose: () => void;
}): React.JSX.Element {
  const flow = useRetargetWorkflow(target, onClose);
  const { close, phase } = flow;
  const dialog = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const [scene, setScene] = useState<'source' | 'output'>('output');
  const [mesh, setMesh] = useState<SceneMesh | null>(null);
  const sceneEpoch = useRef(0);
  useEffect(() => {
    if (flow.phase !== 'review' || !flow.token) return;
    const request = ++sceneEpoch.current;
    void window.printFarmer
      .loadRetargetScene({ token: flow.token, source: scene })
      .then((result) => {
        if (request === sceneEpoch.current && result.status === 'ok')
          setMesh(toViewerSceneMesh(result.value));
      })
      .catch(() => {
        if (request === sceneEpoch.current) setMesh(null);
      });
  }, [flow.phase, flow.token, scene]);
  useEffect(() => {
    closeButton.current?.focus();
    const handle = (event: KeyboardEvent): void => {
      if (
        event.key === 'Escape' &&
        phase !== 'building' &&
        phase !== 'saving'
      ) {
        event.preventDefault();
        close();
      }
      if (event.key === 'Tab' && dialog.current) {
        const nodes = dialog.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        );
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const containFocus = (event: FocusEvent): void => {
      if (
        event.target instanceof Node &&
        dialog.current &&
        !dialog.current.contains(event.target)
      ) {
        closeButton.current?.focus();
      }
    };
    document.addEventListener('keydown', handle);
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('keydown', handle);
      document.removeEventListener('focusin', containFocus);
    };
  }, [close, phase]);
  const resultValue =
    flow.report &&
    (flow.report.status === 'ok' || flow.report.status === 'blocked')
      ? flow.report.value
      : null;
  const preflight =
    resultValue && typeof resultValue === 'object' && 'report' in resultValue
      ? (
          resultValue as {
            report: {
              source: { fileName: string };
              warnings: Array<{ code: string; message: string }>;
              proposedChanges: Record<
                string,
                Array<{ code: string; message: string }>
              >;
            };
          }
        ).report
      : null;
  const build =
    resultValue &&
    typeof resultValue === 'object' &&
    'validation' in resultValue
      ? (resultValue as { validation: { sourcePreserved: boolean } })
      : null;
  return (
    <div className="retarget-backdrop">
      <section
        ref={dialog}
        className="retarget-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="retarget-title"
        aria-describedby="retarget-description"
      >
        <div className="retarget-live" aria-live="polite">
          {flow.phase === 'building'
            ? 'Building Snapmaker U1 project.'
            : flow.message}
        </div>
        <header>
          <div>
            <h2 id="retarget-title">Prepare for Snapmaker U1</h2>
            <p id="retarget-description">
              Create a new Snapmaker U1 project. Your source file will not be
              changed.
            </p>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={flow.close}
            disabled={flow.phase === 'building' || flow.phase === 'saving'}
          >
            Close
          </button>
        </header>
        {flow.phase === 'loading' ||
        flow.phase === 'building' ||
        flow.phase === 'saving' ? (
          <p role="status">Working…</p>
        ) : null}
        {flow.phase === 'error' ? (
          <p role="alert">
            {flow.message}
            <button type="button" onClick={flow.close}>
              Close
            </button>
          </p>
        ) : null}
        {flow.phase === 'ready' || flow.phase === 'blocked' ? (
          <>
            <fieldset>
              <legend>Choose a target profile</legend>
              {flow.profiles.map((profile) => (
                <label key={profile.id}>
                  <input
                    type="radio"
                    name="target-profile"
                    checked={flow.selectedId === profile.id}
                    onChange={() => flow.select(profile.id)}
                  />
                  {profile.displayName} ({profile.source})
                </label>
              ))}
              <button type="button" onClick={() => void flow.importProfile()}>
                Import U1 reference
              </button>
            </fieldset>
            {flow.profileWarnings.map((warning) => (
              <p key={warning} role="status">
                {warning}
              </p>
            ))}
            <label>
              <input
                type="checkbox"
                checked={flow.objectExclusion}
                onChange={(event) => flow.setExclusion(event.target.checked)}
              />
              Exclude objects by plate
            </label>
            {preflight ? (
              <>
                <p>{preflight.source.fileName}</p>
                {preflight.warnings.map((warning) => (
                  <p key={`${warning.code}-${warning.message}`} role="status">
                    {warning.message}
                  </p>
                ))}
              </>
            ) : null}
            {flow.phase === 'blocked' ? (
              <div role="alert">
                <p>Resolve the listed blockers before building.</p>
                {flow.report?.status === 'blocked' ? (
                  <ul>
                    {flow.report.blockers.map((blocker) => (
                      <li key={`${blocker.code}-${blocker.message}`}>
                        <strong>{blocker.title}</strong>: {blocker.message}{' '}
                        {blocker.action}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {preflight &&
            'proposedChanges' in preflight &&
            Object.keys(preflight.proposedChanges).length > 0 ? (
              <section>
                <h3>Proposed changes</h3>
                {Object.entries(preflight.proposedChanges).map(
                  ([group, changes]) => (
                    <div key={group}>
                      <h4>{group}</h4>
                      <ul>
                        {changes.map((change, index) => (
                          <li key={`${change.code}-${index}`}>
                            {change.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ),
                )}
              </section>
            ) : null}
            <footer>
              <button type="button" onClick={flow.close}>
                Cancel
              </button>
              <button
                type="button"
                disabled={!flow.token || flow.phase === 'blocked'}
                onClick={() => void flow.build()}
              >
                Build review copy
              </button>
            </footer>
          </>
        ) : null}
        {flow.phase === 'review' && build && 'validation' in build ? (
          <>
            <h3>Review changes</h3>
            <p>
              {build.validation.sourcePreserved
                ? 'Source preserved.'
                : 'Source preservation failed.'}
            </p>
            {flow.report?.status === 'ok' &&
            'appliedChanges' in flow.report.value ? (
              <section>
                <h4>Applied changes</h4>
                {Object.entries(flow.report.value.appliedChanges).map(
                  ([group, changes]) => (
                    <div key={group}>
                      <h5>{group}</h5>
                      <ul>
                        {changes.map((change, index) => (
                          <li key={`${change.code}-${index}`}>
                            {change.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ),
                )}
              </section>
            ) : null}
            <div role="group" aria-label="Scene comparison">
              <button
                type="button"
                aria-pressed={scene === 'source'}
                onClick={() => setScene('source')}
              >
                Source
              </button>
              <button
                type="button"
                aria-pressed={scene === 'output'}
                onClick={() => setScene('output')}
              >
                Snapmaker U1 output
              </button>
            </div>
            {mesh ? (
              <ModelViewer
                mesh={mesh}
                wireframe={false}
                projection="perspective"
                hiddenObjects={new Set()}
                resetToken={scene === 'source' ? 1 : 2}
                className="viewer-canvas"
                background="#0b0e12"
              />
            ) : (
              <p role="status">Loading comparison scene…</p>
            )}
            <footer>
              <button type="button" onClick={flow.close}>
                Cancel
              </button>
              <button type="button" onClick={() => void flow.save()}>
                Save As…
              </button>
            </footer>
          </>
        ) : null}
        {flow.phase === 'saved' ? (
          <p role="status">
            {flow.message}
            <button type="button" onClick={flow.close}>
              Close
            </button>
          </p>
        ) : null}
        {flow.phase === 'error' ? (
          <button type="button" onClick={flow.retry}>
            Retry
          </button>
        ) : null}
      </section>
    </div>
  );
}
