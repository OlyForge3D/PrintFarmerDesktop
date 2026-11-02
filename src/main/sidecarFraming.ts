/**
 * Splits UTF-8-decoded sidecar output without rescanning a partial response.
 * A scene can span thousands of chunks, so joining them only once is important.
 */
export const MAX_SIDECAR_LINE_CHARACTERS = 64 * 1024 * 1024;

export function createSidecarLineFramer(
  onLine: (line: string) => void,
  onError: (error: Error) => void,
  maxLineLength = MAX_SIDECAR_LINE_CHARACTERS,
): (chunk: string) => void {
  let fragments: string[] = [];
  let length = 0;
  let failed = false;

  const append = (fragment: string): boolean => {
    length += fragment.length;
    if (length > maxLineLength) {
      failed = true;
      fragments = [];
      onError(
        new Error('Sidecar response exceeds the safe message size limit.'),
      );
      return false;
    }
    fragments.push(fragment);
    return true;
  };

  return (chunk: string): void => {
    if (failed) return;
    let start = 0;
    let newline = chunk.indexOf('\n');
    while (newline !== -1) {
      if (newline > start && !append(chunk.slice(start, newline))) return;
      const line = fragments.join('');
      fragments = [];
      length = 0;
      onLine(line);
      start = newline + 1;
      newline = chunk.indexOf('\n', start);
    }
    if (start < chunk.length) append(chunk.slice(start));
  };
}
