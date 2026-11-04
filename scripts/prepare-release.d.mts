export interface ReleaseContext {
  sha: string;
  version: string;
  tag: string;
  publish: string;
  build: string;
  stable: string;
  beta: string;
}
export type CommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    encoding: 'utf8';
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => string;
export function validateReleaseVersion(version: unknown): string;
export function compareReleaseVersions(left: string, right: string): number;
export function readVersionDocuments(
  read: (file: string) => string,
): [Record<string, unknown>, Record<string, unknown>];
export function gitAuthenticationEnvironment(
  token: string,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function createReleaseCommit(options: {
  version: string;
  runIdentity: string;
  baseSha: string;
  git: (args: string[]) => string;
  npm: (args: string[]) => unknown;
  read: (file: string) => string;
}): { sha: string; tag: string; version: string };
export function releaseContext(
  sha: string,
  version: string,
  publish: boolean,
  build?: boolean,
): ReleaseContext;
export function expectedReleaseAssets(version: string): string[];
export function verifyPublishedRelease(
  release: {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    assets: { name: string }[];
  },
  context: ReleaseContext,
): void;
export function main(
  environment?: NodeJS.ProcessEnv,
  directory?: string,
  invoke?: CommandRunner,
): ReleaseContext;
