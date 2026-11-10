export function ciWindowsTimeout(
  existingMilliseconds: number,
  windowsCiMilliseconds: number,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  const inCi = Boolean(environment.CI) && environment.CI !== 'false';
  return inCi && platform === 'win32'
    ? windowsCiMilliseconds
    : existingMilliseconds;
}
