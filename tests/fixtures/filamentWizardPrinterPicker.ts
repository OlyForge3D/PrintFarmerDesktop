/**
 * Shared UI helpers for suites that mount the filament calibration wizard and
 * need to pick a printer from its dropdown.
 *
 * The picker is a `<select>`, so selection is a `change` event carrying the
 * option's value (the printer id) rather than a click on a labelled radio.
 * These helpers hoist a pattern that was independently duplicated across
 * three tests (`calibrationPrinterModelIdWiring`,
 * `calibrationUnimportedSystemProfiles`, `filamentCalibrationWizard`) — kept
 * here rather than reinvented per-suite so a picker change is applied in one
 * place and cannot be silently updated in some suites but not others.
 */

import { fireEvent, screen } from '@testing-library/react';

/**
 * Choose a printer from the wizard's printer dropdown by its visible label.
 * The picker is a `<select>`, so selection is a `change` carrying the option's
 * value (the printer id) rather than a click on a labelled radio.
 */
export async function pickPrinterByLabel(label: RegExp): Promise<void> {
  const select = await screen.findByRole('combobox', { name: /^printer$/i });
  const option = Array.from(select.querySelectorAll('option')).find((entry) =>
    label.test(entry.textContent ?? ''),
  );
  if (option === undefined) {
    throw new Error(`no printer option matching ${String(label)}`);
  }
  fireEvent.change(select, { target: { value: option.value } });
}
