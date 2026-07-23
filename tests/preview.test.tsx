import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewWorkspace } from '../src/renderer/viewer/PreviewWorkspace';

describe('<PreviewWorkspace />', () => {
  it('contains focus, cycles Tab, and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Background action</button>
        <PreviewWorkspace
          name="widget.stl"
          loading={false}
          error="Could not parse model"
          mesh={null}
          vendorMetadata={null}
          wireframe={false}
          projection="perspective"
          resetToken={0}
          hiddenParts={new Set()}
          onClose={onClose}
          onRetry={vi.fn()}
          onToggleWireframe={vi.fn()}
          onToggleProjection={vi.fn()}
          onReset={vi.fn()}
          onTogglePart={vi.fn()}
          onToggleAllParts={vi.fn()}
        />
      </>,
    );

    const back = screen.getByRole('button', { name: 'Back to library' });
    const close = screen.getByRole('button', { name: 'Close' });
    const background = screen.getByRole('button', {
      name: 'Background action',
    });
    expect(back).toHaveFocus();

    background.focus();
    expect(back).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(back).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
