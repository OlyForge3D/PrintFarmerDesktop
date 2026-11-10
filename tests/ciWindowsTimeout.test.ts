// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ciWindowsTimeout } from './helpers/ciWindowsTimeout';

describe('measured budgets apply only to Windows CI', () => {
  it.each([
    [5000, 30_000],
    [10_000, 20_000],
    [5000, 90_000],
    [15_000, 80_000],
    [15_000, 30_000],
  ])('selects %i -> %i only on the intended host', (existing, measured) => {
    expect(ciWindowsTimeout(existing, measured, { CI: 'true' }, 'win32')).toBe(
      measured,
    );
    expect(ciWindowsTimeout(existing, measured, { CI: '1' }, 'win32')).toBe(
      measured,
    );
    for (const CI of [undefined, '', 'false']) {
      expect(ciWindowsTimeout(existing, measured, { CI }, 'win32')).toBe(
        existing,
      );
    }
    for (const platform of ['darwin', 'linux'] as const) {
      expect(
        ciWindowsTimeout(existing, measured, { CI: 'true' }, platform),
      ).toBe(existing);
      expect(ciWindowsTimeout(existing, measured, {}, platform)).toBe(existing);
    }
  });

  it('uses the real process context by default', () => {
    const active =
      Boolean(process.env.CI) &&
      process.env.CI !== 'false' &&
      process.platform === 'win32';
    expect(ciWindowsTimeout(5000, 30_000)).toBe(active ? 30_000 : 5000);
  });
});
