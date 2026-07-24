import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { buildViewerSceneGraph } from '../src/renderer/viewer/sceneGraph';
import type { SceneMesh } from '../src/renderer/viewer/types';

function multiObjectScene(): SceneMesh {
  return {
    sceneVersion: 2,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0],
    indices: [0, 1, 2, 3, 4, 5],
    bounds: { min: [0, 0, 0], max: [3, 1, 0] },
    sourceFormat: 'threeMf',
    faceColors: null,
    parts: [
      { name: 'Body', triangleStart: 0, triangleCount: 1 },
      { name: 'Lid', triangleStart: 1, triangleCount: 1 },
    ],
    objects: [
      {
        id: 'root',
        sourceId: '3d/3dmodel.model#object-1',
        name: 'Assembly',
        parentId: null,
        children: ['body', 'lid'],
        transform: {
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        mesh: null,
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 0,
      },
      {
        id: 'body',
        sourceId: '3d/3dmodel.model#object-2',
        name: 'Body',
        parentId: 'root',
        children: [],
        transform: {
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        mesh: {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2],
          bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        },
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 0,
      },
      {
        id: 'lid',
        sourceId: '3d/3dmodel.model#object-3',
        name: 'Lid',
        parentId: 'root',
        children: [],
        transform: {
          matrix: [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        mesh: {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2],
          bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        },
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 0,
      },
    ],
    rootObjectIds: ['root'],
    plates: [
      { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['root'] },
    ],
  };
}

function matrixFromThreeMfTransform(values: readonly number[]): number[] {
  return [
    values[0] ?? 1,
    values[3] ?? 0,
    values[6] ?? 0,
    values[9] ?? 0,
    values[1] ?? 0,
    values[4] ?? 1,
    values[7] ?? 0,
    values[10] ?? 0,
    values[2] ?? 0,
    values[5] ?? 0,
    values[8] ?? 1,
    values[11] ?? 0,
    0,
    0,
    0,
    1,
  ];
}

describe('buildViewerSceneGraph', () => {
  it('builds a nested plate/object hierarchy and respects hidden ancestors', () => {
    const graph = buildViewerSceneGraph(multiObjectScene(), new Set(['root']));
    const plateGroup = graph.root.children[0];
    expect(plateGroup).toBeInstanceOf(THREE.Group);
    const rootNode = plateGroup?.children[0];
    expect(rootNode?.visible).toBe(false);

    graph.setHidden(new Set(['lid']));
    expect(rootNode?.visible).toBe(true);
    expect(rootNode?.children[1]?.visible).toBe(false);
  });

  it('disposes every geometry and material on teardown', () => {
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(
      THREE.MeshStandardMaterial.prototype,
      'dispose',
    );

    const graph = buildViewerSceneGraph(multiObjectScene());
    graph.dispose();

    expect(geometryDispose).toHaveBeenCalledTimes(2);
    expect(materialDispose).toHaveBeenCalledTimes(2);

    geometryDispose.mockRestore();
    materialDispose.mockRestore();
  });

  it('applies DTO matrices with translated and rotated child world transforms', () => {
    const scene: SceneMesh = {
      sceneVersion: 2,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'threeMf',
      faceColors: null,
      parts: [{ name: 'Body', triangleStart: 0, triangleCount: 1 }],
      objects: [
        {
          id: 'root',
          sourceId: '3d/3dmodel.model#object-1',
          name: 'Assembly',
          parentId: null,
          children: ['child'],
          transform: {
            matrix: matrixFromThreeMfTransform([
              1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0,
            ]),
          },
          mesh: null,
          material: {},
          plateId: 'plate-0',
          buildItemIndex: 0,
        },
        {
          id: 'child',
          sourceId: '3d/3dmodel.model#object-2',
          name: 'Body',
          parentId: 'root',
          children: [],
          transform: {
            matrix: matrixFromThreeMfTransform([
              0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 5, 0,
            ]),
          },
          mesh: {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
            bounds: { min: [0, 0, 0], max: [1, 1, 0] },
          },
          material: {},
          plateId: 'plate-0',
          buildItemIndex: 0,
        },
      ],
      rootObjectIds: ['root'],
      plates: [
        { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['root'] },
      ],
    };

    const graph = buildViewerSceneGraph(scene);
    graph.root.updateMatrixWorld(true);
    const plateGroup = graph.root.children[0];
    const rootNode = plateGroup?.children[0] as THREE.Group;
    const childNode = rootNode.children[0] as THREE.Group;

    expect(childNode.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([
      10, 5, 0,
    ]);
    expect(
      new THREE.Vector3(1, 0, 0).applyMatrix4(childNode.matrixWorld).toArray(),
    ).toEqual([10, 6, 0]);
  });

  it('parents root objects directly under the scene root when plates are absent', () => {
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(
      THREE.MeshStandardMaterial.prototype,
      'dispose',
    );
    const scene: SceneMesh = {
      sceneVersion: 2,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'threeMf',
      faceColors: null,
      parts: [],
      objects: [
        {
          id: 'root',
          sourceId: '3d/3dmodel.model#object-1',
          name: 'Legacy root',
          parentId: null,
          children: [],
          transform: {
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          mesh: {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
            bounds: { min: [0, 0, 0], max: [1, 1, 0] },
          },
          material: {},
          plateId: 'plate-0',
          buildItemIndex: 0,
        },
      ],
      rootObjectIds: ['root'],
      plates: [],
    };

    const graph = buildViewerSceneGraph(scene);
    expect(graph.root.children).toHaveLength(1);
    expect(graph.root.children[0]?.name).toBe('Legacy root');

    graph.dispose();
    expect(graph.root.children).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);

    geometryDispose.mockRestore();
    materialDispose.mockRestore();
  });
});
