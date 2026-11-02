import { z } from 'zod';
import {
  LoadSceneResponse,
  SceneMaterial,
  SceneObject,
  SceneObjectMesh,
  type LoadSceneResponse as Scene,
} from '@shared/ipc';

export const MAX_SCENE_BUFFER_BYTES = 512 * 1024 * 1024;
export const SCENE_CHUNK_BYTES = 256 * 1024;

const ArrayReference = z.object({
  buffer: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
});
const Positions = ArrayReference.extend({ elementType: z.literal('f32') });
const Indices = ArrayReference.extend({ elementType: z.literal('u32') });
const Colors = ArrayReference.extend({ elementType: z.literal('u8') });
const Material = SceneMaterial.extend({
  faceColors: Colors.nullable().optional(),
});
const ObjectMesh = SceneObjectMesh.extend({
  positions: Positions,
  indices: Indices,
});
const ObjectNode = SceneObject.extend({
  mesh: ObjectMesh.nullable().optional(),
  material: Material.default({}),
});
const PackedScene = z
  .object({
    encoding: z.literal('packed-v1'),
    scene: LoadSceneResponse.extend({
      positions: Positions,
      indices: Indices,
      faceColors: Colors.nullable().optional(),
      objects: z.array(ObjectNode).default([]),
    }),
  })
  .strict();

const Chunk = z
  .object({
    index: z.number().int().nonnegative(),
    byteLength: z.number().int().nonnegative().max(MAX_SCENE_BUFFER_BYTES),
    offset: z.number().int().nonnegative(),
    data: z
      .string()
      .max(Math.ceil(SCENE_CHUNK_BYTES / 3) * 4)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  })
  .strict();

interface SceneBuffer {
  bytes: Uint8Array<ArrayBuffer>;
  received: number;
}

/** Allocates each buffer once and fills it from ordered, bounded frames. */
export class SidecarSceneBuffers {
  private readonly buffers: SceneBuffer[] = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes = MAX_SCENE_BUFFER_BYTES) {}

  accept(rawChunk: unknown): void {
    const chunk = Chunk.parse(rawChunk);
    let buffer = this.buffers[chunk.index];
    if (!buffer) {
      if (
        chunk.index !== this.buffers.length ||
        chunk.offset !== 0 ||
        this.totalBytes + chunk.byteLength > this.maxBytes
      ) {
        throw new Error('Invalid scene buffer sequence or preview size limit.');
      }
      buffer = {
        bytes: new Uint8Array(new ArrayBuffer(chunk.byteLength)),
        received: 0,
      };
      this.buffers.push(buffer);
      this.totalBytes += chunk.byteLength;
    }
    if (
      buffer.bytes.length !== chunk.byteLength ||
      buffer.received !== chunk.offset
    ) {
      throw new Error('Scene buffer chunks are out of order.');
    }
    const bytes = Buffer.from(chunk.data, 'base64');
    if (
      bytes.toString('base64') !== chunk.data ||
      bytes.length > SCENE_CHUNK_BYTES ||
      chunk.offset + bytes.length > chunk.byteLength ||
      (bytes.length === 0 && chunk.byteLength !== 0)
    ) {
      throw new Error('Invalid scene buffer chunk.');
    }
    buffer.bytes.set(bytes, chunk.offset);
    buffer.received += bytes.length;
  }

  decode(rawResult: unknown): Scene {
    const { scene } = PackedScene.parse(rawResult);
    const used = new Set<number>();
    const bytesFor = (
      reference: z.infer<typeof ArrayReference>,
      width: number,
    ): Uint8Array<ArrayBuffer> => {
      const buffer = this.buffers[reference.buffer];
      if (
        !buffer ||
        buffer.received !== buffer.bytes.length ||
        reference.length * width !== buffer.bytes.length
      ) {
        throw new Error('Incomplete or mismatched scene geometry buffer.');
      }
      used.add(reference.buffer);
      return buffer.bytes;
    };
    const positions = (reference: z.infer<typeof Positions>) =>
      new Float32Array(bytesFor(reference, 4).buffer);
    const indices = (reference: z.infer<typeof Indices>) =>
      new Uint32Array(bytesFor(reference, 4).buffer);
    const colors = (reference: z.infer<typeof Colors>) =>
      new Uint8Array(bytesFor(reference, 1).buffer);
    const colorField = (
      reference: z.infer<typeof Colors> | null | undefined,
    ) => (reference == null ? reference : colors(reference));
    const decoded = LoadSceneResponse.parse({
      ...scene,
      positions: positions(scene.positions),
      indices: indices(scene.indices),
      faceColors: colorField(scene.faceColors),
      objects: scene.objects.map((object) => ({
        ...object,
        mesh: object.mesh
          ? {
              ...object.mesh,
              positions: positions(object.mesh.positions),
              indices: indices(object.mesh.indices),
            }
          : object.mesh,
        material: {
          ...object.material,
          faceColors: colorField(object.material.faceColors),
        },
      })),
    });
    if (used.size !== this.buffers.length) {
      throw new Error('Scene response contains unreferenced geometry buffers.');
    }
    for (const mesh of [
      decoded,
      ...decoded.objects.flatMap((o) => (o.mesh ? [o.mesh] : [])),
    ]) {
      const vertices = mesh.positions.length / 3;
      if (!Number.isInteger(vertices) || mesh.indices.length % 3 !== 0) {
        throw new Error(
          'Scene geometry is not packed into complete triangles.',
        );
      }
      for (const index of mesh.indices) {
        if (index >= vertices) {
          throw new Error('Scene triangle references an absent vertex.');
        }
      }
    }
    return decoded;
  }
}
