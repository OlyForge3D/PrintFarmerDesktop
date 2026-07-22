import { beforeEach, describe, expect, it } from 'vitest';
import {
  initialDesignConcept,
  isDesignConcept,
  persistDesignConcept,
} from '../src/renderer/ui/design';

describe('design concepts', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('recognizes only the three review concepts', () => {
    expect(isDesignConcept('studio')).toBe(true);
    expect(isDesignConcept('archive')).toBe(true);
    expect(isDesignConcept('console')).toBe(true);
    expect(isDesignConcept('dashboard')).toBe(false);
  });

  it('defaults to Precision Studio and persists a user choice', () => {
    expect(initialDesignConcept()).toBe('studio');
    persistDesignConcept('archive');
    expect(initialDesignConcept()).toBe('archive');
  });

  it('lets a screenshot URL override the persisted choice', () => {
    persistDesignConcept('console');
    window.history.replaceState({}, '', '/?design=archive');
    expect(initialDesignConcept()).toBe('archive');
  });
});
