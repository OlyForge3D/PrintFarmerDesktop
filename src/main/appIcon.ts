import path from 'node:path';

export function resolveAppIconPath(
  appPath: string,
  resourcesPath: string,
  isPackaged: boolean,
): string {
  return isPackaged
    ? path.join(resourcesPath, 'icon.png')
    : path.join(appPath, 'assets', 'icon.png');
}
