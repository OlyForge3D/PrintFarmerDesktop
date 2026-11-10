import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportPreparationStatus } from '../src/renderer/library/ImportPreparationStatus';
import type { LibraryScanActivity } from '../src/renderer/library/useLibrary';

const idle: LibraryScanActivity = {
  phase: 'idle',
  path: null,
  label: null,
  estimatedTotal: null,
  backendProgressAvailable: false,
};
const inspecting: LibraryScanActivity = {
  ...idle,
  phase: 'inspecting',
  path: 'C:\\Models\\Miniatures',
  label: 'Inspecting folder: C:\\Models\\Miniatures',
};

afterEach(() => vi.useRealTimers());

describe('folder inspection feedback', () => {
  it('announces after 150ms without moving focus and keeps the selected folder through organization loading', async () => {
    vi.useFakeTimers();
    render(<button>Original focus</button>);
    const { rerender } = render(
      <ImportPreparationStatus activity={inspecting} />,
    );
    const trigger = screen.getByRole('button');
    trigger.focus();
    const status = screen.getByRole('status', { name: 'Folder inspection' });
    expect(status).toBeEmptyDOMElement();
    await act(() => vi.advanceTimersByTime(149));
    expect(status).toBeEmptyDOMElement();
    await act(() => vi.advanceTimersByTime(1));
    expect(status).toHaveTextContent('Inspecting folder: Miniatures');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status.querySelector('.loading-indicator')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    expect(trigger).toHaveFocus();
    rerender(
      <ImportPreparationStatus
        activity={{
          ...inspecting,
          label: 'Loading import organization choices',
        }}
      />,
    );
    expect(status).toHaveTextContent('Loading import organization choices.');
    expect(status).toHaveTextContent('Inspecting folder: Miniatures');
    rerender(<ImportPreparationStatus activity={idle} />);
    expect(status).toBeEmptyDOMElement();
  });

  it('does not flash for instant results or show inspection while the native picker is open', async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ImportPreparationStatus
        activity={{
          ...idle,
          phase: 'preparing',
          label: 'Choosing a source folder',
        }}
      />,
    );
    await act(() => vi.advanceTimersByTime(1000));
    const status = screen.getByRole('status', { name: 'Folder inspection' });
    expect(status).toBeEmptyDOMElement();
    rerender(<ImportPreparationStatus activity={inspecting} />);
    await act(() => vi.advanceTimersByTime(100));
    rerender(<ImportPreparationStatus activity={idle} />);
    await act(() => vi.advanceTimersByTime(1000));
    expect(status).toBeEmptyDOMElement();
    rerender(<ImportPreparationStatus activity={inspecting} />);
    expect(status).toBeEmptyDOMElement();
    await act(() => vi.advanceTimersByTime(150));
    expect(status).toHaveTextContent('Inspecting folder: Miniatures');
  });
});
