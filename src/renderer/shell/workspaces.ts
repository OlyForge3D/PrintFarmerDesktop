import type { IconName } from '../ui/Icon';

/**
 * Top-level places in the desktop shell. Adding a feature means adding an entry
 * here and a component that renders its landmark — not editing the shell's
 * skip link, focus restore, rail markup, and status label one ternary at a time.
 */
export type WorkspaceId = 'library' | 'calibration' | 'uploads' | 'sources';

/**
 * `places` are where operators do the product's work. `services` are app-level
 * facilities those places depend on. Both are real destinations, not dialogs.
 */
export type WorkspaceGroup = 'places' | 'services';

export interface WorkspaceDefinition {
  readonly id: WorkspaceId;
  /** Rail label and accessible name. Also names the place in shell messages. */
  readonly label: string;
  readonly icon: IconName;
  /** `id` of the workspace's `<main>`, and the skip link's target. */
  readonly landmarkId: string;
  /** Completes "Skip to ...". */
  readonly skipTarget: string;
  /** Element focused after navigating here, so the move is announced. */
  readonly headingSelector: string;
  readonly group: WorkspaceGroup;
}

export const WORKSPACE_GROUP_LABELS: Record<WorkspaceGroup, string> = {
  places: 'Workspaces',
  services: 'Services',
};

const WORKSPACES: readonly WorkspaceDefinition[] = [
  {
    id: 'library',
    label: 'Library',
    icon: 'collection',
    landmarkId: 'library-main',
    skipTarget: 'model library',
    headingSelector: '[data-library-heading]',
    group: 'places',
  },
  {
    id: 'calibration',
    label: 'Filament Calibration',
    icon: 'calibration',
    landmarkId: 'calibration-main',
    skipTarget: 'filament calibration',
    headingSelector: '[data-cal-heading]',
    group: 'places',
  },
  {
    id: 'uploads',
    label: 'Uploads',
    icon: 'upload',
    landmarkId: 'uploads-main',
    skipTarget: 'upload queue',
    headingSelector: '[data-uploads-heading]',
    group: 'services',
  },
  {
    id: 'sources',
    label: 'Sources',
    icon: 'folder',
    landmarkId: 'sources-main',
    skipTarget: 'catalog sources',
    headingSelector: '[data-sources-heading]',
    group: 'services',
  },
];

export const WORKSPACE_LIST = WORKSPACES;

export const DEFAULT_WORKSPACE: WorkspaceId = 'library';

export function workspaceById(id: WorkspaceId): WorkspaceDefinition {
  const found = WORKSPACES.find((workspace) => workspace.id === id);
  // The union type makes the fallback unreachable in practice; it keeps a
  // corrupted id from rendering a shell with no landmark at all.
  return found ?? WORKSPACES[0]!;
}

export function workspacesInGroup(
  group: WorkspaceGroup,
): readonly WorkspaceDefinition[] {
  return WORKSPACES.filter((workspace) => workspace.group === group);
}
