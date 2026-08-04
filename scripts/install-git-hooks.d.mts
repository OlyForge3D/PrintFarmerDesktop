export const HOOKS_PATH: string;
export const REQUIRED_HOOK: string;
export function installGitHooks(cwd?: string): {
  installed: boolean;
  reason: string | null;
};
export interface HooksArmedStatus {
  armed: boolean;
  reason: string | null;
  configured: string | null;
  hooksDir: string | null;
  hookPath: string | null;
  toplevel: string | null;
}
export function verifyHooksArmed(cwd?: string): HooksArmedStatus;
export function describeUnarmed(status: HooksArmedStatus): string;
