import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSidebarResizeRecorder } from '../e2e/helpers/sidebarResizeDiagnostics';

function fixture(): HTMLElement {
  document.body.innerHTML = `
    <div class="workspace--library">
      <div class="library-sidebar-pane" style="width: 224px">
        <div class="library-sidebar-resizer" aria-valuemin="200"
          aria-valuemax="480" aria-valuenow="224"></div>
      </div>
      <aside class="properties-inspector"></aside>
    </div>`;
  const handle = document.querySelector<HTMLElement>(
    '.library-sidebar-resizer',
  )!;
  handle.hasPointerCapture = vi.fn(() => false);
  return handle;
}

function pointer(target: Element, type: string, clientX = 432): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('packaged sidebar resize evidence', () => {
  it('observes capture lifecycle without interfering and removes every listener', () => {
    const handle = fixture();
    const recorder = createSidebarResizeRecorder();
    const downstream = vi.fn();
    handle.addEventListener('pointerdown', downstream);
    const remove = vi.spyOn(document, 'removeEventListener');
    recorder.start();
    const down = pointer(handle, 'pointerdown');
    pointer(handle, 'gotpointercapture');
    pointer(handle, 'pointermove', 552);
    pointer(handle, 'pointerup', 552);
    pointer(handle, 'lostpointercapture', 552);
    const evidence = recorder.stop('assertion-failure');
    expect(down.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledOnce();
    expect(evidence.events.map(({ type }) => type)).toEqual([
      'pointerdown',
      'gotpointercapture',
      'pointermove',
      'pointerup',
      'lostpointercapture',
    ]);
    expect(evidence.snapshots.map(({ phase }) => phase)).toEqual([
      'launch',
      'pre-drag',
      'assertion-failure',
    ]);
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'gotpointercapture',
      'lostpointercapture',
    ]) {
      expect(remove).toHaveBeenCalledWith(type, expect.any(Function), true);
    }
    pointer(handle, 'pointermove');
    expect(evidence.events).toHaveLength(5);
  });

  it('bounds noisy or missed-target input and excludes private values', () => {
    const handle = fixture();
    handle.setAttribute('data-secret', 'PRIVATE_SENTINEL');
    localStorage.setItem(
      'printfarmer.library.sidebar.v1',
      JSON.stringify({
        width: 344,
        expanded: { tags: true },
        secret: 'PRIVATE_SENTINEL',
        path: '/PRIVATE_SENTINEL',
      }),
    );
    const recorder = createSidebarResizeRecorder();
    recorder.start();
    pointer(document.body, 'pointerdown');
    for (let i = 0; i < 100; i++) pointer(handle, 'pointermove', 432 + i);
    const evidence = recorder.stop('assertion-success');
    expect(evidence.events).toHaveLength(32);
    expect(evidence.droppedEvents).toBe(69);
    expect(evidence.events[0]).toMatchObject({ onSeparator: false });
    expect(evidence.snapshots[2]).toMatchObject({
      preference: { width: 344, read: 'ok' },
      pane: { inlineWidth: 224 },
      separator: { min: 200, max: 480, value: 224 },
    });
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_SENTINEL');
    expect(Object.keys(evidence.snapshots[2]!.preference)).toEqual([
      'width',
      'read',
    ]);
  });

  it('reports malformed preferences without copying their contents', () => {
    fixture();
    localStorage.setItem('printfarmer.library.sidebar.v1', 'PRIVATE_SENTINEL');
    const evidence = createSidebarResizeRecorder().stop('assertion-failure');
    expect(evidence.snapshots[0]!.preference).toEqual({
      width: null,
      read: 'unavailable',
    });
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_SENTINEL');
  });
});
