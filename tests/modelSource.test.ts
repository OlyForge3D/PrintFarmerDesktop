import { describe, expect, it } from 'vitest';
import {
  requireStandaloneModelPath,
  zipMemberPath,
  zipMemberSource,
} from '../src/shared/modelSource';
import { preferredPath } from '../src/renderer/library/model';
import {
  summarizeSourceRoots,
  reconcileHeadline,
} from '../src/renderer/library/sourceRoots';

describe('ZIP model locators', () => {
  it.each([
    '/models/parts.zip',
    'C:\\models\\parts.zip',
    '/foo::zip::bar/parts.zip',
  ])('round-trips archive and member identity on %s', (archivePath) => {
    const source = { archivePath, index: 12, memberName: 'nested/part.stl' };
    expect(zipMemberSource(zipMemberPath(source))).toEqual(source);
    expect(zipMemberSource(archivePath)).toBeNull();
    expect(() => requireStandaloneModelPath(zipMemberPath(source))).toThrow(
      'Extract',
    );
    expect(() => requireStandaloneModelPath('/models/part.stl')).not.toThrow();
  });

  it.each([
    '/models/parts.zip/::zip::',
    '/models/parts.zip/::zip::/0/../part.stl',
    '/models/parts.zip/::zip::/0/./part.stl',
    '/models/parts.zip/::zip::/-1/part.stl',
    '/models/parts.zip/::zip::/100000/part.stl',
    '/models/parts.zip/::zip::/0/C:/part.stl',
    '/models/parts.zip/::zip::/0//part.stl',
  ])(
    'rejects invalid locators before filesystem normalization: %s',
    (value) => {
      expect(() => zipMemberSource(value)).toThrow('Invalid ZIP');
    },
  );

  it('prefers an extracted duplicate and derives the real indexed root from a member', () => {
    const archived = {
      rootId: 'root',
      path: '/models/parts.zip/::zip::/0/nested/part.stl',
      rootRelative: 'parts.zip/nested/part.stl',
      available: true,
      size: 4,
      modifiedUnixSeconds: null,
    };
    const model = {
      hash: 'a'.repeat(64),
      format: 'stl' as const,
      size: 4,
      locations: [archived],
    };
    expect(preferredPath(model)).toBe(archived.path);
    expect(summarizeSourceRoots([model], [])[0]?.path).toBe('/models');
    model.locations.push({
      ...archived,
      path: '/models/part.stl',
      rootRelative: 'part.stl',
    });
    expect(preferredPath(model)).toBe('/models/part.stl');
    expect(
      reconcileHeadline({
        added: 0,
        changed: 0,
        unchanged: 0,
        missing: 0,
        hashErrors: 0,
        scanErrors: 1,
      }),
    ).toBe('Some library files could not be indexed');
  });
});
