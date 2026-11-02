import type {
  LogicalModel,
  PrintFarmerApi,
  QueryModelsRequest,
  QueryModelsResponse,
} from '@shared/ipc';
import { selectLibraryView } from '../../src/renderer/library/filter';
import { isAvailable } from '../../src/renderer/library/model';
import { filterModelsByRemovedRoots } from '../../src/renderer/library/sourceRoots';

export function modelPage(
  models: LogicalModel[],
  request: QueryModelsRequest,
  favorites: readonly string[] = [],
  membership: Readonly<Record<string, readonly string[]>> = {},
  tags: Readonly<Record<string, readonly string[]>> = {},
): QueryModelsResponse {
  const active = filterModelsByRemovedRoots(
    models,
    new Set(request.excludedRootIds),
  );
  const visible = selectLibraryView(active, {
    ...request,
    favorites: new Set(favorites),
  }).filter(
    (model) =>
      (request.collectionIds.length === 0 ||
        request.collectionIds.some((id) =>
          membership[model.hash]?.includes(id),
        )) &&
      ((request.tagIds?.length ?? 0) === 0 ||
        request.tagIds?.some((id) => tags[model.hash]?.includes(id))),
  );
  const page = Math.min(
    request.page,
    Math.max(1, Math.ceil(visible.length / request.pageSize)),
  );
  const roots = new Set(
    active.flatMap((model) =>
      model.locations.map((location) => location.rootId),
    ),
  );
  return {
    models: visible.slice(
      (page - 1) * request.pageSize,
      page * request.pageSize,
    ),
    counts: {
      all: active.length,
      favorites: active.filter((model) => favorites.includes(model.hash))
        .length,
      stl: active.filter((m) => m.format === 'stl').length,
      threeMf: active.filter((m) => m.format === 'threeMf').length,
      obj: active.filter((m) => m.format === 'obj').length,
      step: active.filter((m) => m.format === 'step').length,
      duplicates: active.filter((m) => m.locations.length > 1).length,
      missing: active.filter((m) => !isAvailable(m)).length,
    },
    sources: [...roots].map((rootId) => {
      const mine = active.filter((m) =>
        m.locations.some((location) => location.rootId === rootId),
      );
      const locations = mine.flatMap((m) =>
        m.locations.filter((location) => location.rootId === rootId),
      );
      return {
        rootId,
        totalModels: mine.length,
        availableModels: mine.filter((m) =>
          m.locations.some((l) => l.rootId === rootId && l.available),
        ).length,
        availableLocations: locations.filter((l) => l.available).length,
        missingLocations: locations.filter((l) => !l.available).length,
        sample: locations.find((l) => l.available) ?? locations[0]!,
      };
    }),
    filteredTotal: visible.length,
    page,
    pageSize: request.pageSize,
  };
}

/** Keeps legacy fixture setup usable while exercising the new bounded channel. */
export function withModelPaging(
  api: Partial<PrintFarmerApi>,
): Partial<PrintFarmerApi> {
  const listModels = api.listModels;
  return {
    listCollections: () => Promise.resolve([]),
    listTags: () => Promise.resolve([]),
    ...api,
    ...(listModels && !api.queryModels
      ? {
          queryModels: async (request: QueryModelsRequest) =>
            modelPage(
              await listModels(),
              request,
              (await api.listFavorites?.()) ?? [],
            ),
        }
      : {}),
  };
}
