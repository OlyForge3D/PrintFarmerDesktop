import { useState } from 'react';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConflictResolutionCenter } from '../src/renderer/sync/ConflictResolutionCenter.js';
import {
  COLLECTION_DESCRIPTION_MAX_LENGTH,
  COLLECTION_NAME_MAX_LENGTH,
  type ConflictResolutionCenterProps,
  type MembershipConflictViewModel,
  type ModelCollectionConflictViewModel,
  type SelectConflictRequest,
  type TagConflictViewModel,
} from '../src/renderer/sync/types.js';

const NOW = Date.UTC(2026, 6, 23, 20, 0, 0);
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

describe('<ConflictResolutionCenter /> accessibility and list behavior', () => {
  it('labels and contains the modal, closes with Escape, and restores focus', async () => {
    const onClose = vi.fn();

    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open conflicts
          </button>
          {open ? (
            <ConflictResolutionCenter
              {...centerProps({
                onClose: () => {
                  onClose();
                  setOpen(false);
                },
              })}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open conflicts' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', {
      name: 'Resolve sync conflicts',
    });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription(
      /Review local and server changes for Production farm/,
    );
    const close = screen.getByRole('button', {
      name: 'Close conflict resolution center',
    });
    expect(close).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 unresolved conflict for Production farm.',
    );

    const confirmation = screen.getByRole('checkbox', {
      name: /I have reviewed the comparison/,
    });
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirmation).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    trigger.focus();
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole('dialog', { name: 'Resolve sync conflicts' }),
    ).not.toBeInTheDocument();
  });

  it('uses roving keyboard selection and sends profile-scoped selections', () => {
    const onSelect = vi.fn<(request: SelectConflictRequest) => void>();
    const conflicts = [
      collectionConflict(),
      membershipConflict(),
      tagConflict(),
    ] as const;

    function Harness(): React.JSX.Element {
      const [selectedConflictId, setSelectedConflictId] = useState(
        conflicts[0].conflictId,
      );
      return (
        <ConflictResolutionCenter
          {...centerProps({
            conflicts,
            unresolvedCount: conflicts.length,
            selectedConflictId,
            onSelectConflict: (request) => {
              onSelect(request);
              setSelectedConflictId(request.conflictId);
            },
          })}
        />
      );
    }

    render(<Harness />);
    const options = screen.getAllByRole('option');
    options[0]?.focus();
    fireEvent.keyDown(options[0]!, { key: 'ArrowDown' });
    expect(options[1]).toHaveFocus();
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(onSelect).toHaveBeenLastCalledWith({
      profileId: PROFILE_ID,
      conflictId: 'conflict-membership',
    });
    expect(
      screen.getByRole('heading', { name: 'gear.stl in Favorites' }),
    ).toBeVisible();

    fireEvent.keyDown(options[1]!, { key: 'End' });
    expect(options[2]).toHaveFocus();
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(options[2]!, { key: 'Home' });
    expect(options[0]).toHaveFocus();
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('renders deterministic loading, empty, error, and refresh states', () => {
    const onRefresh = vi.fn<ConflictResolutionCenterProps['onRefresh']>();
    const { container, rerender } = render(
      <ConflictResolutionCenter
        {...centerProps({
          conflicts: [],
          unresolvedCount: 0,
          selectedConflictId: null,
          loading: true,
          onRefresh,
        })}
      />,
    );

    expect(screen.getByText('Loading conflicts…')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();

    rerender(
      <ConflictResolutionCenter
        {...centerProps({
          conflicts: [],
          unresolvedCount: 0,
          selectedConflictId: null,
          onRefresh,
        })}
      />,
    );
    expect(screen.getByText('No conflicts to resolve')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledWith({ profileId: PROFILE_ID });

    const unsafeError = '<script>steal()</script>';
    rerender(
      <ConflictResolutionCenter
        {...centerProps({
          conflicts: [],
          unresolvedCount: 0,
          selectedConflictId: null,
          loadError: unsafeError,
          onRefresh,
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(unsafeError);
    expect(container.querySelector('script')).toBeNull();
  });

  it('uses fixed reason labels and typed, text-only comparison values', () => {
    const unsafeReason = '<img src=x onerror=steal()>';
    const unsafeName = '<img src=x onerror=payload()>';
    const conflict = collectionConflict({
      reasonCode:
        unsafeReason as ModelCollectionConflictViewModel['reasonCode'],
      createdAt: NOW - 2 * 60 * 60 * 1000,
      localValue: {
        name: unsafeName,
        description: '<b>local description</b>',
        isShared: false,
      },
    });
    const { container } = render(
      <ConflictResolutionCenter
        {...centerProps({ conflicts: [conflict], now: NOW })}
      />,
    );

    expect(screen.queryByText(unsafeReason)).not.toBeInTheDocument();
    expect(
      screen.getAllByText(
        'The server could not apply this pending change safely.',
      ),
    ).toHaveLength(2);
    expect(screen.getByText(/2 hours ago/)).toBeVisible();
    expect(screen.getAllByText(unsafeName).length).toBeGreaterThan(0);
    expect(container.querySelector('img, b')).toBeNull();

    const table = screen.getByRole('table', {
      name: 'Local, server, and submitted values',
    });
    const descriptionRow = within(table)
      .getByRole('rowheader', { name: 'Description' })
      .closest('tr');
    expect(descriptionRow).not.toBeNull();
    expect(
      within(descriptionRow!).getByText('<b>local description</b>'),
    ).toBeVisible();
    expect(within(descriptionRow!).getByText('Server copy')).toBeVisible();
    expect(within(descriptionRow!).getByText('Queued edit')).toBeVisible();
  });
});

describe('<ConflictResolutionCenter /> resolution contract', () => {
  it('offers only entity-supported actions', () => {
    const { rerender } = render(
      <ConflictResolutionCenter {...centerProps()} />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /^Accept server/ })).toBeVisible();
    expect(screen.getByRole('radio', { name: /^Keep local/ })).toBeVisible();
    expect(screen.getByRole('radio', { name: /^Manual merge/ })).toBeVisible();

    const membership = membershipConflict();
    rerender(
      <ConflictResolutionCenter
        {...centerProps({
          conflicts: [membership],
          selectedConflictId: membership.conflictId,
        })}
      />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /^Keep local/ })).toBeVisible();
    expect(
      screen.queryByRole('radio', { name: /^Manual merge/ }),
    ).not.toBeInTheDocument();

    const tag = tagConflict();
    rerender(
      <ConflictResolutionCenter
        {...centerProps({
          conflicts: [tag],
          selectedConflictId: tag.conflictId,
        })}
      />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(
      screen.queryByRole('radio', { name: /^Keep local/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Tags are pull-only/)).toBeVisible();
  });

  it('requires confirmation and emits the exact fenced accept-server payload', () => {
    const onResolve = vi.fn<ConflictResolutionCenterProps['onResolve']>();
    render(<ConflictResolutionCenter {...centerProps({ onResolve })} />);

    const resolve = screen.getByRole('button', { name: 'Resolve conflict' });
    expect(resolve).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /I have reviewed the comparison/,
      }),
    );
    expect(resolve).toBeEnabled();
    fireEvent.click(resolve);

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledWith({
      profileId: PROFILE_ID,
      conflictId: 'conflict-collection',
      conflictVersion: 7,
      expectedUnresolvedToken: 'unresolved-collection-7',
      batchIncarnation: 'batch-incarnation-3',
      expectedAttemptToken: 'attempt-token-5',
      actionInput: { kind: 'acceptServer' },
    });
    expect(screen.getByRole('heading', { name: 'Castle parts' })).toBeVisible();
    expect(resolve).toBeEnabled();
    expect(screen.queryByText('Resolving…')).not.toBeInTheDocument();
  });

  it('emits a fenced binary keep-local membership payload', () => {
    const onResolve = vi.fn<ConflictResolutionCenterProps['onResolve']>();
    const conflict = membershipConflict();
    render(
      <ConflictResolutionCenter
        {...centerProps({
          conflicts: [conflict],
          selectedConflictId: conflict.conflictId,
          onResolve,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: /^Keep local/ }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /I have reviewed the comparison/,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflict' }));

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledWith({
      profileId: PROFILE_ID,
      conflictId: 'conflict-membership',
      conflictVersion: 4,
      expectedUnresolvedToken: 'unresolved-membership-4',
      batchIncarnation: 'batch-incarnation-2',
      expectedAttemptToken: 'attempt-token-8',
      actionInput: { kind: 'keepLocal' },
    });
  });

  it('validates supported manual fields and resets confirmation after edits', () => {
    const onResolve = vi.fn<ConflictResolutionCenterProps['onResolve']>();
    render(<ConflictResolutionCenter {...centerProps({ onResolve })} />);

    fireEvent.click(screen.getByRole('radio', { name: /^Manual merge/ }));
    const name = screen.getByLabelText('Collection name');
    const description = screen.getByLabelText('Description (optional)');
    const confirmation = screen.getByRole('checkbox', {
      name: /I have reviewed the comparison/,
    });
    const resolve = screen.getByRole('button', { name: 'Resolve conflict' });

    fireEvent.change(name, { target: { value: '   ' } });
    expect(screen.getByText('Enter a collection name.')).toBeVisible();
    expect(confirmation).toBeDisabled();

    fireEvent.change(name, {
      target: { value: 'x'.repeat(COLLECTION_NAME_MAX_LENGTH + 1) },
    });
    expect(
      screen.getByText(
        `Use ${COLLECTION_NAME_MAX_LENGTH.toLocaleString()} characters or fewer.`,
      ),
    ).toBeVisible();

    fireEvent.change(name, { target: { value: 'Merged castle parts' } });
    fireEvent.change(description, {
      target: {
        value: 'x'.repeat(COLLECTION_DESCRIPTION_MAX_LENGTH + 1),
      },
    });
    expect(
      screen.getByText(
        `Use ${COLLECTION_DESCRIPTION_MAX_LENGTH.toLocaleString()} characters or fewer.`,
      ),
    ).toBeVisible();
    fireEvent.change(description, {
      target: { value: 'Reviewed local and server edits' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Share this collection on the server',
      }),
    );
    fireEvent.click(confirmation);
    expect(resolve).toBeEnabled();

    fireEvent.change(description, {
      target: { value: 'Final reviewed description' },
    });
    expect(confirmation).not.toBeChecked();
    expect(resolve).toBeDisabled();
    fireEvent.click(confirmation);
    fireEvent.click(resolve);

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledWith({
      profileId: PROFILE_ID,
      conflictId: 'conflict-collection',
      conflictVersion: 7,
      expectedUnresolvedToken: 'unresolved-collection-7',
      batchIncarnation: 'batch-incarnation-3',
      expectedAttemptToken: 'attempt-token-5',
      actionInput: {
        kind: 'manualMerge',
        value: {
          name: 'Merged castle parts',
          description: 'Final reviewed description',
          isShared: true,
        },
      },
    });
  });

  it.each([
    ['resolving', 'The parent is resolving this conflict'],
    ['stale', 'This conflict changed'],
    ['unresolvable', 'This conflict cannot be resolved from the desktop'],
  ] as const)('disables actions while %s', (resolutionState, message) => {
    const onResolve = vi.fn<ConflictResolutionCenterProps['onResolve']>();
    const conflict = collectionConflict({ resolutionState });
    render(
      <ConflictResolutionCenter
        {...centerProps({ conflicts: [conflict], onResolve })}
      />,
    );

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toBeDisabled();
    }
    expect(
      screen.getByRole('checkbox', {
        name: /I have reviewed the comparison/,
      }),
    ).toBeDisabled();
    const resolve = screen.getByRole('button', {
      name: resolutionState === 'resolving' ? 'Resolving…' : 'Resolve conflict',
    });
    expect(resolve).toBeDisabled();
    expect(screen.getByText(new RegExp(message))).toBeVisible();
    fireEvent.click(resolve);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('surfaces parent load and resolution errors without changing conflict state', () => {
    const conflict = collectionConflict({
      resolutionError: '<b>another window resolved it</b>',
    });
    const { container } = render(
      <ConflictResolutionCenter
        {...centerProps({
          conflicts: [conflict],
          loadError: 'Server unavailable.',
        })}
      />,
    );

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('Server unavailable.');
    expect(alerts[1]).toHaveTextContent('<b>another window resolved it</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Resolve conflict' }),
    ).toBeDisabled();
  });
});

function centerProps(
  overrides: Partial<ConflictResolutionCenterProps> = {},
): ConflictResolutionCenterProps {
  const conflict = collectionConflict();
  return {
    profileId: PROFILE_ID,
    profileName: 'Production farm',
    conflicts: [conflict],
    unresolvedCount: 1,
    selectedConflictId: conflict.conflictId,
    loading: false,
    loadError: null,
    now: NOW,
    onSelectConflict: vi.fn(),
    onRefresh: vi.fn(),
    onResolve: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function collectionConflict(
  overrides: Partial<ModelCollectionConflictViewModel> = {},
): ModelCollectionConflictViewModel {
  return {
    conflictId: 'conflict-collection',
    conflictVersion: 7,
    unresolvedToken: 'unresolved-collection-7',
    batchIncarnation: 'batch-incarnation-3',
    attemptToken: 'attempt-token-5',
    entityType: 'ModelCollection',
    entityId: '22222222-2222-4222-8222-222222222222',
    reasonCode: 'concurrentUpdate',
    createdAt: NOW - 5 * 60 * 1000,
    resolutionState: 'ready',
    resolutionError: null,
    localValue: {
      name: 'Castle parts',
      description: 'Local copy',
      isShared: false,
    },
    serverValue: {
      name: 'Castle parts - server',
      description: 'Server copy',
      isShared: true,
    },
    submittedValue: {
      name: 'Castle parts',
      description: 'Queued edit',
      isShared: false,
    },
    ...overrides,
  };
}

function membershipConflict(
  overrides: Partial<MembershipConflictViewModel> = {},
): MembershipConflictViewModel {
  return {
    conflictId: 'conflict-membership',
    conflictVersion: 4,
    unresolvedToken: 'unresolved-membership-4',
    batchIncarnation: 'batch-incarnation-2',
    attemptToken: 'attempt-token-8',
    entityType: 'ModelCollectionMembership',
    entityId: '33333333-3333-4333-8333-333333333333',
    reasonCode: 'deletedOnServer',
    createdAt: NOW - 25 * 60 * 1000,
    resolutionState: 'ready',
    resolutionError: null,
    localValue: {
      collectionName: 'Favorites',
      modelName: 'gear.stl',
      isMember: true,
    },
    serverValue: {
      collectionName: 'Favorites',
      modelName: 'gear.stl',
      isMember: false,
    },
    submittedValue: {
      collectionName: 'Favorites',
      modelName: 'gear.stl',
      isMember: true,
    },
    ...overrides,
  };
}

function tagConflict(
  overrides: Partial<TagConflictViewModel> = {},
): TagConflictViewModel {
  return {
    conflictId: 'conflict-tag',
    conflictVersion: 2,
    unresolvedToken: 'unresolved-tag-2',
    batchIncarnation: 'batch-incarnation-1',
    attemptToken: 'attempt-token-9',
    entityType: 'Tag',
    entityId: '44444444-4444-4444-8444-444444444444',
    reasonCode: 'permissionChanged',
    createdAt: NOW - 24 * 60 * 60 * 1000,
    resolutionState: 'ready',
    resolutionError: null,
    localValue: {
      name: 'Mechanical',
      category: 'Use',
      description: null,
      color: '#00aaff',
      isAutoGenerated: false,
    },
    serverValue: {
      name: 'Mechanisms',
      category: 'Use',
      description: 'Server-managed tag',
      color: '#00aaff',
      isAutoGenerated: false,
    },
    submittedValue: null,
    ...overrides,
  };
}
