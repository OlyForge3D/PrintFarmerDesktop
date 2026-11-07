// Single definition of "this change touches the visual design surface".
//
// Three consumers read it and must agree, or a UI change could slip past one
// of them while tripping another:
//
//   scripts/design-detector.mjs       CI: which changed files get scanned
//   scripts/design-detector-hook.mjs  agent hook: which edits get scanned
//   scripts/squad-verdict-gate.mjs    gate: which PRs need the design reviewer
//
// It lives in scripts/ (not src/) because squad-review-verdict.yml sparse-checks
// out only `scripts` from the default branch to run the gate.

export const DESIGN_REVIEWER = 'lambert';

// Files the vendored detector can actually analyse. `.ts`/`.js` are excluded on
// purpose: renderer logic files carry no markup or styles the detector reads,
// and scanning them would only produce noise the gate then has to explain.
export const DESIGN_SURFACE_EXTENSIONS = Object.freeze([
  '.tsx',
  '.jsx',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.vue',
  '.svelte',
  '.astro',
]);

const RENDERER_PREFIX = 'src/renderer/';
const ROOT_DESIGN_FILES = new Set(['index.html']);

// Paths that change what "good design" means for this repo, or how it is
// measured, without being UI themselves. They need the design reviewer but are
// not detector scan targets.
const DESIGN_GOVERNANCE_FILES = new Set(['DESIGN.md', 'PRODUCT.md']);
const DESIGN_GOVERNANCE_PREFIXES = Object.freeze([
  '.impeccable/',
  'tools/impeccable-detector/',
]);

export function normalizeRepoPath(filePath) {
  if (typeof filePath !== 'string') return '';
  return filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function extensionOf(filePath) {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export function isDesignSurfacePath(filePath) {
  const normalized = normalizeRepoPath(filePath);
  if (!normalized || normalized.startsWith('../') || normalized.startsWith('/'))
    return false;
  if (ROOT_DESIGN_FILES.has(normalized)) return true;
  if (!normalized.startsWith(RENDERER_PREFIX)) return false;
  return DESIGN_SURFACE_EXTENSIONS.includes(extensionOf(normalized));
}

export function isDesignGovernancePath(filePath) {
  const normalized = normalizeRepoPath(filePath);
  if (DESIGN_GOVERNANCE_FILES.has(normalized)) return true;
  return DESIGN_GOVERNANCE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

export function designSurfacePaths(paths) {
  return [...new Set((paths ?? []).map(normalizeRepoPath))].filter(
    isDesignSurfacePath,
  );
}

export function requiresDesignReview(paths) {
  return (paths ?? []).some(
    (p) => isDesignSurfacePath(p) || isDesignGovernancePath(p),
  );
}
