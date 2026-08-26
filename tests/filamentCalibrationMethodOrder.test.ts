// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  CalibrationSliceMethod,
  FilamentWizardStateRecord,
} from '../src/shared/ipc';
import type { FilamentWizardStateRecord as FilamentWizardStateRecordType } from '../src/shared/ipc';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

function sampleRecord(
  completedMethods: FilamentWizardStateRecordType['completedMethods'],
): FilamentWizardStateRecordType {
  return {
    schemaVersion: 1,
    printerId: 'printer-1',
    printerModelId: null,
    machineName: 'Voron 2.4 350',
    processName: '0.20mm Standard @Voron 2.4',
    baseFilamentName: 'PolyLite PLA Blue',
    baseFilamentGuid: PROFILE_ID,
    cloneId: '33333333-3333-4333-8333-333333333333',
    cloneName: 'PolyLite PLA Blue (calibration)',
    completedMethods,
    currentMethod: null,
    inFlightJob: null,
    phase: 'methodPicker',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('FilamentWizardStateRecord.completedMethods ceiling', () => {
  // Regression guard for issue #771: `completedMethods` previously carried a
  // hard-coded `.max(3)` that could silently drift from the
  // `CalibrationSliceMethod` catalogue. These tests derive their fixtures
  // from `CalibrationSliceMethod.options.length` rather than a literal, so
  // they only keep passing if the schema's ceiling tracks the enum too —
  // adding or removing a method changes both sides together.
  it('accepts a completedMethods list equal to the full method catalogue', () => {
    const record = sampleRecord([...CalibrationSliceMethod.options]);
    expect(() => FilamentWizardStateRecord.parse(record)).not.toThrow();
  });

  it('rejects a completedMethods list longer than the method catalogue', () => {
    const tooMany = [
      ...CalibrationSliceMethod.options,
      CalibrationSliceMethod.options[0],
    ];
    const record = sampleRecord(tooMany);
    expect(() => FilamentWizardStateRecord.parse(record)).toThrow();
  });
});
