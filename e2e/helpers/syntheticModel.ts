import type {
  QueryModelsResponse,
  SceneMesh,
  VendorMetadata,
} from '../../src/shared/ipc';
import type { IpcReplies } from './syntheticIpc';

export const syntheticModelName = 'synthetic-project.3mf';
export const syntheticModelHash = 'f'.repeat(64);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function syntheticScene(): SceneMesh {
  const mesh = {
    positions: [0, 0, 0, 20, 0, 0, 0, 20, 10],
    indices: [0, 1, 2],
    bounds: { min: [0, 0, 0], max: [20, 20, 10] },
  } satisfies Pick<SceneMesh, 'positions' | 'indices' | 'bounds'>;
  return {
    ...mesh,
    sceneVersion: 2,
    sourceFormat: 'threeMf',
    faceColors: null,
    status: 'complete',
    statusMessages: [],
    parts: [
      {
        name: 'Synthetic triangle',
        triangleStart: 0,
        triangleCount: 1,
        status: 'complete',
      },
    ],
    objects: [
      {
        id: 'synthetic-root',
        sourceId: 'synthetic-source',
        name: 'Synthetic triangle',
        parentId: null,
        children: [],
        transform: { matrix: identity },
        mesh,
        material: {},
        plateId: 'synthetic-plate',
        buildItemIndex: 0,
      },
    ],
    rootObjectIds: ['synthetic-root'],
    plates: [
      {
        id: 'synthetic-plate',
        name: 'Synthetic plate',
        index: 0,
        rootObjectIds: ['synthetic-root'],
      },
    ],
  };
}

export const syntheticVendor: VendorMetadata = {
  slicer: 'orcaSlicer',
  printerTarget: 'bambu',
  core: { title: 'Synthetic project', application: 'Synthetic fixture' },
  plates: [],
  thumbnails: [],
};

export function syntheticModelReplies(): IpcReplies {
  const result: QueryModelsResponse = {
    models: [
      {
        hash: syntheticModelHash,
        format: 'threeMf',
        size: 1024,
        locations: [
          {
            rootId: 'synthetic-root',
            path: `C:\\SyntheticPrintFarmer\\${syntheticModelName}`,
            rootRelative: syntheticModelName,
            size: 1024,
            modifiedUnixSeconds: null,
            available: true,
          },
        ],
      },
    ],
    counts: {
      all: 1,
      favorites: 0,
      stl: 0,
      threeMf: 1,
      obj: 0,
      step: 0,
      duplicates: 0,
      missing: 0,
    },
    sources: [],
    filteredTotal: 1,
    page: 1,
    pageSize: 24,
  };
  return {
    'catalog:queryModels': [{ value: result }],
    'catalog:listTags': [{ value: [] }],
    'catalog:listCollections': [{ value: [] }],
    'catalog:tagsForModel': [{ value: [] }],
    'catalog:collectionsForModel': [{ value: [] }],
    'model:extractVendorMetadata': [{ value: syntheticVendor }],
    'model:extractVendorPlateThumbnails': [{ value: { thumbnails: [] } }],
    'model:renderThumbnail': [{ error: 'Synthetic thumbnail not generated.' }],
    'model:loadScene': [{ value: syntheticScene() }],
  };
}
