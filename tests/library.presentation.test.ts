import { describe, expect, it } from 'vitest';

import type { LogicalModel, ReconcileReport } from '../src/shared/ipc';
import {
  folderBasename,
  libraryPresentation,
} from '../src/renderer/library/presentation';
import { defaultLibraryView } from '../src/renderer/library/filter';

const emptyReport: ReconcileReport = {
  added: 0,
  changed: 0,
  unchanged: 0,
  missing: 0,
  hashErrors: 0,
};

function model(
  hash: string,
  rootRelative: string,
  overrides: Partial<LogicalModel> = {},
): LogicalModel {
  return {
    hash,
    format: 'stl',
    size: 100,
    locations: [
      {
        rootId: 'root',
        path: `C:\\Models\\${rootRelative}`,
        rootRelative,
        size: 100,
        available: true,
      },
    ],
    ...overrides,
  };
}

describe('libraryPresentation', () => {
  it('shows onboarding before any scan when the catalog is empty', () => {
    const presentation = libraryPresentation(
      [],
      'idle',
      null,
      defaultLibraryView,
    );

    expect(presentation.state).toBe('onboarding');
    expect(presentation.visibleModels).toEqual([]);
  });

  it('shows scanning while a scan is running', () => {
    const presentation = libraryPresentation(
      [],
      'scanning',
      null,
      defaultLibraryView,
    );

    expect(presentation.state).toBe('scanning');
  });

  it('distinguishes an empty catalog after a scan from first-run onboarding', () => {
    const presentation = libraryPresentation(
      [],
      'idle',
      emptyReport,
      defaultLibraryView,
    );

    expect(presentation.state).toBe('empty-scan');
  });

  it('treats a configured empty root as post-onboarding even before a scan report', () => {
    const presentation = libraryPresentation(
      [],
      'idle',
      null,
      defaultLibraryView,
      1,
    );

    expect(presentation.state).toBe('empty-scan');
  });

  it('distinguishes a filter miss from an empty catalog', () => {
    const presentation = libraryPresentation(
      [model('abc', 'benchy.stl')],
      'idle',
      emptyReport,
      { ...defaultLibraryView, query: 'not-here' },
    );

    expect(presentation.state).toBe('empty-filter');
    expect(presentation.visibleModels).toEqual([]);
  });

  it('returns populated with visible models when the view has matches', () => {
    const benchy = model('abc', 'benchy.stl');
    const cube = model('def', 'cube.stl');
    const presentation = libraryPresentation(
      [cube, benchy],
      'idle',
      null,
      defaultLibraryView,
    );

    expect(presentation.state).toBe('populated');
    expect(presentation.visibleModels).toEqual([benchy, cube]);
  });
});

describe('folderBasename', () => {
  it('extracts a folder name from Windows or POSIX paths', () => {
    expect(folderBasename('C:\\Users\\me\\Models')).toBe('Models');
    expect(folderBasename('/home/me/Models/')).toBe('Models');
  });

  it('keeps null when no scan path is available', () => {
    expect(folderBasename(null)).toBeNull();
  });

  it('falls back to the original path for all-separator roots', () => {
    // "/" and "\\" strip to an empty basename; the original path is returned
    // rather than an empty string (exercises the `basename || path` fallback).
    expect(folderBasename('/')).toBe('/');
    expect(folderBasename('\\')).toBe('\\');
    expect(folderBasename('///')).toBe('///');
  });
});
