import path from 'node:path';

export function resolveAppIconPath(appPath: string): string {
  return path.join(appPath, 'assets', 'icon.png');
}
