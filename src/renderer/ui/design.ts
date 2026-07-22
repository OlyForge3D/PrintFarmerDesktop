export const DESIGN_CONCEPTS = [
  {
    id: 'studio',
    shortName: 'Studio',
    name: 'Precision Studio',
    description: 'Calm, dark CAD workspace',
  },
  {
    id: 'archive',
    shortName: 'Archive',
    name: 'Gallery Archive',
    description: 'Warm, image-first catalog',
  },
  {
    id: 'console',
    shortName: 'Console',
    name: 'Operations Console',
    description: 'Compact engineering browser',
  },
] as const;

export type DesignConcept = (typeof DESIGN_CONCEPTS)[number]['id'];

const STORAGE_KEY = 'printfarmer.design-concept.v1';

export function isDesignConcept(value: unknown): value is DesignConcept {
  return DESIGN_CONCEPTS.some((concept) => concept.id === value);
}

export function initialDesignConcept(): DesignConcept {
  try {
    const requested = new URLSearchParams(globalThis.location?.search).get(
      'design',
    );
    if (isDesignConcept(requested)) {
      return requested;
    }
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isDesignConcept(stored)) {
      return stored;
    }
  } catch {
    // Storage and location access are optional in tests and hardened contexts.
  }
  return 'studio';
}

export function persistDesignConcept(concept: DesignConcept): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, concept);
  } catch {
    // The design still switches for this session if persistence is unavailable.
  }
}
