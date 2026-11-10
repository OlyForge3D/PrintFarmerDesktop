// This function runs in the packaged renderer via evaluateHandle.
export function createSidebarResizeRecorder() {
  const limit = 32;
  const events: Array<{
    type: string;
    elapsedMs: number;
    pointerId: number;
    clientX: number;
    clientY: number;
    buttons: number;
    captured: boolean;
    onSeparator: boolean;
    inlineWidth: number | null;
    value: number | null;
  }> = [];
  let droppedEvents = 0;
  let active = false;
  const started = performance.now();
  const separator = () =>
    document.querySelector<HTMLElement>('.library-sidebar-resizer');
  const pane = () =>
    document.querySelector<HTMLElement>('.library-sidebar-pane');
  const numeric = (value: string | null | undefined): number | null => {
    if (!value?.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const inlineWidth = () => {
    const width = pane()?.style.width;
    return width?.endsWith('px') ? numeric(width.slice(0, -2)) : null;
  };
  const bounds = (element: Element | null) => {
    if (!element) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const snapshot = (phase: string) => {
    let preferenceWidth: number | null = null;
    let preferenceRead: 'ok' | 'unavailable' = 'ok';
    try {
      const raw = localStorage.getItem('printfarmer.library.sidebar.v1');
      const prefs: unknown = raw === null ? null : JSON.parse(raw);
      if (typeof prefs === 'object' && prefs !== null && 'width' in prefs) {
        if (typeof prefs.width === 'number' && Number.isFinite(prefs.width)) {
          preferenceWidth = prefs.width;
        }
      }
    } catch {
      preferenceRead = 'unavailable';
    }
    const handle = separator();
    return {
      phase,
      elapsedMs: performance.now() - started,
      window: {
        outerWidth,
        outerHeight,
        innerWidth,
        innerHeight,
        devicePixelRatio,
      },
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
      },
      viewport: window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            scale: window.visualViewport.scale,
          }
        : null,
      pane: { inlineWidth: inlineWidth(), bounds: bounds(pane()) },
      separator: {
        bounds: bounds(handle),
        min: numeric(handle?.getAttribute('aria-valuemin')),
        max: numeric(handle?.getAttribute('aria-valuemax')),
        value: numeric(handle?.getAttribute('aria-valuenow')),
      },
      workspace: bounds(document.querySelector('.workspace--library')),
      inspector: bounds(document.querySelector('.properties-inspector')),
      preference: { width: preferenceWidth, read: preferenceRead },
    };
  };
  const snapshots = [snapshot('launch')];
  const types = [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'gotpointercapture',
    'lostpointercapture',
  ] as const;
  const observe = (event: PointerEvent) => {
    const handle = separator();
    const onSeparator = event.target === handle;
    if (events.length === limit) {
      droppedEvents += 1;
      return;
    }
    // Attribute reads avoid forcing layout during the pointer gesture. Events
    // are observed in capture phase, before the React handler updates the width.
    events.push({
      type: event.type,
      elapsedMs: performance.now() - started,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      buttons: event.buttons,
      captured: handle?.hasPointerCapture(event.pointerId) ?? false,
      onSeparator,
      inlineWidth: inlineWidth(),
      value: numeric(handle?.getAttribute('aria-valuenow')),
    });
  };
  return {
    start() {
      snapshots.push(snapshot('pre-drag'));
      for (const type of types) {
        document.addEventListener(type, observe, {
          capture: true,
          passive: true,
        });
      }
      active = true;
    },
    stop(phase: 'assertion-success' | 'assertion-failure') {
      if (active) {
        for (const type of types)
          document.removeEventListener(type, observe, true);
        active = false;
      }
      snapshots.push(snapshot(phase));
      return {
        schemaVersion: 1,
        eventPhase: 'capture',
        snapshots,
        events,
        droppedEvents,
      };
    },
  };
}
