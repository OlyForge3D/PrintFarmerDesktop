/**
 * Renderer-side type barrel for the normalized scene contract shared with the
 * Electron IPC layer. Keeping the viewer on the same type source as
 * `window.printFarmer.loadScene()` prevents contract drift under
 * `exactOptionalPropertyTypes`.
 */
import type {
  Bounds as IpcBounds,
  ModelFormat as IpcModelFormat,
  SceneLoadStatus as IpcSceneLoadStatus,
  SceneMesh as IpcSceneMesh,
  ScenePart as IpcScenePart,
} from '../../shared/ipc';

export type ModelFormat = IpcModelFormat;
export type SceneLoadStatus = IpcSceneLoadStatus;

export interface Bounds {
  readonly min: Readonly<IpcBounds['min']>;
  readonly max: Readonly<IpcBounds['max']>;
}

export interface ScenePart {
  readonly name: IpcScenePart['name'];
  readonly triangleStart: IpcScenePart['triangleStart'];
  readonly triangleCount: IpcScenePart['triangleCount'];
  readonly status: IpcScenePart['status'];
  readonly statusDetail?: IpcScenePart['statusDetail'];
  readonly partNumber?: IpcScenePart['partNumber'];
  readonly materialLabel?: IpcScenePart['materialLabel'];
}

export interface SceneTransform {
  /**
   * 4×4 local transform relative to the scene root or `parentId`, already laid
   * out in the row-major argument order that `THREE.Matrix4.set()` expects.
   */
  readonly matrix: readonly number[];
}

export interface SceneMaterial {
  readonly baseColor?: readonly [number, number, number] | null | undefined;
  readonly faceColors?: readonly number[] | null | undefined;
}

export interface SceneObjectMesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly bounds: Bounds;
}

export interface SceneObject {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly parentId?: string | null | undefined;
  readonly children: readonly string[];
  readonly transform: SceneTransform;
  readonly mesh?: SceneObjectMesh | null | undefined;
  readonly material: SceneMaterial;
  readonly plateId: string;
  readonly buildItemIndex?: number | null | undefined;
}

export interface ScenePlate {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly rootObjectIds: readonly string[];
}

export interface SceneMesh {
  readonly sceneVersion: IpcSceneMesh['sceneVersion'];
  readonly positions: Readonly<IpcSceneMesh['positions']>;
  readonly indices: Readonly<IpcSceneMesh['indices']>;
  readonly bounds: Bounds;
  readonly sourceFormat: IpcSceneMesh['sourceFormat'];
  readonly faceColors?: readonly number[] | null | undefined;
  readonly status: IpcSceneMesh['status'];
  readonly statusMessages: Readonly<IpcSceneMesh['statusMessages']>;
  readonly parts: readonly ScenePart[];
  readonly objects: readonly SceneObject[];
  readonly rootObjectIds: readonly string[];
  readonly plates: readonly ScenePlate[];
}
