import { Icon } from '../ui/Icon';
import {
  WORKSPACE_GROUP_LABELS,
  workspacesInGroup,
  type WorkspaceGroup,
  type WorkspaceId,
} from './workspaces';

export interface WorkspaceBadge {
  readonly count: number;
  readonly tone: 'neutral' | 'warning';
  /** Read after the label, e.g. "4 transfers in progress". */
  readonly description: string;
}

export interface WorkspaceRailProps {
  activeWorkspace: WorkspaceId;
  disabled: boolean;
  disabledExplanation: string;
  badges: Partial<Record<WorkspaceId, WorkspaceBadge>>;
  onNavigate: (id: WorkspaceId) => void;
}

const GROUP_ORDER: WorkspaceGroup[] = ['places', 'services'];

const EXPLANATION_ID = 'workspace-switch-explanation';

/**
 * Persistent top-level navigation. A vertical rail rather than a segmented
 * control because these are destinations, not a choice between three options,
 * and because the set grows.
 */
export function WorkspaceRail({
  activeWorkspace,
  disabled,
  disabledExplanation,
  badges,
  onNavigate,
}: WorkspaceRailProps): React.JSX.Element {
  return (
    <nav className="workspace-rail" aria-label="Workspaces">
      {GROUP_ORDER.map((group) => (
        <section
          key={group}
          className="rail-group"
          aria-labelledby={`rail-group-${group}`}
        >
          <h2 className="rail-group-label" id={`rail-group-${group}`}>
            {WORKSPACE_GROUP_LABELS[group]}
          </h2>
          <ul className="rail-list">
            {workspacesInGroup(group).map((workspace) => {
              const badge = badges[workspace.id];
              const current = workspace.id === activeWorkspace;
              return (
                <li key={workspace.id}>
                  <button
                    type="button"
                    className="rail-item"
                    aria-current={current ? 'page' : undefined}
                    aria-describedby={disabled ? EXPLANATION_ID : undefined}
                    disabled={disabled}
                    onClick={() => onNavigate(workspace.id)}
                  >
                    <Icon name={workspace.icon} />
                    <span className="rail-item-label">{workspace.label}</span>
                    {badge && badge.count > 0 ? (
                      <>
                        <span
                          className={`rail-badge ${badge.tone}`}
                          aria-hidden="true"
                        >
                          {badge.count}
                        </span>
                        <span className="visually-hidden">
                          {badge.description}
                        </span>
                      </>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <span id={EXPLANATION_ID} className="visually-hidden">
        {disabledExplanation}
      </span>
    </nav>
  );
}
