export interface PrepareBrandedElectronOptions {
  platform?: NodeJS.Platform;
  productName?: string;
  sourceExecutable?: string;
  cacheRoot?: string;
  runCommand?: (command: string, args: string[]) => void;
  copyApp?: (source: string, target: string) => void;
}

export function prepareBrandedElectron(
  options?: PrepareBrandedElectronOptions,
): string | null;
