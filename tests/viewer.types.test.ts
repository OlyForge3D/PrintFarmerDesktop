import { describe, expect, it } from 'vitest';

import type { SceneMesh as IpcSceneMesh } from '../src/shared/ipc';
import { toViewerSceneMesh } from '../src/renderer/viewer/types';

describe('toViewerSceneMesh', () => {
  it('omits undefined part metadata keys from normalized renderer state', () => {
    const raw: IpcSceneMesh = {
      positions: [0, 0, 0],
      indices: [0, 0, 0],
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      sourceFormat: 'threeMf',
      status: 'partial',
      statusMessages: ['Missing optional metadata'],
      parts: [
        {
          name: 'Plate 1',
          triangleStart: 0,
          triangleCount: 1,
          status: 'partial',
        },
      ],
    };

    const normalized = toViewerSceneMesh(raw);
    const normalizedPart = normalized.parts?.[0];

    expect(normalizedPart).toBeDefined();
    expect(normalizedPart && 'statusDetail' in normalizedPart).toBe(false);
    expect(normalizedPart && 'partNumber' in normalizedPart).toBe(false);
    expect(normalizedPart && 'materialLabel' in normalizedPart).toBe(false);
    expect(Object.keys(normalizedPart ?? {})).toEqual([
      'name',
      'triangleStart',
      'triangleCount',
      'status',
    ]);
  });
});
