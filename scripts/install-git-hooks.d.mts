export const HOOKS_PATH: string;
export function installGitHooks(cwd?: string): {
  installed: boolean;
  reason: string | null;
};
