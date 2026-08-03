export const MAC_APP_BUNDLE_NAME: string;
export function adhocSignArgs(appPath: string): string[];
export function macAppPaths(outputPaths: readonly string[]): string[];
export function adhocSignMacApps(outputPaths: readonly string[]): void;
