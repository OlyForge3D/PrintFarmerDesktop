import type { ServerProfile } from '@shared/ipc';
import {
  SourcesWorkspace,
  type SourcesWorkspaceProps,
} from '../library/SourcesWorkspace';
import { ThumbnailCacheSettings } from '../library/ThumbnailCacheSettings';
import { serverStatusLabel } from './serverPresentation';
import { ArchiveSettingsSection } from './ArchiveSettingsSection';

interface SettingsWorkspaceProps {
  sources: SourcesWorkspaceProps;
  profile: ServerProfile | null;
  connectionsDisabled: boolean;
  cacheDisabled: boolean;
  onManageProfiles: () => void;
  onCacheBusyChange: (busy: boolean) => void;
}

export function SettingsWorkspace({
  sources,
  profile,
  connectionsDisabled,
  cacheDisabled,
  onManageProfiles,
  onCacheBusyChange,
}: SettingsWorkspaceProps): React.JSX.Element {
  return (
    <main id="settings-main" className="settings-pane" aria-label="Settings">
      <header className="service-heading">
        <div>
          <h1 data-settings-heading tabIndex={-1}>
            Settings
          </h1>
          <p>
            Manage this computer's library, preview storage, and server
            connections.
          </p>
        </div>
      </header>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings sections">
          <a href="#settings-sources-heading">Source folders</a>
          <a href="#settings-archives-heading">ZIP files</a>
          <a href="#thumbnail-cache-title">Thumbnail cache</a>
          <a href="#settings-connections-heading">Connections</a>
        </nav>
        <div className="settings-content">
          <SourcesWorkspace {...sources} />
          <ArchiveSettingsSection
            disabled={cacheDisabled}
            onBusyChange={onCacheBusyChange}
          />
          <ThumbnailCacheSettings
            disabled={cacheDisabled}
            onBusyChange={onCacheBusyChange}
          />
          <section
            className="settings-connections"
            aria-labelledby="settings-connections-heading"
          >
            <header className="service-heading">
              <div>
                <h2 id="settings-connections-heading" tabIndex={-1}>
                  PrintFarmer connections
                </h2>
                <p>
                  {profile
                    ? `${profile.displayName} · ${serverStatusLabel(profile)}`
                    : 'No server selected. Your local library works without a connection.'}
                </p>
              </div>
              <button
                type="button"
                disabled={connectionsDisabled}
                onClick={onManageProfiles}
              >
                Manage server profiles
              </button>
            </header>
            <p className="settings-hint">
              Add, edit, test, or remove connections here. Use the server bar to
              switch the active connection while uploading or calibrating.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
