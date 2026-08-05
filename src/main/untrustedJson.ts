/**
 * Bounded, parser-independent checks over untrusted JSON.
 *
 * Ported verbatim from commit bc35a0b (the parallel #158 session,
 * `dev/jpapiez/issue-158-malicious-corpus`) rather than reimplemented, so the
 * two efforts do not diverge on the same defence. Each function here is
 * carried because a corpus vector proved the absence was reachable, not
 * because it seemed prudent:
 *
 * - `findUnsafeJsonNumber` — measured: before this, `runLegacyBackupPreflight`
 *   accepted a backup carrying `9007199254740993` (silently truncated to
 *   ...992 by the JSON parser) and `-1` in a size-shaped field as
 *   `importableCount: 1`. Only non-finite values were caught. Two of the three
 *   unsafe-numeric shapes went straight through.
 * - `findDuplicateJsonObjectKey` — the pre-existing detector in
 *   calibrationImportV4 scanned key names *globally* rather than per object,
 *   so any backup holding both a project and a photo repeated the key `id` and
 *   earned a duplicate-key warning with no duplicate present. Per-object
 *   scanning removes the false positive without weakening the true one.
 * - `isPathShapedIdentifier` — used to keep traversal-shaped identifiers from
 *   being treated as anything but opaque data.
 *
 * None of these parses with the parser under test; that is deliberate, since a
 * check that reuses the parser inherits whatever the parser already lost.
 */
export interface UnsafeJsonNumber {
  readonly path: string;
  readonly value: number;
  readonly reason: 'nonFinite' | 'unsafeInteger' | 'negativeSize';
}

interface JsonContainer {
  readonly kind: 'array' | 'object';
  readonly keys?: Set<string>;
  expectingKey: boolean;
}

function readJsonStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return index;
    }
  }
  return text.length - 1;
}

/**
 * Finds duplicate keys within the same JSON object without using the parser
 * under test. Reusing a global key set would incorrectly reject identical keys
 * in sibling objects.
 */
export function findDuplicateJsonObjectKey(text: string): string | null {
  const containers: JsonContainer[] = [];

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    const current = containers.at(-1);
    if (character === '"') {
      const end = readJsonStringEnd(text, index);
      if (current?.kind === 'object' && current.expectingKey) {
        const token = text.slice(index, end + 1);
        let key: string;
        try {
          key = JSON.parse(token) as string;
        } catch {
          return null;
        }
        if (current.keys!.has(key)) return key;
        current.keys!.add(key);
        current.expectingKey = false;
      }
      index = end;
      continue;
    }
    if (character === '{') {
      containers.push({
        kind: 'object',
        keys: new Set<string>(),
        expectingKey: true,
      });
    } else if (character === '[') {
      containers.push({ kind: 'array', expectingKey: false });
    } else if (character === '}' || character === ']') {
      containers.pop();
    } else if (character === ',' && current?.kind === 'object') {
      current.expectingKey = true;
    }
  }

  return null;
}

export function measureJsonDepth(
  value: unknown,
  maximum: number,
  depth = 0,
): number {
  if (depth > maximum) return depth;
  if (Array.isArray(value)) {
    let deepest = depth;
    for (const item of value) {
      deepest = Math.max(deepest, measureJsonDepth(item, maximum, depth + 1));
      if (deepest > maximum) break;
    }
    return deepest;
  }
  if (value !== null && typeof value === 'object') {
    let deepest = depth;
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepest = Math.max(deepest, measureJsonDepth(item, maximum, depth + 1));
      if (deepest > maximum) break;
    }
    return deepest;
  }
  return depth;
}

const SIZE_KEY = /(?:^|_)(?:byte_?)?(?:size|length|count|bytes)$/i;

export function findUnsafeJsonNumber(
  value: unknown,
  path = '$',
  key = '',
): UnsafeJsonNumber | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { path, value, reason: 'nonFinite' };
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return { path, value, reason: 'unsafeInteger' };
    }
    if (value < 0 && SIZE_KEY.test(key)) {
      return { path, value, reason: 'negativeSize' };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const unsafe = findUnsafeJsonNumber(
        value[index],
        `${path}[${index}]`,
        key,
      );
      if (unsafe !== null) return unsafe;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const unsafe = findUnsafeJsonNumber(
        childValue,
        `${path}.${childKey}`,
        childKey,
      );
      if (unsafe !== null) return unsafe;
    }
  }
  return null;
}

export function isPathShapedIdentifier(value: string): boolean {
  return (
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\') ||
    value === '.' ||
    value === '..' ||
    /^[a-zA-Z]:/.test(value)
  );
}
