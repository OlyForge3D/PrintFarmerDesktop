// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createSidecarLineFramer } from '../src/main/sidecarFraming';

describe('sidecar response framing', () => {
  it('rejects oversized partial lines once and stops accumulating them', () => {
    const lines = vi.fn<(line: string) => void>();
    const errors = vi.fn();
    const accept = createSidecarLineFramer(lines, errors, 8);
    accept('12345678\n');
    expect(lines).toHaveBeenCalledWith('12345678');
    accept('1234');
    accept('56789');
    accept('\nignored\n');
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(lines).toHaveBeenCalledTimes(1);
  });

  it('applies the limit per line, not per chunk or stream', () => {
    const lines = vi.fn<(line: string) => void>();
    const errors = vi.fn();
    const accept = createSidecarLineFramer(lines, errors, 3);
    accept('123\n12\n1\n');
    expect(lines.mock.calls.map(([line]) => line)).toEqual(['123', '12', '1']);
    expect(errors).not.toHaveBeenCalled();
    accept('1234\n');
    expect(errors).toHaveBeenCalledTimes(1);
  });
  it('preserves partial, empty, and multiple lines across chunks', () => {
    const lines: string[] = [];
    const accept = createSidecarLineFramer((line) => lines.push(line), vi.fn());

    accept('');
    accept('par');
    accept('tial\n\nnext\r');
    accept('\nlast\ntrail');
    expect(lines).toEqual(['partial', '', 'next\r', 'last']);

    accept('ing\n');
    expect(lines).toEqual(['partial', '', 'next\r', 'last', 'trailing']);
  });

  it('joins Unicode characters split between chunks without changing them', () => {
    const lines: string[] = [];
    const accept = createSidecarLineFramer((line) => lines.push(line), vi.fn());

    accept('folder \ud83c');
    accept('\udf33\nnext\n');

    expect(lines).toEqual(['folder \ud83c\udf33', 'next']);
  });

  it('only searches new chunks when a response spans many chunks', () => {
    const lines: string[] = [];
    const accept = createSidecarLineFramer((line) => lines.push(line), vi.fn());
    const chunk = 'x'.repeat(1024);
    const chunks = 2_000;
    let searchedCharacters = 0;
    // The original method is forwarded with the intercepted receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalIndexOf = String.prototype.indexOf;
    const spy = vi
      .spyOn(String.prototype, 'indexOf')
      .mockImplementation(function (this: string, search, fromIndex) {
        if (search === '\n') searchedCharacters += this.length;
        return originalIndexOf.call(this, search, fromIndex);
      });

    try {
      for (let index = 0; index < chunks; index += 1) accept(chunk);
      accept('\n');
    } finally {
      spy.mockRestore();
    }

    expect(lines).toEqual([chunk.repeat(chunks)]);
    expect(searchedCharacters).toBeLessThan(chunks * chunk.length + 10);
  });
});
