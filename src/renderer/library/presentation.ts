import type { LogicalModel, ReconcileReport } from '@shared/ipc';
import { selectLibraryView, type LibraryView } from './filter';
import type { LibraryStatus } from './useLibrary';

export type LibraryPresentationState =
  'onboarding' | 'scanning' | 'empty-scan' | 'empty-filter' | 'populated';

export interface LibraryPresentation {
  state: LibraryPresentationState;
  visibleModels: LogicalModel[];
}

/**
 * Centralizes the mutually exclusive library states so React only renders the
 * selected presentation.
 */
export function libraryPresentation(
  models: LogicalModel[],
  status: LibraryStatus,
  lastReport: ReconcileReport | null,
  view: LibraryView,
): LibraryPresentation {
  const visibleModels = selectLibraryView(models, view);

  if (status === 'scanning') {
    return { state: 'scanning', visibleModels };
  }

  if (models.length === 0) {
    return {
      state: lastReport ? 'empty-scan' : 'onboarding',
      visibleModels,
    };
  }

  if (visibleModels.length === 0) {
    return { state: 'empty-filter', visibleModels };
  }

  return { state: 'populated', visibleModels };
}

export function folderBasename(path: string | null): string | null {
  if (!path) {
    return null;
  }
  const trimmed = path.replace(/[\\/]+$/, '');
  const basename = trimmed.replace(/^.*[\\/]/, '');
  return basename || trimmed || path;
}
