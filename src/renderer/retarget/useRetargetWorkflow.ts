import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RetargetBuildResponse,
  RetargetImportProfileResponse,
  RetargetListProfilesResponse,
  RetargetPreflightResponse,
  RetargetProfile,
  RetargetSaveAsResponse,
} from '@shared/ipc';

export type RetargetPhase =
  | 'loading'
  | 'ready'
  | 'blocked'
  | 'building'
  | 'review'
  | 'saving'
  | 'saved'
  | 'error';
export interface RetargetTarget {
  modelHash: string;
  rootId: string;
  name: string;
}

export function useRetargetWorkflow(
  target: RetargetTarget,
  onClose: () => void,
) {
  const [phase, setPhase] = useState<RetargetPhase>('loading');
  const [profiles, setProfiles] = useState<RetargetProfile[]>([]);
  const [profileWarnings, setProfileWarnings] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [report, setReport] = useState<
    RetargetPreflightResponse | RetargetBuildResponse | null
  >(null);
  const [objectExclusion, setObjectExclusion] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const epoch = useRef(0);
  const tokenRef = useRef<string | null>(null);
  const dispose = useCallback((value: string | null) => {
    if (value) void window.printFarmer.disposeRetarget({ token: value });
  }, []);
  useEffect(
    () => () => {
      epoch.current += 1;
      dispose(tokenRef.current);
    },
    [dispose],
  );
  const loadProfiles = useCallback(async () => {
    const request = ++epoch.current;
    setMessage(null);
    setPhase('loading');
    try {
      const response = await window.printFarmer.listRetargetProfiles();
      if (request !== epoch.current) return;
      if (response.status === 'ok') {
        setProfiles(response.value.profiles);
        setProfileWarnings(
          response.value.warnings.map((warning) => warning.message),
        );
        setPhase('ready');
      } else {
        setMessage(
          response.status === 'error'
            ? response.error.message
            : 'Profiles are unavailable.',
        );
        setPhase('error');
      }
    } catch {
      if (request === epoch.current) {
        setMessage('Profiles are unavailable.');
        setPhase('error');
      }
    }
  }, []);
  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);
  const preflight = useCallback(
    async (profileId: string, exclusion = objectExclusion) => {
      const request = ++epoch.current;
      dispose(tokenRef.current);
      tokenRef.current = null;
      setToken(null);
      setPhase('loading');
      let response: RetargetPreflightResponse;
      try {
        response = await window.printFarmer.preflightRetarget({
          modelHash: target.modelHash,
          rootId: target.rootId,
          profileId,
          objectExclusion: exclusion,
        });
      } catch {
        if (request === epoch.current) {
          setMessage('Preflight could not be completed.');
          setPhase('error');
        }
        return;
      }
      if (request !== epoch.current) {
        if (response.status !== 'error' && response.value?.token)
          dispose(response.value.token);
        return;
      }
      setReport(response);
      if (
        response.status === 'ok' ||
        (response.status === 'blocked' && response.value)
      ) {
        const next = response.value!.token;
        tokenRef.current = next;
        setToken(next);
        setPhase(response.status === 'blocked' ? 'blocked' : 'ready');
      } else {
        setMessage(
          response.status === 'error'
            ? response.error.message
            : 'Preflight failed.',
        );
        setPhase('error');
      }
    },
    [dispose, objectExclusion, target],
  );
  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      void preflight(id);
    },
    [preflight],
  );
  const setExclusion = useCallback(
    (value: boolean) => {
      setObjectExclusion(value);
      if (selectedId) void preflight(selectedId, value);
    },
    [preflight, selectedId],
  );
  const build = useCallback(async () => {
    if (!token || !selectedId) return;
    const request = ++epoch.current;
    setPhase('building');
    let response: RetargetBuildResponse;
    try {
      response = await window.printFarmer.buildRetarget({
        token,
        profileId: selectedId,
        objectExclusion,
      });
    } catch {
      if (request === epoch.current) {
        setMessage('The review copy could not be built.');
        setPhase('error');
      }
      return;
    }
    if (request !== epoch.current) return;
    setReport(response);
    if (response.status === 'ok') setPhase('review');
    else {
      setMessage(
        response.status === 'error'
          ? response.error.message
          : 'Build was blocked.',
      );
      setPhase(response.status === 'blocked' ? 'blocked' : 'error');
    }
  }, [objectExclusion, selectedId, token]);
  const save = useCallback(async () => {
    if (!token) return;
    const request = ++epoch.current;
    setPhase('saving');
    let response: RetargetSaveAsResponse;
    try {
      response = await window.printFarmer.saveRetargetAs({ token });
    } catch {
      if (request === epoch.current) {
        setMessage('The project could not be saved.');
        setPhase('review');
      }
      return;
    }
    if (request !== epoch.current || response.status === 'canceled') {
      if (request === epoch.current) setPhase('review');
      return;
    }
    if (response.status === 'ok') {
      tokenRef.current = null;
      setToken(null);
      setMessage(
        `Saved ${response.fileName}${
          response.refreshWarning ? ` ${response.refreshWarning.message}` : ''
        }`,
      );
      setPhase('saved');
    } else {
      setMessage(response.error.message);
      setPhase('review');
    }
  }, [token]);
  const importProfile = useCallback(async () => {
    const request = ++epoch.current;
    setMessage(null);
    let response: RetargetImportProfileResponse;
    try {
      response = await window.printFarmer.importRetargetProfile();
    } catch {
      if (request === epoch.current)
        setMessage('The U1 reference could not be imported.');
      return;
    }
    if (request !== epoch.current || response.status === 'canceled') return;
    if (response.status === 'error') {
      setMessage(response.error.message);
      return;
    }
    let listed: RetargetListProfilesResponse;
    try {
      listed = await window.printFarmer.listRetargetProfiles();
    } catch {
      if (request === epoch.current)
        setMessage('The U1 profile catalog could not be refreshed.');
      return;
    }
    if (request !== epoch.current) return;
    if (listed.status === 'ok') {
      setProfiles(listed.value.profiles);
      setProfileWarnings(
        listed.value.warnings.map((warning) => warning.message),
      );
      setSelectedId(response.profile.id);
      void preflight(response.profile.id);
    } else {
      setMessage(
        listed.status === 'error'
          ? listed.error.message
          : 'The U1 profile catalog could not be refreshed.',
      );
    }
  }, [preflight]);
  const retry = useCallback(() => {
    if (selectedId) {
      void preflight(selectedId);
    } else {
      void loadProfiles();
    }
  }, [loadProfiles, preflight, selectedId]);
  return {
    phase,
    profiles,
    profileWarnings,
    selectedId,
    report,
    objectExclusion,
    message,
    select,
    setExclusion,
    build,
    save,
    importProfile,
    retry,
    close: onClose,
    token,
  };
}
