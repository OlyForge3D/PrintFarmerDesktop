import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  CREASE_ANGLE,
  buildCreasedMesh,
} from '../src/renderer/viewer/creasedNormals';
import { buildViewerSceneGraph } from '../src/renderer/viewer/sceneGraph';
import type { SceneMesh } from '../src/renderer/viewer/types';

// Unit cube with 8 shared vertices, the layout 3MF/OBJ produce.
const CUBE_POSITIONS = [
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
];
const CUBE_INDICES = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2,
  6, 1, 6, 5, 3, 0, 4, 3, 4, 7,
];

function faceNormal(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  tri: number,
): THREE.Vector3 {
  const v = (k: number) =>
    new THREE.Vector3().fromArray(positions, (indices[tri * 3 + k] ?? 0) * 3);
  const a = v(0);
  return v(1).sub(a).cross(v(2).sub(a)).normalize();
}

describe('buildCreasedMesh', () => {
  it('keeps every cube face flat instead of averaging across 90 degree edges', () => {
    const mesh = buildCreasedMesh(CUBE_POSITIONS, CUBE_INDICES);
    for (let tri = 0; tri < 12; tri += 1) {
      const expected = faceNormal(CUBE_POSITIONS, CUBE_INDICES, tri);
      for (let k = 0; k < 3; k += 1) {
        const got = new THREE.Vector3().fromArray(
          mesh.normals,
          (mesh.indices[tri * 3 + k] as number) * 3,
        );
        expect(got.distanceTo(expected)).toBeLessThan(1e-5);
      }
    }
  });

  it('keeps positions exactly as supplied and splits only at hard edges', () => {
    const mesh = buildCreasedMesh(CUBE_POSITIONS, CUBE_INDICES);
    // 8 cube corners, each shared by 3 mutually perpendicular faces.
    expect(mesh.positions.length / 3).toBe(24);
    expect(mesh.indices.length).toBe(CUBE_INDICES.length);
    for (let i = 0; i < CUBE_INDICES.length; i += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        expect(mesh.positions[(mesh.indices[i] as number) * 3 + axis]).toBe(
          CUBE_POSITIONS[(CUBE_INDICES[i] as number) * 3 + axis],
        );
      }
    }
  });

  it('keeps a smooth surface fully shared and indexed', () => {
    const tilt = (10 * Math.PI) / 180;
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, Math.sin(tilt)];
    const mesh = buildCreasedMesh(positions, [0, 1, 2, 1, 3, 2]);
    expect(mesh.positions.length / 3).toBe(4);
  });

  it('still smooths gently curved surfaces below the crease angle', () => {
    // Two triangles folded by 10 degrees share an edge.
    const tilt = (10 * Math.PI) / 180;
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, Math.sin(tilt)];
    const indices = [0, 1, 2, 1, 3, 2];
    const mesh = buildCreasedMesh(positions, indices);
    const at = (corner: number) =>
      new THREE.Vector3().fromArray(
        mesh.normals,
        (mesh.indices[corner] as number) * 3,
      );
    expect(at(1).distanceTo(faceNormal(positions, indices, 0))).toBeGreaterThan(
      1e-3,
    );
    // The shared vertex (source 1) gets one normal on both faces.
    expect(at(1).distanceTo(at(3))).toBeLessThan(1e-5);
    expect(CREASE_ANGLE).toBeGreaterThan(tilt);
  });

  it('shades a fan of gently turning faces as one group, however far its ends diverge', () => {
    // Four triangles around a hub on a shallow cone: neighbouring face normals
    // differ by about 21 degrees (within the crease) while the first and last
    // differ by about 61.
    const positions: number[] = [0, 0, 0];
    for (let i = 0; i < 5; i += 1) {
      const angle = (i * 30 * Math.PI) / 180;
      positions.push(Math.cos(angle), Math.sin(angle), 1);
    }
    const indices: number[] = [];
    for (let i = 0; i < 4; i += 1) indices.push(0, i + 1, i + 2);
    const mesh = buildCreasedMesh(positions, indices);
    const hubNormals = new Set<string>();
    for (const vertex of mesh.indices) {
      if (mesh.positions[vertex * 3 + 2] !== 0) continue;
      hubNormals.add(
        [0, 1, 2]
          .map((c) => (mesh.normals[vertex * 3 + c] as number).toFixed(5))
          .join(','),
      );
    }
    expect(hubNormals.size).toBe(1);
  });

  it('smooths a non-manifold edge independently of triangle order', () => {
    // Three faces on edge (0,1): normals +z, tilted 25 degrees, tilted 50.
    const edge = [0, 0, 0, 1, 0, 0];
    const wing = (deg: number): number[] => {
      const r = (deg * Math.PI) / 180;
      return [0.5, Math.cos(r), Math.sin(r)];
    };
    const positions = [...edge, ...wing(90), ...wing(65), ...wing(40)];
    const forward = buildCreasedMesh(positions, [0, 1, 2, 0, 1, 3, 0, 1, 4]);
    const reordered = buildCreasedMesh(positions, [0, 1, 2, 0, 1, 4, 0, 1, 3]);
    expect(reordered.positions.length).toBe(forward.positions.length);
  });

  it('survives degenerate triangles without NaN', () => {
    const mesh = buildCreasedMesh([0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, 2]);
    expect(Array.from(mesh.normals).every(Number.isFinite)).toBe(true);
  });
});

describe('scene graph shading of shared-vertex meshes', () => {
  it('renders a 3MF cube with crisp face normals and unchanged geometry', () => {
    const scene: SceneMesh = {
      sceneVersion: 2,
      positions: CUBE_POSITIONS,
      indices: CUBE_INDICES,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      sourceFormat: 'threeMf',
      faceColors: null,
      status: 'complete',
      statusMessages: [],
      parts: [],
      plates: [],
      rootObjectIds: ['cube'],
      objects: [
        {
          id: 'cube',
          sourceId: 'cube',
          name: 'Cube',
          parentId: null,
          children: [],
          transform: {
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          mesh: { positions: CUBE_POSITIONS, indices: CUBE_INDICES },
          material: {},
          plateId: 'plate-0',
          buildItemIndex: 0,
        },
      ],
    } as unknown as SceneMesh;
    const graph = buildViewerSceneGraph(scene);
    let mesh: THREE.Mesh | undefined;
    graph.root.traverse((node) => {
      if (node instanceof THREE.Mesh) mesh = node;
    });
    const geometry = (mesh as THREE.Mesh).geometry;
    const normals = geometry.getAttribute('normal');
    const positions = geometry.getAttribute('position');
    expect(positions.count).toBe(24);
    expect(geometry.getIndex()?.count).toBe(CUBE_INDICES.length);
    for (let tri = 0; tri < 12; tri += 1) {
      const expected = faceNormal(CUBE_POSITIONS, CUBE_INDICES, tri);
      for (let k = 0; k < 3; k += 1) {
        const got = new THREE.Vector3().fromBufferAttribute(
          normals,
          geometry.getIndex()?.getX(tri * 3 + k) as number,
        );
        expect(got.distanceTo(expected)).toBeLessThan(1e-5);
      }
    }
    graph.dispose();
  });
});
