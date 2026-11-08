const ZIP_MARKER = '::zip::';

export interface ZipMemberSource {
  archivePath: string;
  index: number;
  memberName: string;
}

/** A catalog locator is not a filesystem path. Validate before normalizing it. */
export function zipMemberSource(value: string): ZipMemberSource | null {
  const segments = value.split(/[\\/]/);
  const marker = segments.indexOf(ZIP_MARKER);
  if (marker < 0) return null;
  const markerOffset = /[\\/]::zip::(?=[\\/]|$)/.exec(value)?.index;
  const archivePath =
    markerOffset === undefined ? '' : value.slice(0, markerOffset);
  const indexText = segments[marker + 1] ?? '';
  const member = segments.slice(marker + 2);
  const index = Number(indexText);
  if (
    !/\.zip$/i.test(archivePath) ||
    !/^(0|[1-9][0-9]*)$/.test(indexText) ||
    !Number.isSafeInteger(index) ||
    index >= 100_000 ||
    member.length === 0 ||
    member.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[:\0]/.test(segment),
    ) ||
    member.join('/').length > 2048
  ) {
    throw new Error('Invalid ZIP model source. Rescan the source folder.');
  }
  return { archivePath, index, memberName: member.join('/') };
}

export function zipMemberPath(
  source: ZipMemberSource,
  archivePath = source.archivePath,
): string {
  const separator = archivePath.includes('\\') ? '\\' : '/';
  return `${archivePath}${separator}${ZIP_MARKER}${separator}${source.index}${separator}${source.memberName.replaceAll('/', separator)}`;
}

export function requireStandaloneModelPath(value: string): void {
  if (zipMemberSource(value)) {
    throw new Error(
      'This action requires an extracted model file. Extract this ZIP member and rescan the folder first.',
    );
  }
}
