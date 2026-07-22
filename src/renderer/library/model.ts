import type { LogicalModel, ModelFormat } from '@shared/ipc';

/**
 * A stable, deterministic source-root id derived from an absolute folder path.
 *
 * The renderer does not persist its list of added folders, but the sidecar
 * catalog keys locations by `rootId`. Deriving the id from the path (rather than
 * a random value) keeps re-scanning the same folder idempotent across restarts.
 */
export function rootIdForPath(path: string): string {
  // djb2 over the UTF-16 code units — small, fast, and dependency-free. Collision
  // risk is irrelevant here: it only needs to be stable per distinct path.
  let hash = 5381;
  for (let i = 0; i < path.length; i += 1) {
    hash = (hash * 33) ^ path.charCodeAt(i);
  }
  return `root-${(hash >>> 0).toString(16)}`;
}

/** The last path segment of a `\`- or `/`-separated path. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const match = /[^\\/]*$/.exec(trimmed);
  return match ? match[0] : trimmed;
}

/**
 * A human-friendly display name for a model: the file name of its first
 * location, falling back to a short prefix of the content hash.
 */
export function modelDisplayName(model: LogicalModel): string {
  const first = model.locations[0];
  if (first) {
    return basename(first.rootRelative || first.path);
  }
  return model.hash.slice(0, 12);
}

/** The preferred absolute path to open for a model: first available location. */
export function preferredPath(model: LogicalModel): string | null {
  const available = model.locations.find((location) => location.available);
  return (available ?? model.locations[0])?.path ?? null;
}

/** Whether at least one physical copy of the model is currently present. */
export function isAvailable(model: LogicalModel): boolean {
  return model.locations.some((location) => location.available);
}

/** Uppercase short label for a model format. */
export function formatLabel(format: ModelFormat): string {
  return format === 'threeMf' ? '3MF' : 'STL';
}

/** Compact human-readable byte size (e.g. `1.2 MB`). */
export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]!}`;
}
