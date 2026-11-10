import { useEffect, useRef, useState } from 'react';
import type {
  ListServerProfilesResponse,
  ServerAuthMode,
  ServerProfile,
  ServerProfileDraft,
} from '@shared/ipc';

interface ServerProfilesDialogProps {
  profiles: ListServerProfilesResponse;
  onMutationSettled: () => void;
  onConnectionChanged?: (id: string) => void;
  onClose: () => void;
}

export function ServerProfilesDialog({
  profiles,
  onMutationSettled,
  onConnectionChanged,
  onClose,
}: ServerProfilesDialogProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authMode, setAuthMode] = useState<ServerAuthMode>('apiKey');
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tested, setTested] = useState<ServerProfile | null>(null);
  const [allowLegacy, setAllowLegacy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState<ServerProfile | null>(
    null,
  );
  const nameRef = useRef<HTMLInputElement | null>(null);
  const editTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreEditFocusRef = useRef(false);
  const draftRevisionRef = useRef(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const mountedRef = useRef(true);
  const operationEpochRef = useRef(0);
  onCloseRef.current = onClose;
  const closeDialog = (): void => {
    operationEpochRef.current += 1;
    onCloseRef.current();
  };
  const closeDialogRef = useRef(closeDialog);
  closeDialogRef.current = closeDialog;
  const operationIsCurrent = (epoch: number): boolean =>
    mountedRef.current && operationEpochRef.current === epoch;

  useEffect(() => {
    mountedRef.current = true;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialogRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (
        event.target instanceof Node &&
        dialogRef.current &&
        !dialogRef.current.contains(event.target)
      ) {
        closeRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      mountedRef.current = false;
      operationEpochRef.current += 1;
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  useEffect(() => {
    if (!busy && restoreEditFocusRef.current) {
      restoreEditFocusRef.current = false;
      if (editTriggerRef.current?.isConnected) editTriggerRef.current.focus();
      else nameRef.current?.focus();
    }
  }, [busy]);

  const invalidateTest = (): void => {
    draftRevisionRef.current += 1;
    setTested(null);
    setAllowLegacy(false);
    setError(null);
  };

  const resetForm = (): void => {
    setEditingProfile(null);
    setDisplayName('');
    setBaseUrl('');
    setAuthMode('apiKey');
    setApiKey('');
    setUsername('');
    setPassword('');
    invalidateTest();
  };

  const editProfile = (
    profile: ServerProfile,
    trigger: HTMLButtonElement,
  ): void => {
    editTriggerRef.current = trigger;
    setEditingProfile(profile);
    setDisplayName(profile.displayName);
    setBaseUrl(profile.baseUrl);
    setAuthMode(profile.authMode);
    setUsername(profile.username ?? '');
    setApiKey('');
    setPassword('');
    invalidateTest();
    nameRef.current?.focus();
  };

  const canKeepCredentials =
    editingProfile !== null &&
    sameEndpoint(baseUrl, editingProfile.baseUrl) &&
    authMode === editingProfile.authMode &&
    (authMode === 'apiKey' || username.trim() === editingProfile.username);
  const keepCredentials =
    canKeepCredentials &&
    (authMode === 'apiKey' ? apiKey === '' : password === '');
  const insecureHttp = /^\s*http:/i.test(baseUrl);

  const draft = (): ServerProfileDraft => ({
    ...(editingProfile ? { id: editingProfile.id } : {}),
    displayName,
    baseUrl,
    credentials: keepCredentials
      ? { authMode: 'saved' }
      : authMode === 'apiKey'
        ? { authMode, apiKey }
        : { authMode, username, password, rememberMe: true },
    allowLegacy,
  });

  const testDraft = async (): Promise<void> => {
    if (busy) return;
    const epoch = ++operationEpochRef.current;
    const revision = draftRevisionRef.current;
    setBusy(true);
    setError(null);
    try {
      const result = await window.printFarmer.testServerProfile({
        source: 'draft',
        draft: draft(),
      });
      if (!operationIsCurrent(epoch)) return;
      if (draftRevisionRef.current !== revision) return;
      setTested(result);
    } catch (cause) {
      if (!operationIsCurrent(epoch)) return;
      if (draftRevisionRef.current !== revision) return;
      setTested(null);
      setError(errorMessage(cause));
    } finally {
      if (operationIsCurrent(epoch)) setBusy(false);
    }
  };

  const saveDraft = async (): Promise<void> => {
    if (busy || !tested) return;
    const epoch = ++operationEpochRef.current;
    setBusy(true);
    setError(null);
    try {
      const saved = await window.printFarmer.saveServerProfile(draft());
      if (editingProfile && !keepCredentials) onConnectionChanged?.(saved.id);
      if (!operationIsCurrent(epoch)) return;
      resetForm();
      restoreEditFocusRef.current = true;
    } catch (cause) {
      if (!operationIsCurrent(epoch)) return;
      setTested(null);
      setAllowLegacy(false);
      setError(errorMessage(cause));
    } finally {
      onMutationSettled();
      if (operationIsCurrent(epoch)) setBusy(false);
    }
  };

  const selectProfile = async (id: string): Promise<void> => {
    if (busy) return;
    const epoch = ++operationEpochRef.current;
    setBusy(true);
    setError(null);
    try {
      await window.printFarmer.selectServerProfile({ id });
      if (!operationIsCurrent(epoch)) return;
    } catch (cause) {
      if (!operationIsCurrent(epoch)) return;
      setError(errorMessage(cause));
    } finally {
      onMutationSettled();
      if (operationIsCurrent(epoch)) setBusy(false);
    }
  };

  const retestProfile = async (id: string): Promise<void> => {
    if (busy) return;
    const epoch = ++operationEpochRef.current;
    setBusy(true);
    setError(null);
    try {
      await window.printFarmer.testServerProfile({
        source: 'saved',
        id,
      });
      if (!operationIsCurrent(epoch)) return;
    } catch (cause) {
      if (!operationIsCurrent(epoch)) return;
      setError(errorMessage(cause));
    } finally {
      onMutationSettled();
      if (operationIsCurrent(epoch)) setBusy(false);
    }
  };

  const removeProfile = async (id: string): Promise<void> => {
    if (busy) return;
    const epoch = ++operationEpochRef.current;
    setBusy(true);
    setError(null);
    try {
      await window.printFarmer.deleteServerProfile({ id });
      if (!operationIsCurrent(epoch)) return;
      if (editingProfile?.id === id) {
        resetForm();
        restoreEditFocusRef.current = true;
      }
    } catch (cause) {
      if (!operationIsCurrent(epoch)) return;
      setError(errorMessage(cause));
    } finally {
      onMutationSettled();
      if (operationIsCurrent(epoch)) setBusy(false);
    }
  };

  const hasActiveConnection = profiles.profiles.some(
    (profile) => profile.id === profiles.selectedProfileId,
  );
  const dialogTitle = hasActiveConnection
    ? 'Manage PrintFarmer connection'
    : 'Connect to PrintFarmer';

  return (
    <>
      <div className="profile-backdrop" aria-hidden="true" />
      <section
        ref={dialogRef}
        className="server-profiles-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-profiles-title"
      >
        <header className="profile-dialog-header">
          <div>
            <h2 id="server-profiles-title">{dialogTitle}</h2>
            <p>Credentials stay encrypted in this computer's OS vault.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            aria-label="Close server profiles"
            onClick={closeDialog}
          >
            &times;
          </button>
        </header>

        {error ? (
          <div className="profile-alert profile-error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="profile-dialog-content">
          <section aria-labelledby="saved-profiles-title">
            <h3 id="saved-profiles-title">Saved servers</h3>
            {profiles.profiles.length === 0 ? (
              <p className="profile-empty">No server profiles saved yet.</p>
            ) : (
              <ul className="profile-list">
                {profiles.profiles.map((profile) => (
                  <li
                    className={
                      profile.id === profiles.selectedProfileId
                        ? 'profile-card selected'
                        : 'profile-card'
                    }
                    key={profile.id}
                  >
                    <div className="profile-card-heading">
                      <div>
                        <strong>{profile.displayName}</strong>
                        <span>{profile.baseUrl}</span>
                      </div>
                      <span className={`profile-status ${profile.status}`}>
                        {profile.status}
                      </span>
                    </div>
                    <ProfileDetails profile={profile} />
                    <div className="profile-card-actions">
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Edit ${profile.displayName}`}
                        onClick={(event) =>
                          editProfile(profile, event.currentTarget)
                        }
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={
                          busy || profile.id === profiles.selectedProfileId
                        }
                        onClick={() => void selectProfile(profile.id)}
                      >
                        {profile.id === profiles.selectedProfileId
                          ? 'Selected'
                          : 'Select'}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void retestProfile(profile.id)}
                      >
                        Test
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        disabled={busy}
                        aria-label={`Remove ${profile.displayName}`}
                        onClick={() => void removeProfile(profile.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <form
            className="profile-form"
            aria-labelledby="add-profile-title"
            onSubmit={(event) => {
              event.preventDefault();
              if (tested) void saveDraft();
              else void testDraft();
            }}
          >
            <h3 id="add-profile-title">
              {editingProfile ? 'Edit server' : 'Add a server'}
            </h3>
            <label>
              <span>Profile name</span>
              <input
                ref={nameRef}
                disabled={busy}
                required
                maxLength={80}
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  invalidateTest();
                }}
              />
            </label>
            <label>
              <span>Server URL</span>
              <input
                required
                type="url"
                disabled={busy}
                aria-describedby={
                  insecureHttp ? 'profile-http-warning' : undefined
                }
                maxLength={2048}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  invalidateTest();
                }}
              />
            </label>
            {insecureHttp ? (
              <p
                id="profile-http-warning"
                className="profile-warning"
                role="status"
              >
                HTTP is not encrypted. Use only on a trusted LAN.
              </p>
            ) : null}
            <label>
              <span>Authentication</span>
              <select
                disabled={busy}
                value={authMode}
                onChange={(event) => {
                  setAuthMode(event.target.value as ServerAuthMode);
                  invalidateTest();
                }}
              >
                <option value="apiKey">Desktop API key</option>
                <option value="password">Username and password</option>
              </select>
            </label>
            {authMode === 'apiKey' ? (
              <label>
                <span>Desktop API key</span>
                <input
                  required={!canKeepCredentials}
                  disabled={busy}
                  aria-describedby={
                    canKeepCredentials ? 'saved-credential-hint' : undefined
                  }
                  type="password"
                  autoComplete="off"
                  maxLength={4096}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    invalidateTest();
                  }}
                />
              </label>
            ) : (
              <>
                <label>
                  <span>Username or email</span>
                  <input
                    required
                    disabled={busy}
                    autoComplete="username"
                    maxLength={256}
                    value={username}
                    onChange={(event) => {
                      setUsername(event.target.value);
                      invalidateTest();
                    }}
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    required={!canKeepCredentials}
                    disabled={busy}
                    aria-describedby={
                      canKeepCredentials ? 'saved-credential-hint' : undefined
                    }
                    type="password"
                    autoComplete="current-password"
                    maxLength={4096}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      invalidateTest();
                    }}
                  />
                </label>
              </>
            )}
            {canKeepCredentials ? (
              <p id="saved-credential-hint" className="profile-form-hint">
                Leave {authMode === 'apiKey' ? 'the API key' : 'the password'}{' '}
                blank to keep the saved credential, or enter a replacement.
              </p>
            ) : null}
            {tested ? (
              <div
                className={`profile-test-result ${tested.status}`}
                role="status"
              >
                <strong>
                  {tested.status === 'legacy'
                    ? 'Legacy server detected'
                    : 'Connection successful'}
                </strong>
                <ProfileDetails profile={tested} />
                {tested.status === 'legacy' ? (
                  <label className="legacy-confirmation">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={allowLegacy}
                      onChange={(event) => setAllowLegacy(event.target.checked)}
                    />
                    <span>
                      Save in legacy mode. Only the model-file/server-thumbnail
                      fallback is available; idempotent upload, client
                      thumbnails, and library sync remain disabled.
                    </span>
                  </label>
                ) : null}
              </div>
            ) : null}
            <div className="profile-form-actions">
              <button
                type="submit"
                disabled={busy || (tested?.status === 'legacy' && !allowLegacy)}
              >
                {busy
                  ? 'Checking...'
                  : tested
                    ? editingProfile
                      ? 'Save changes'
                      : 'Save profile'
                    : 'Test connection'}
              </button>
              {tested ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void testDraft()}
                >
                  Test again
                </button>
              ) : null}
              {editingProfile ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    resetForm();
                    editTriggerRef.current?.focus();
                  }}
                >
                  Cancel editing
                </button>
              ) : null}
            </div>
          </form>
        </div>
      </section>
    </>
  );
}

function sameEndpoint(left: string, right: string): boolean {
  try {
    return (
      new URL(left.trim()).href.replace(/\/+$/, '') ===
      new URL(right).href.replace(/\/+$/, '')
    );
  } catch {
    return false;
  }
}

function ProfileDetails({
  profile,
}: {
  profile: ServerProfile;
}): React.JSX.Element {
  return (
    <div className="profile-details">
      <span>
        {profile.version
          ? `${profile.version.service} ${profile.version.version}`
          : 'Server version unavailable'}
      </span>
      <span>
        {profile.capabilities
          ? `${profile.capabilities.architecture} capabilities`
          : 'Capabilities unavailable'}
      </span>
      {profile.warnings.includes('insecureHttp') ? (
        <span className="profile-warning">
          HTTP transport is not encrypted. Use only on a trusted LAN.
        </span>
      ) : null}
      {profile.warnings.includes('legacy') ? (
        <span className="profile-warning">
          Legacy mode: model-only upload uses server thumbnails where available.
          Modern idempotent upload, client thumbnails, and sync are disabled.
        </span>
      ) : null}
    </div>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The operation failed.';
}
