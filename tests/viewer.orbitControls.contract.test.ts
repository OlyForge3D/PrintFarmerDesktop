import { describe, expect, it } from 'vitest';

/**
 * Pins the two facts about the real `OrbitControls` that the test double in
 * `viewer.modelViewer.test.tsx` stands in for.
 *
 * Every other viewer test runs against that double, so the double *is* the
 * specification there. Nothing checked it against the real controls, which
 * left the viewer's central design claim - "the controls report movement and
 * nothing else, so anything that changes the picture without moving the camera
 * has to ask for its own frame" - resting on a code comment and on issue #88
 * rather than on execution.
 *
 * These tests import the real module and no mock, so they fail if a `three`
 * upgrade changes the behaviour the double imitates. That failure is the point:
 * it says the double has become a fiction, which is otherwise invisible.
 */
describe('OrbitControls (real, unmocked)', () => {
  async function setup(kind: 'perspective' | 'orthographic') {
    const THREE = await import('three');
    const { OrbitControls } =
      await import('three/examples/jsm/controls/OrbitControls.js');

    const camera =
      kind === 'perspective'
        ? new THREE.PerspectiveCamera(50, 1, 0.1, 100)
        : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    camera.position.set(0, 0, 5);

    const controls = new OrbitControls(camera, document.createElement('div'));
    controls.update();

    const changes: string[] = [];
    controls.addEventListener('change', () => changes.push('change'));

    return { camera, controls, changes };
  }

  it('stays silent while the camera sits still', async () => {
    const { controls, changes } = await setup('perspective');

    expect(controls.update()).toBe(false);
    expect(controls.update()).toBe(false);
    expect(changes).toEqual([]);

    controls.dispose();
  });

  it('reports a moved camera once, then goes quiet again', async () => {
    const { camera, controls, changes } = await setup('perspective');

    camera.position.set(1, 2, 3);

    expect(controls.update()).toBe(true);
    expect(changes).toEqual(['change']);

    // It compares against the pose it just saw rather than latching, so a
    // single move buys a single frame. The viewer's render loop depends on
    // this: a latched `true` would defeat the on-demand gate entirely.
    expect(controls.update()).toBe(false);
    expect(changes).toEqual(['change']);

    controls.dispose();
  });

  it('says nothing when zoom is written on the camera directly', async () => {
    const { camera, controls, changes } = await setup('orthographic');

    camera.zoom = 2;
    camera.updateProjectionMatrix();

    // This is the whole of issue #88. An orthographic zoom changes what the
    // next frame looks like without touching position or quaternion, and the
    // controls track only the pose - so they have nothing to report, the
    // `change` listener never runs, and an on-demand loop waiting on `change`
    // would leave the stale viewport on screen. The viewer therefore calls
    // `requestRender()` itself after every keyboard action.
    //
    // The controls do carry a `zoomChanged` flag, but it is set by their own
    // dolly handling, not by an external assignment like this one, so routing
    // zoom through the camera bypasses it. That is why the double deliberately
    // omits the flag: modelling it would make the double *more* forgiving than
    // the real thing and hide exactly this bug.
    expect(controls.update()).toBe(false);
    expect(changes).toEqual([]);

    controls.dispose();
  });
});
