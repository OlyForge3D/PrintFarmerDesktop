import type { ServerProfile } from '@shared/ipc';

/**
 * One vocabulary for describing PrintFarmer authority, shared by the shell bar
 * and anything else that has to name the connection. Status is always carried
 * as text, never by the status dot alone.
 */
export function serverStatusLabel(profile: ServerProfile | null): string {
  if (!profile) return 'Disconnected';
  if (profile.status === 'error') return 'Connection error';
  if (profile.status === 'legacy') return 'Legacy fallback';
  return 'Connected';
}

export function serverVersionLabel(profile: ServerProfile | null): string {
  if (!profile) return 'No server selected yet';
  return profile.version?.version ?? 'Legacy server';
}

export function serverAccessibleLabel(profile: ServerProfile | null): string {
  const actionLabel = profile ? 'Manage connection' : 'Connect to PrintFarmer';
  const detailLabels = profile
    ? [
        profile.displayName,
        serverVersionLabel(profile),
        `Status: ${serverStatusLabel(profile)}`,
      ]
    : [serverVersionLabel(profile), `Status: ${serverStatusLabel(profile)}`];
  return `${actionLabel}: ${detailLabels.join(', ')}`;
}
