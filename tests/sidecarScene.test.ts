// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LoadSceneResponse } from '@shared/ipc';
import { SidecarSceneBuffers } from '../src/main/sidecarScene';

function fixture() {
  const positions = new Float32Array([-0, -1.1234567, 3, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  const colors = new Uint8Array([250, 127, 3]);
  const buffers = [positions, indices, colors].map((a) =>
    Buffer.from(a.buffer),
  );
  const p = { buffer: 0, length: 9, elementType: 'f32' };
  const i = { buffer: 1, length: 3, elementType: 'u32' };
  const c = { buffer: 2, length: 3, elementType: 'u8' };
  const bounds = { min: [-1.1234567, 0, 0], max: [1, 1, 3] };
  const result = {
    encoding: 'packed-v1',
    scene: {
      sceneVersion: 2,
      positions: p,
      indices: i,
      faceColors: c,
      bounds,
      sourceFormat: 'stl',
      status: 'partial',
      statusMessages: ['example warning'],
      parts: [{ name: 'Body', triangleStart: 0, triangleCount: 1 }],
      rootObjectIds: ['body'],
      plates: [
        { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['body'] },
      ],
      objects: [
        {
          id: 'body',
          sourceId: 'source-1',
          name: 'Body',
          children: [],
          transform: {
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          mesh: { positions: p, indices: i, bounds },
          material: { baseColor: [1, 2, 3], faceColors: c },
          plateId: 'plate-0',
        },
      ],
    },
  };
  return { positions, indices, colors, buffers, result };
}

function acceptBuffer(
  assembler: SidecarSceneBuffers,
  index: number,
  bytes: Buffer,
) {
  assembler.accept({
    index,
    byteLength: bytes.length,
    offset: 0,
    data: bytes.toString('base64'),
  });
}

describe('packed sidecar scenes', () => {
  it('preserves all float bits, colors, indices, hierarchy and shared buffers across arbitrary byte chunks', () => {
    const { positions, indices, colors, buffers, result } = fixture();
    const assembler = new SidecarSceneBuffers();
    buffers.forEach((bytes, index) => {
      for (let offset = 0; offset < bytes.length; offset += 5) {
        assembler.accept({
          index,
          byteLength: bytes.length,
          offset,
          data: bytes.subarray(offset, offset + 5).toString('base64'),
        });
      }
    });
    const scene = assembler.decode(result);
    expect(scene.positions).toEqual(positions);
    expect(scene.indices).toEqual(indices);
    expect(scene.faceColors).toEqual(colors);
    expect(Object.is(scene.positions[0], -0)).toBe(true);
    expect(scene.status).toBe('partial');
    expect(scene.statusMessages).toEqual(['example warning']);
    expect(scene.plates[0]?.rootObjectIds).toEqual(['body']);
    expect(scene.objects[0]?.material.baseColor).toEqual([1, 2, 3]);
    expect(scene.objects[0]?.mesh?.positions).toBeInstanceOf(Float32Array);
    const objectPositions = scene.objects[0]?.mesh?.positions;
    expect(
      objectPositions instanceof Float32Array &&
        scene.positions instanceof Float32Array &&
        objectPositions.buffer === scene.positions.buffer,
    ).toBe(true);
    const cloned = structuredClone(scene);
    const clonedObject = cloned.objects[0]?.mesh?.positions;
    expect(
      clonedObject instanceof Float32Array &&
        cloned.positions instanceof Float32Array &&
        clonedObject.buffer === cloned.positions.buffer,
    ).toBe(true);
  });

  it('accepts a complete buffer at the exact budget and rejects one byte over before allocating', () => {
    const bytes = Buffer.alloc(4);
    expect(() =>
      acceptBuffer(new SidecarSceneBuffers(4), 0, bytes),
    ).not.toThrow();
    expect(() => acceptBuffer(new SidecarSceneBuffers(3), 0, bytes)).toThrow(
      /size limit/,
    );
  });

  it.each([
    { index: 1, byteLength: 4, offset: 0, data: 'AAAAAA==' },
    { index: 0, byteLength: 4, offset: 1, data: 'AAAA' },
    { index: 0, byteLength: 1, offset: 0, data: 'AAAAAA==' },
    { index: 0, byteLength: 1, offset: 0, data: 'AB==' },
    { index: 0, byteLength: 1, offset: 0, data: 'not base64' },
    { index: 0, byteLength: 1, offset: 0, data: '' },
  ])('rejects malformed buffer frame %#', (chunk) => {
    expect(() => new SidecarSceneBuffers().accept(chunk)).toThrow();
  });

  it('rejects repeated or overlapping chunks', () => {
    const assembler = new SidecarSceneBuffers();
    const chunk = { index: 0, byteLength: 4, offset: 0, data: 'AAAAAA==' };
    assembler.accept(chunk);
    expect(() => assembler.accept(chunk)).toThrow(/out of order/);
  });

  it('rejects truncated and unreferenced buffers and invalid indices', () => {
    const { buffers, result } = fixture();
    const missing = new SidecarSceneBuffers();
    acceptBuffer(missing, 0, buffers[0]!);
    expect(() => missing.decode(result)).toThrow(/Incomplete/);
    const extra = new SidecarSceneBuffers();
    buffers.forEach((bytes, index) => acceptBuffer(extra, index, bytes));
    acceptBuffer(extra, 3, Buffer.alloc(0));
    expect(() => extra.decode(result)).toThrow(/unreferenced/);
    const invalid = new SidecarSceneBuffers();
    buffers[1]!.writeUInt32LE(99, 0);
    buffers.forEach((bytes, index) => acceptBuffer(invalid, index, bytes));
    expect(() => invalid.decode(result)).toThrow(/absent vertex/);
  });

  it('rejects non-finite typed positions and wrong typed index/color representations', () => {
    const { buffers, result } = fixture();
    buffers[0]!.writeFloatLE(Number.NaN, 0);
    const assembler = new SidecarSceneBuffers();
    buffers.forEach((bytes, index) => acceptBuffer(assembler, index, bytes));
    expect(() => assembler.decode(result)).toThrow(/finite/);
    expect(
      LoadSceneResponse.safeParse({
        ...result.scene,
        positions: new Float32Array(9),
        indices: new Int32Array([-1]),
      }).success,
    ).toBe(false);
  });
});
