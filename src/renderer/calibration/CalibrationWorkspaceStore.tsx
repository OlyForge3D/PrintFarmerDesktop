import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  CalibrationWorkspacePayload as CalibrationWorkspacePayloadSchema,
  deriveCalibrationWorkspaceProjection,
  type CalibrationAvailability,
  type CalibrationPrinterContext,
  type CalibrationPrintObservation,
  type CalibrationSaveWorkspaceStateRequest,
  type CalibrationUnhydratedProject,
  type CalibrationWorkspacePayload,
  type CalibrationWorkspaceStateRecord,
  type LocalOrcaProfileSummary,
  type OrcaProfileEntry,
} from '@shared/ipc';
import { browserCalibrationEnvironment, calibrationApi } from './api';
import {
  calibrationReducer,
  type CalibrationEvent,
  type CalibrationStageId,
} from './domain';
import { parseWorkspaceRecordDomain } from './parseDomainState';
import {
  profileMatchesProject,
  selectedBaseProfileFromEntry,
} from './projectEligibility';
import type {
  CalibrationWorkspaceProps,
  CalibrationWorkspaceStoreValue,
  CalibrationWorkspaceView,
  CreationDataState,
  GeneratedProfileState,
  MetadataDraft,
  NewProjectInput,
  OpenCalibrationProject,
  WorkspacePhoto,
  WorkspaceStepDraft,
  WorkspaceWorkflowDraft,
} from './workspaceTypes';
import { emptyWorkflowDrafts, errorMessage } from './workspaceTypes';

const emptyCreation: CreationDataState = {
  printers: [],
  printersTruncated: false,
  printersUnreadable: 0,
  candidateDiagnostic: null,
  selectedPrinterId: null,
  profiles: [],
  context: null,
  profileDiagnostic: null,
  localDiagnostic: null,
  localProfiles: [],
  loaded: false,
  loading: false,
  contextLoading: false,
  listError: null,
  error: null,
};

/**
 * Everything derived from a printer selection, cleared as one unit.
 *
 * Kept as a single constant so a new selection cannot leave one field behind
 * from the previous printer. A partially cleared state is how a value for
 * printer A ends up displayed beside a value for printer B.
 */
const clearedSelection = {
  profiles: [] as readonly OrcaProfileEntry[],
  context: null,
  profileDiagnostic: null,
  localDiagnostic: null,
  localProfiles: [] as readonly LocalOrcaProfileSummary[],
  error: null,
} satisfies Partial<CreationDataState>;
const emptyMetadataDraft: MetadataDraft = { displayName: '', description: '' };
const StoreContext = createContext<CalibrationWorkspaceStoreValue | null>(null);

function workspaceProjection(
  payload: CalibrationWorkspacePayload,
): ReturnType<typeof deriveCalibrationWorkspaceProjection> {
  return deriveCalibrationWorkspaceProjection(payload.domainState);
}

function payloadFor(
  project: OpenCalibrationProject,
): CalibrationWorkspacePayload {
  return CalibrationWorkspacePayloadSchema.parse({
    ...project.record.workspaceState,
    domainState: project.domainState,
  });
}

function replacePayload(
  project: OpenCalibrationProject,
  payload: CalibrationWorkspacePayload,
  updatedAt = project.record.updatedAt,
): OpenCalibrationProject {
  const projection = workspaceProjection(payload);
  return {
    domainState: project.domainState,
    record: {
      ...project.record,
      displayName: payload.metadata.displayName,
      description: payload.metadata.description,
      status: projection.status,
      completedStepCount: projection.completedStepCount,
      totalStepCount: projection.totalStepCount,
      isSynced: false,
      updatedAt,
      workspaceState: payload,
    },
  };
}

function prepareAutosave(
  project: OpenCalibrationProject,
  timestamp: string,
): OpenCalibrationProject {
  const payload: CalibrationWorkspacePayload = {
    ...payloadFor(project),
    autosaveRevision: project.record.workspaceState.autosaveRevision + 1,
  };
  return replacePayload(project, payload, timestamp);
}

function withDomainState(
  project: OpenCalibrationProject,
  domainState: OpenCalibrationProject['domainState'],
): OpenCalibrationProject {
  const workspaceState = CalibrationWorkspacePayloadSchema.parse({
    ...project.record.workspaceState,
    domainState,
  });
  return replacePayload(
    { domainState, record: { ...project.record, workspaceState } },
    workspaceState,
  );
}

function saveRequest(
  profileId: string,
  project: OpenCalibrationProject,
  operationId: string,
): CalibrationSaveWorkspaceStateRequest {
  const workspaceState = payloadFor(project);
  const projection = workspaceProjection(workspaceState);
  return {
    profileId,
    projectId: project.record.projectId,
    displayName: workspaceState.metadata.displayName,
    description: workspaceState.metadata.description,
    printerId: project.record.printerId,
    status: projection.status,
    completedStepCount: projection.completedStepCount,
    totalStepCount: projection.totalStepCount,
    baseRevision: project.record.baseRevision,
    operationId,
    workspaceState,
    createdAt: project.record.createdAt,
    updatedAt: project.record.updatedAt,
  };
}

function replaceRecord(
  records: readonly CalibrationWorkspaceStateRecord[],
  record: CalibrationWorkspaceStateRecord,
): CalibrationWorkspaceStateRecord[] {
  const exists = records.some((item) => item.projectId === record.projectId);
  const next = records.map((item) =>
    item.projectId === record.projectId ? record : item,
  );
  if (!exists) next.unshift(record);
  return next.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

interface StoreProviderProps extends CalibrationWorkspaceProps {
  readonly children: ReactNode;
}

export function CalibrationWorkspaceStoreProvider({
  selectedProfileId,
  selectedProfileName,
  selectedServerDisplayName,
  disabled = false,
  onManageProfiles,
  onManageServerProfiles,
  onReportError,
  onFlushReady,
  environment = browserCalibrationEnvironment,
  children,
}: StoreProviderProps): React.JSX.Element {
  const profileName = selectedProfileName ?? selectedServerDisplayName ?? '';
  const manageProfilesOwner = onManageProfiles ?? onManageServerProfiles;
  const [view, setView] = useState<CalibrationWorkspaceView>('dashboard');
  const [selectedStageId, setSelectedStageId] =
    useState<CalibrationStageId>('temperature');
  const [availability, setAvailability] =
    useState<CalibrationAvailability | null>(null);
  const [records, setRecords] = useState<CalibrationWorkspaceStateRecord[]>([]);
  const [unhydratedProjects, setUnhydratedProjects] = useState<
    CalibrationUnhydratedProject[]
  >([]);
  const [recoveryByProject, setRecoveryByProject] = useState<
    Readonly<Record<string, string>>
  >({});
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeProject, setActiveProjectState] =
    useState<OpenCalibrationProject | null>(null);
  const activeProjectRef = useRef<OpenCalibrationProject | null>(null);
  const [metadataDraft, setMetadataDraft] =
    useState<MetadataDraft>(emptyMetadataDraft);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [creation, setCreation] = useState<CreationDataState>(emptyCreation);
  // Kept in sync from an effect rather than assigned during render: React may
  // render speculatively and discard the result, and a ref written on a
  // discarded render would hold a value the committed tree never had.
  const creationRef = useRef<CreationDataState>(emptyCreation);
  useEffect(() => {
    creationRef.current = creation;
  }, [creation]);
  const [orcaProfiles, setOrcaProfiles] = useState<readonly OrcaProfileEntry[]>(
    [],
  );
  const orcaProfilesRef = useRef<readonly OrcaProfileEntry[]>([]);
  orcaProfilesRef.current = orcaProfiles;
  const [liveMessage, setLiveMessage] = useState('');
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [generatedProfile, setGeneratedProfile] =
    useState<GeneratedProfileState | null>(null);

  const requestEpochRef = useRef(0);
  const creationRequestEpochRef = useRef(0);
  /**
   * One generation counter for every selection-scoped fetch.
   *
   * `selectPrinter` and the open project's context refresh both write
   * `orcaProfiles`, so separate counters let each ignore only its own stale
   * replies and happily overwrite the other's fresh ones. Sharing the counter
   * makes any newer selection-scoped request invalidate every older one,
   * whichever path started it.
   */
  const contextRequestEpochRef = useRef(0);
  const projectRequestEpochRef = useRef(0);
  /**
   * Set when the provider unmounts. Every in-flight continuation checks it, so
   * a reply that lands after teardown updates nothing.
   */
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      // Invalidate everything in flight so late replies are discarded rather
      // than applied to a store nobody is reading.
      contextRequestEpochRef.current += 1;
      creationRequestEpochRef.current += 1;
    };
  }, []);
  const profileIdRef = useRef(selectedProfileId);
  profileIdRef.current = selectedProfileId;
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveFailureRef = useRef<Error | null>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const debouncedSavePendingRef = useRef(false);

  const setActiveProject = useCallback(
    (project: OpenCalibrationProject | null): void => {
      activeProjectRef.current = project;
      setActiveProjectState(project);
    },
    [],
  );

  const hydrateActiveProject = useCallback(
    (project: OpenCalibrationProject | null): void => {
      setActiveProject(project);
      setMetadataDraft(
        project === null
          ? emptyMetadataDraft
          : {
              displayName: project.record.workspaceState.metadata.displayName,
              description: project.record.workspaceState.metadata.description,
            },
      );
      setMetadataError(null);
    },
    [setActiveProject],
  );

  const announce = useCallback(
    (message: string): void => setLiveMessage(message),
    [],
  );
  const reportError = useCallback(
    (message: string): void => {
      setAlertMessage(message);
      setLiveMessage(message);
      onReportError?.(message);
    },
    [onReportError],
  );

  const inspectRecords = useCallback(
    (nextRecords: readonly CalibrationWorkspaceStateRecord[]): void => {
      const recovery: Record<string, string> = {};
      for (const record of nextRecords) {
        const parsed = parseWorkspaceRecordDomain(record);
        if (!parsed.ok) recovery[record.projectId] = parsed.message;
      }
      setRecoveryByProject(recovery);
    },
    [],
  );

  const updateOptimisticRecord = useCallback(
    (project: OpenCalibrationProject): void => {
      setRecords((current) => replaceRecord(current, project.record));
      setRecoveryByProject((current) => {
        if (!(project.record.projectId in current)) return current;
        const next = { ...current };
        delete next[project.record.projectId];
        return next;
      });
    },
    [],
  );

  const mergeSaveResponse = useCallback(
    (
      savedProject: OpenCalibrationProject,
      responseRecord: CalibrationWorkspaceStateRecord,
    ): void => {
      const current = activeProjectRef.current;
      const currentIsNewer =
        current?.record.projectId === savedProject.record.projectId &&
        (current !== savedProject ||
          current.record.workspaceState.autosaveRevision >
            savedProject.record.workspaceState.autosaveRevision);
      if (currentIsNewer && current) {
        const mergedRecord: CalibrationWorkspaceStateRecord = {
          ...current.record,
          baseRevision: responseRecord.baseRevision,
          isPrinterContextFresh: responseRecord.isPrinterContextFresh,
          hasConflicts: responseRecord.hasConflicts,
          remoteProjectId: responseRecord.remoteProjectId,
        };
        setActiveProject({ ...current, record: mergedRecord });
        setRecords((items) => replaceRecord(items, mergedRecord));
        return;
      }
      setRecords((items) => replaceRecord(items, responseRecord));
      if (current?.record.projectId !== responseRecord.projectId) return;
      const parsed = parseWorkspaceRecordDomain(responseRecord);
      if (!parsed.ok) {
        reportError(parsed.message);
        return;
      }
      setActiveProject({ record: responseRecord, domainState: parsed.state });
    },
    [reportError, setActiveProject],
  );

  const enqueueSave = useCallback(
    (project: OpenCalibrationProject, operationId: string): Promise<void> => {
      const profileId = profileIdRef.current;
      if (profileId === null) return Promise.resolve();
      const request = saveRequest(profileId, project, operationId);
      const task = saveQueueRef.current.then(async () => {
        try {
          const response =
            await calibrationApi().saveCalibrationWorkspaceState(request);
          if (profileIdRef.current !== request.profileId) return;
          if (
            response.state.profileId !== request.profileId ||
            response.state.projectId !== request.projectId ||
            response.state.printerId !== request.printerId
          ) {
            throw new Error(
              'Saved calibration response did not match the requested profile, project, and printer identity.',
            );
          }
          saveFailureRef.current = null;
          mergeSaveResponse(project, response.state);
          setLiveMessage('Saved locally; synchronization is queued.');
        } catch (cause) {
          if (profileIdRef.current !== request.profileId) return;
          const failure = new Error(
            errorMessage(
              cause,
              'Calibration changes could not be saved to the local queue.',
            ),
          );
          saveFailureRef.current = failure;
          reportError(failure.message);
        }
      });
      saveQueueRef.current = task;
      return task;
    },
    [mergeSaveResponse, reportError],
  );

  const bumpAndSave = useCallback(
    (
      project: OpenCalibrationProject,
      timestamp: string,
      message: string,
    ): Promise<void> => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      debouncedSavePendingRef.current = false;
      const next = prepareAutosave(project, timestamp);
      setActiveProject(next);
      updateOptimisticRecord(next);
      setAlertMessage(null);
      setLiveMessage(message);
      return enqueueSave(next, environment.createId());
    },
    [enqueueSave, environment, setActiveProject, updateOptimisticRecord],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (debouncedSavePendingRef.current) {
      debouncedSavePendingRef.current = false;
      const project = activeProjectRef.current;
      if (project !== null) {
        await bumpAndSave(
          project,
          environment.now(),
          'Saving edited fields locally.',
        );
      }
    }
    await saveQueueRef.current;
    if (saveFailureRef.current !== null) throw saveFailureRef.current;
  }, [bumpAndSave, environment]);

  const scheduleDebouncedSave = useCallback((): void => {
    debouncedSavePendingRef.current = true;
    if (debounceTimerRef.current !== null)
      window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = window.setTimeout(() => {
      void flush().catch(() => undefined);
    }, 500);
    setLiveMessage('Edited fields will save locally shortly.');
  }, [flush]);

  useEffect(() => {
    onFlushReady?.(flush);
    return () => onFlushReady?.(null);
  }, [flush, onFlushReady]);

  useEffect(
    () => () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const epoch = ++requestEpochRef.current;
    setAlertMessage(null);
    setError(null);
    if (selectedProfileId === null) {
      setAvailability(null);
      setRecords([]);
      setUnhydratedProjects([]);
      setRecoveryByProject({});
      setOffline(false);
      setLoading(false);
      setLiveMessage(
        'Select a PrintFarmer profile to use Printer Calibration.',
      );
      return;
    }
    const profileId = selectedProfileId;
    setLoading(true);
    const [availabilityResult, recordsResult] = await Promise.allSettled([
      calibrationApi().getCalibrationAvailability(),
      calibrationApi().listCalibrationWorkspaceStates({ profileId }),
    ]);
    if (requestEpochRef.current !== epoch || profileIdRef.current !== profileId)
      return;

    if (availabilityResult.status === 'fulfilled') {
      setAvailability(availabilityResult.value);
      setOffline(false);
    } else {
      setAvailability(null);
      setOffline(true);
    }

    if (recordsResult.status === 'fulfilled') {
      const nextRecords = [...recordsResult.value.states].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      setRecords(nextRecords);
      setUnhydratedProjects(recordsResult.value.unhydratedProjects);
      inspectRecords(nextRecords);
      const currentProject = activeProjectRef.current;
      const refreshedActive = currentProject
        ? nextRecords.find(
            (record) => record.projectId === currentProject.record.projectId,
          )
        : undefined;
      if (
        refreshedActive &&
        !debouncedSavePendingRef.current &&
        refreshedActive.workspaceState.autosaveRevision >=
          (currentProject?.record.workspaceState.autosaveRevision ?? 0)
      ) {
        const parsed = parseWorkspaceRecordDomain(refreshedActive);
        if (parsed.ok)
          setActiveProject({
            record: refreshedActive,
            domainState: parsed.state,
          });
      }
      const total =
        nextRecords.length + recordsResult.value.unhydratedProjects.length;
      setLiveMessage(
        availabilityResult.status === 'rejected'
          ? `Offline. ${total} locally known calibration project${total === 1 ? '' : 's'} loaded.`
          : `Calibration workspace loaded. ${total} project${total === 1 ? '' : 's'} available.`,
      );
    } else {
      const message = errorMessage(
        recordsResult.reason,
        'Saved calibration projects could not be loaded.',
      );
      setRecords([]);
      setUnhydratedProjects([]);
      setRecoveryByProject({});
      setError(message);
      reportError(message);
    }
    setLoading(false);
  }, [inspectRecords, reportError, selectedProfileId, setActiveProject]);

  useEffect(() => {
    creationRequestEpochRef.current += 1;
    contextRequestEpochRef.current += 1;
    projectRequestEpochRef.current += 1;
    contextRequestEpochRef.current += 1;
    setView('dashboard');
    setSelectedStageId('temperature');
    hydrateActiveProject(null);
    setCreation(emptyCreation);
    setOrcaProfiles([]);
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    debouncedSavePendingRef.current = false;
    saveFailureRef.current = null;
    void refresh();
  }, [hydrateActiveProject, refresh, selectedProfileId]);

  const navigate = useCallback(
    async (nextView: CalibrationWorkspaceView): Promise<void> => {
      if (
        !['dashboard', 'newProject'].includes(nextView) &&
        activeProjectRef.current === null
      ) {
        setView('dashboard');
        reportError('Open a valid calibration project before using that view.');
        return;
      }
      try {
        await flush();
        setView(nextView);
      } catch (cause) {
        reportError(
          errorMessage(cause, 'Save pending changes before leaving this view.'),
        );
      }
    },
    [flush, reportError],
  );

  const openProject = useCallback(
    async (projectId: string): Promise<void> => {
      if (selectedProfileId === null) return;
      try {
        await flush();
      } catch (cause) {
        reportError(
          errorMessage(cause, 'Save pending changes before opening a project.'),
        );
        return;
      }
      const profileId = selectedProfileId;
      const epoch = ++projectRequestEpochRef.current;
      setAlertMessage(null);
      setLiveMessage('Loading exact saved calibration state.');
      try {
        const record = await calibrationApi().getCalibrationWorkspaceState({
          profileId,
          projectId,
        });
        if (
          profileIdRef.current !== profileId ||
          projectRequestEpochRef.current !== epoch
        )
          return;
        if (record === null) {
          reportError(
            'This calibration project is no longer available locally.',
          );
          return;
        }
        const parsed = parseWorkspaceRecordDomain(record);
        if (!parsed.ok) {
          hydrateActiveProject(null);
          setRecoveryByProject((current) => ({
            ...current,
            [projectId]: parsed.message,
          }));
          setView('overview');
          reportError(parsed.message);
          return;
        }
        hydrateActiveProject({ record, domainState: parsed.state });
        setRecords((current) => replaceRecord(current, record));
        setSelectedStageId(parsed.state.currentStageId);
        setView('overview');
        setLiveMessage(
          `${record.displayName} resumed from its exact saved state.`,
        );
      } catch (cause) {
        if (
          profileIdRef.current !== profileId ||
          projectRequestEpochRef.current !== epoch
        )
          return;
        reportError(
          errorMessage(cause, 'The calibration project could not be loaded.'),
        );
      }
    },
    [flush, hydrateActiveProject, reportError, selectedProfileId],
  );

  const dispatchEvent = useCallback(
    async (event: CalibrationEvent): Promise<boolean> => {
      const project = activeProjectRef.current;
      if (project === null) return false;
      const domainState = calibrationReducer(project.domainState, event);
      const accepted = domainState.history.some(
        (recordedEvent) => recordedEvent.eventId === event.eventId,
      );
      let nextProject: OpenCalibrationProject;
      if (event.type === 'rebaseSnapshot' && accepted) {
        const persistedProfile =
          project.record.workspaceState.selectedBaseProfile;
        const discoveredProfile = orcaProfilesRef.current.find(
          (profile) =>
            profile.displayName === persistedProfile.displayName &&
            profileMatchesProject(profile, event.binding, persistedProfile),
        );
        const selectedBaseProfile = discoveredProfile
          ? selectedBaseProfileFromEntry(discoveredProfile)
          : null;
        if (selectedBaseProfile === null) {
          reportError(
            'Rebase was blocked because PrintFarmer discovery did not return the same immutable OrcaSlicer profile revision and hash for the refreshed physical scope. Create a new project.',
          );
          return false;
        }
        const workspaceState = CalibrationWorkspacePayloadSchema.parse({
          ...project.record.workspaceState,
          domainState,
          physicalMatch: null,
          selectedBaseProfile,
          selectedBaseProfileId: selectedBaseProfile.orcaProfileId,
        });
        nextProject = replacePayload(
          { domainState, record: { ...project.record, workspaceState } },
          workspaceState,
        );
      } else {
        nextProject = withDomainState(project, domainState);
      }
      await bumpAndSave(
        nextProject,
        event.timestamp,
        'Saving workflow change locally.',
      );
      if (!accepted) {
        const diagnostic = domainState.diagnostics
          .slice(project.domainState.diagnostics.length)
          .find((item) => item.severity === 'error');
        reportError(
          diagnostic?.message ?? 'The workflow transition was rejected.',
        );
      }
      return accepted;
    },
    [bumpAndSave, reportError],
  );

  const openStage = useCallback(
    async (stageId: CalibrationStageId): Promise<void> => {
      const project = activeProjectRef.current;
      const needsNavigationEvent =
        project !== null &&
        (project.domainState.currentStageId !== stageId ||
          (project.domainState.attempts.length === 0 &&
            project.domainState.history.length === 0));
      if (needsNavigationEvent) {
        const accepted = await dispatchEvent({
          eventId: environment.createId(),
          timestamp: environment.now(),
          type: 'navigate',
          stageId,
        });
        if (!accepted) return;
        try {
          await flush();
        } catch (cause) {
          reportError(
            errorMessage(cause, 'Save the selected stage before opening it.'),
          );
          return;
        }
      } else {
        try {
          await flush();
        } catch (cause) {
          reportError(
            errorMessage(cause, 'Save pending changes before opening a stage.'),
          );
          return;
        }
      }
      setSelectedStageId(stageId);
      setView('step');
    },
    [dispatchEvent, environment, flush, reportError],
  );

  const manageProfiles = useCallback(async (): Promise<void> => {
    try {
      await flush();
      manageProfilesOwner?.();
    } catch (cause) {
      reportError(
        errorMessage(cause, 'Save pending changes before managing profiles.'),
      );
    }
  }, [flush, manageProfilesOwner, reportError]);

  /**
   * Load the printer candidate list, and nothing else.
   *
   * This is the wizard's first and only pre-selection fetch. It deliberately
   * does not touch printer context, generated profile history, the server base
   * profile catalogue or the local OrcaSlicer install: none of those can be
   * scoped to a printer before the operator has named one, and fetching them
   * anyway is what made the wizard resolve profiles for the whole farm.
   */
  const loadCreationData = useCallback(async (): Promise<void> => {
    if (selectedProfileId === null) return;
    const profileId = selectedProfileId;
    const epoch = ++creationRequestEpochRef.current;
    // A reload invalidates any selection-scoped work already in flight.
    contextRequestEpochRef.current += 1;
    setCreation((current) => ({
      ...current,
      ...clearedSelection,
      selectedPrinterId: null,
      loading: true,
      contextLoading: false,
      listError: null,
    }));
    setLiveMessage('Loading PrintFarmer printers.');
    try {
      const printerResponse = await calibrationApi().listCalibrationPrinters({
        profileId,
      });
      if (
        profileIdRef.current !== profileId ||
        creationRequestEpochRef.current !== epoch
      )
        return;
      setCreation((current) => ({
        ...current,
        ...clearedSelection,
        printers: printerResponse.printers,
        printersTruncated: printerResponse.printersTruncated,
        printersUnreadable: printerResponse.printersUnreadable,
        candidateDiagnostic: null,
        selectedPrinterId: null,
        loaded: true,
        loading: false,
        contextLoading: false,
        listError: null,
      }));
      const count = printerResponse.printers.length;
      const unreadable = printerResponse.printersUnreadable;
      const partial: string[] = [];
      if (printerResponse.printersTruncated) {
        partial.push('the server offered more than this view can show');
      }
      if (unreadable > 0) {
        partial.push(
          `${unreadable} record${unreadable === 1 ? '' : 's'} could not be read`,
        );
      }
      setLiveMessage(
        partial.length > 0
          ? `Showing ${count} PrintFarmer printer candidate${count === 1 ? '' : 's'}. The list is partial: ${partial.join(', and ')}. Select one to calibrate.`
          : count === 0
            ? 'No PrintFarmer printers are available to calibrate.'
            : `${count} PrintFarmer printer${count === 1 ? '' : 's'} available. Select one to calibrate.`,
      );
    } catch (cause) {
      if (
        profileIdRef.current !== profileId ||
        creationRequestEpochRef.current !== epoch
      )
        return;
      const message = errorMessage(
        cause,
        'PrintFarmer printers could not be loaded.',
      );
      setCreation((current) => ({
        ...current,
        loaded: true,
        loading: false,
        listError: message,
      }));
      reportError(message);
    }
  }, [reportError, selectedProfileId]);

  /**
   * Select one printer and resolve only that printer's context and profiles.
   *
   * Every response is fenced twice — on the request epoch and on the printer the
   * response is actually about — so a slow reply for a previously selected
   * printer can neither overwrite the current one nor resurrect a selection the
   * operator has already moved off. The context is fetched first because its
   * configuration revision is what the profile request is then pinned to; that
   * shared revision is what keeps selection fencing and action fencing in
   * agreement.
   */
  const selectPrinter = useCallback(
    async (printerId: string | null): Promise<void> => {
      if (selectedProfileId === null) return;
      const profileId = selectedProfileId;
      // Bumping first cancels whatever the previous selection had in flight:
      // those responses will fail their epoch check and be discarded.
      const epoch = ++contextRequestEpochRef.current;
      setCreation((current) => ({
        ...current,
        ...clearedSelection,
        selectedPrinterId: printerId,
        contextLoading: printerId !== null,
      }));
      if (printerId === null) {
        setLiveMessage('Printer selection cleared.');
        return;
      }
      const candidate = creationRef.current.printers.find(
        (entry) => entry.printerId === printerId,
      );
      setLiveMessage(
        `Loading calibration context for ${candidate?.displayName ?? 'the selected printer'}.`,
      );
      const stale = (): boolean =>
        unmountedRef.current ||
        profileIdRef.current !== profileId ||
        contextRequestEpochRef.current !== epoch;
      try {
        const context = await calibrationApi().getCalibrationPrinterContext({
          profileId,
          printerId,
        });
        if (stale()) return;
        // A context that names a different printer than the one requested is a
        // contract violation, not a race. Adopting it would bind the wizard to
        // a machine the operator never chose.
        if (context.printerId !== printerId) {
          setCreation((current) =>
            current.selectedPrinterId === printerId
              ? {
                  ...current,
                  contextLoading: false,
                  error:
                    'PrintFarmer returned a context for a different printer. Select the printer again.',
                }
              : current,
          );
          return;
        }
        setCreation((current) =>
          current.selectedPrinterId === printerId
            ? { ...current, context }
            : current,
        );
        // A new selection without a configuration revision or snapshot cannot be
        // bound: those two identify *which* configuration a calibration project
        // is pinned to, and a project bound to "whatever was current" is not
        // pinned to anything. Treated as unbindable rather than null-permissive,
        // so the wizard refuses here instead of producing a project that cannot
        // be verified later.
        if (
          context.configurationRevision === null ||
          context.snapshotId === null
        ) {
          setCreation((current) =>
            current.selectedPrinterId === printerId
              ? {
                  ...current,
                  contextLoading: false,
                  error:
                    'PrintFarmer did not report a configuration revision and snapshot for this printer, so a calibration project cannot be bound to it. Refresh the printer in PrintFarmer and try again.',
                }
              : current,
          );
          return;
        }
        const profileResponse = await calibrationApi().listOrcaProfiles({
          profileId,
          printerId,
          configurationRevision: context.configurationRevision,
        });
        if (stale()) return;
        // Fenced on printer *and* revision: a reply resolved against a revision
        // other than the one just loaded describes a configuration the operator
        // has not seen.
        if (
          profileResponse.printerId !== printerId ||
          (profileResponse.configurationRevision !== null &&
            profileResponse.configurationRevision !==
              context.configurationRevision)
        ) {
          return;
        }
        setOrcaProfiles(profileResponse.profiles);
        setCreation((current) =>
          current.selectedPrinterId === printerId
            ? {
                ...current,
                profiles: profileResponse.profiles,
                profileDiagnostic: profileResponse.discovery,
                localDiagnostic: profileResponse.localDiscovery,
                localProfiles: profileResponse.localProfiles,
                contextLoading: false,
              }
            : current,
        );
        setLiveMessage(
          profileResponse.profiles.length === 0
            ? `No calibration profile could be resolved for ${context.displayName}.`
            : `${profileResponse.profiles.length} profile${profileResponse.profiles.length === 1 ? '' : 's'} resolved for ${context.displayName}.`,
        );
      } catch (cause) {
        if (stale()) return;
        const message = errorMessage(
          cause,
          'The selected printer could not be loaded.',
        );
        // Scoped to the selection only. `printers` and `listError` are left
        // untouched so a per-printer failure can never read as "there are no
        // printers" and erase the list the operator is choosing from.
        setCreation((current) =>
          current.selectedPrinterId === printerId
            ? { ...current, contextLoading: false, error: message }
            : current,
        );
        reportError(message);
      }
    },
    [reportError, selectedProfileId],
  );

  /**
   * Resolve OrcaSlicer profiles for the open project's own printer.
   *
   * The profile-patch view needs them, and before printer-first they arrived
   * incidentally from a farm-wide load that ran on mount. That load is gone, so
   * this replaces it with the scoped equivalent: the project already knows which
   * printer and configuration revision it is bound to, so no context fetch is
   * needed to ask the right question.
   */
  const loadProjectProfiles = useCallback(async (): Promise<void> => {
    const project = activeProjectRef.current;
    if (selectedProfileId === null || project === null) return;
    const profileId = selectedProfileId;
    const printerId = project.record.printerId;
    const projectId = project.record.projectId;
    const configurationRevision =
      project.domainState.binding.printer.printerConfigurationRevision;
    const epoch = ++contextRequestEpochRef.current;
    try {
      const response = await calibrationApi().listOrcaProfiles({
        profileId,
        printerId,
        configurationRevision,
      });
      if (
        unmountedRef.current ||
        profileIdRef.current !== profileId ||
        contextRequestEpochRef.current !== epoch ||
        activeProjectRef.current?.record.projectId !== projectId ||
        // Fenced the same way every other selection-scoped reply is: a reply
        // about another printer describes another machine's profiles.
        response.printerId !== printerId
      ) {
        return;
      }
      setOrcaProfiles(response.profiles);
    } catch (cause) {
      if (unmountedRef.current || profileIdRef.current !== profileId) return;
      reportError(
        errorMessage(
          cause,
          'OrcaSlicer profiles for this project could not be loaded.',
        ),
      );
    }
  }, [reportError, selectedProfileId]);

  const createProject = useCallback(
    async (input: NewProjectInput): Promise<boolean> => {
      if (selectedProfileId === null) return false;
      const profileId = selectedProfileId;
      const parsedWorkspaceState = CalibrationWorkspacePayloadSchema.safeParse({
        schemaVersion: 1,
        domainState: input.domainState,
        metadata: {
          displayName: input.displayName.trim(),
          description: input.description,
        },
        stepDrafts: {},
        workflowDrafts: emptyWorkflowDrafts(),
        photos: [],
        physicalMatch: input.physicalMatch,
        selectedBaseProfile: input.selectedBaseProfile,
        selectedBaseProfileId: input.selectedBaseProfile.orcaProfileId,
        autosaveRevision: 0,
      });
      if (!parsedWorkspaceState.success) {
        reportError(
          `Project creation payload failed exact validation: ${parsedWorkspaceState.error.issues[0]?.message ?? 'validation failed'}`,
        );
        return false;
      }
      const workspaceState = parsedWorkspaceState.data;
      const projection = workspaceProjection(workspaceState);
      const optimisticRecord: CalibrationWorkspaceStateRecord = {
        profileId,
        projectId: input.domainState.projectId,
        displayName: workspaceState.metadata.displayName,
        description: workspaceState.metadata.description,
        printerId: input.printerId,
        status: projection.status,
        completedStepCount: projection.completedStepCount,
        totalStepCount: projection.totalStepCount,
        isSynced: false,
        isPrinterContextFresh: false,
        hasConflicts: false,
        remoteProjectId: null,
        baseRevision: null,
        createdAt: input.domainState.createdAt,
        updatedAt: input.domainState.createdAt,
        workspaceState,
      };
      const project: OpenCalibrationProject = {
        record: optimisticRecord,
        domainState: input.domainState,
      };
      setLiveMessage('Saving the new project to the local queue.');
      const request = saveRequest(profileId, project, environment.createId());
      const creationTask = saveQueueRef.current.then(async () => {
        try {
          const response =
            await calibrationApi().saveCalibrationWorkspaceState(request);
          if (
            response.state.profileId !== request.profileId ||
            response.state.projectId !== request.projectId ||
            response.state.printerId !== request.printerId
          ) {
            throw new Error(
              'Saved calibration response did not match the requested profile, project, and printer identity.',
            );
          }
          saveFailureRef.current = null;
          return response;
        } catch (cause) {
          const failure = new Error(
            errorMessage(cause, 'The new project could not be saved locally.'),
          );
          saveFailureRef.current = failure;
          throw failure;
        }
      });
      saveQueueRef.current = creationTask.then(
        () => undefined,
        () => undefined,
      );
      try {
        const response = await creationTask;
        if (profileIdRef.current !== profileId) return false;
        const parsed = parseWorkspaceRecordDomain(response.state);
        if (!parsed.ok) {
          reportError(parsed.message);
          return false;
        }
        hydrateActiveProject({
          record: response.state,
          domainState: parsed.state,
        });
        setRecords((current) => replaceRecord(current, response.state));
        setRecoveryByProject((current) => {
          const next = { ...current };
          delete next[response.state.projectId];
          return next;
        });
        setSelectedStageId('temperature');
        setView('overview');
        setLiveMessage('Project saved locally; synchronization is queued.');
        return true;
      } catch (cause) {
        reportError(
          errorMessage(
            cause,
            'The new project could not be saved to the local queue.',
          ),
        );
        return false;
      }
    },
    [environment, hydrateActiveProject, reportError, selectedProfileId],
  );

  const updateMetadata = useCallback(
    (field: 'displayName' | 'description', value: string): void => {
      setMetadataDraft((current) => ({ ...current, [field]: value }));
      const project = activeProjectRef.current;
      if (project === null) return;
      if (field === 'displayName' && value.trim().length === 0) {
        setMetadataError(
          'Project name is required. The last valid name remains saved.',
        );
        announce('Project name is required. Enter a nonempty name to save it.');
        return;
      }
      const persistedValue = field === 'displayName' ? value.trim() : value;
      const payload: CalibrationWorkspacePayload = {
        ...payloadFor(project),
        metadata: {
          ...project.record.workspaceState.metadata,
          [field]: persistedValue,
        },
      };
      const next = replacePayload(project, payload);
      setActiveProject(next);
      updateOptimisticRecord(next);
      if (field === 'displayName') setMetadataError(null);
      scheduleDebouncedSave();
    },
    [announce, scheduleDebouncedSave, setActiveProject, updateOptimisticRecord],
  );

  const updateStepDraft = useCallback(
    (
      stageId: CalibrationStageId,
      field: keyof WorkspaceStepDraft,
      value: string,
    ): void => {
      const project = activeProjectRef.current;
      if (project === null) return;
      const existing = project.record.workspaceState.stepDrafts[stageId] ?? {
        prerequisites: '',
        methodNotes: '',
        expectedResult: '',
      };
      const payload: CalibrationWorkspacePayload = {
        ...payloadFor(project),
        stepDrafts: {
          ...project.record.workspaceState.stepDrafts,
          [stageId]: { ...existing, [field]: value },
        },
      };
      const next = replacePayload(project, payload);
      setActiveProject(next);
      updateOptimisticRecord(next);
      scheduleDebouncedSave();
    },
    [scheduleDebouncedSave, setActiveProject, updateOptimisticRecord],
  );

  const updateWorkflowDraft = useCallback(
    (stageId: CalibrationStageId, draft: WorkspaceWorkflowDraft): void => {
      const project = activeProjectRef.current;
      if (project === null) return;
      const payload: CalibrationWorkspacePayload = {
        ...payloadFor(project),
        workflowDrafts: {
          ...project.record.workspaceState.workflowDrafts,
          [stageId]: draft,
        },
      };
      const next = replacePayload(project, payload);
      setActiveProject(next);
      updateOptimisticRecord(next);
      scheduleDebouncedSave();
    },
    [scheduleDebouncedSave, setActiveProject, updateOptimisticRecord],
  );

  const setPhysicalMatch = useCallback(
    async (
      confirmation: OpenCalibrationProject['record']['workspaceState']['physicalMatch'],
    ): Promise<void> => {
      const project = activeProjectRef.current;
      if (project === null) return;
      const payload: CalibrationWorkspacePayload = {
        ...payloadFor(project),
        physicalMatch: confirmation,
      };
      await bumpAndSave(
        replacePayload(project, payload),
        environment.now(),
        confirmation
          ? 'Saving physical tool confirmation locally.'
          : 'Clearing physical tool confirmation locally.',
      );
    },
    [bumpAndSave, environment],
  );

  const addPhoto = useCallback(
    async (
      photo: WorkspacePhoto,
      stageId: CalibrationStageId,
    ): Promise<void> => {
      const project = activeProjectRef.current;
      if (project === null) return;
      const draft = project.record.workspaceState.workflowDrafts[stageId];
      const payload: CalibrationWorkspacePayload = {
        ...payloadFor(project),
        photos: [...project.record.workspaceState.photos, photo].sort(
          (left, right) => left.order - right.order,
        ),
        workflowDrafts: {
          ...project.record.workspaceState.workflowDrafts,
          [stageId]: {
            ...draft,
            photoCaption: '',
            photoOrder: Math.min(1_000, photo.order + 1),
          },
        },
      };
      await bumpAndSave(
        replacePayload(project, payload),
        environment.now(),
        'Photo metadata saved locally; upload synchronization is queued.',
      );
    },
    [bumpAndSave, environment],
  );

  /**
   * Append a print lifecycle observation to durable workspace state.
   * Idempotent: if an observation with the same `observationId` already exists,
   * the call is a no-op (mirrors domain reducer idempotency at reducer.ts:426).
   */
  const storePrintObservation = useCallback(
    async (observation: CalibrationPrintObservation): Promise<void> => {
      const project = activeProjectRef.current;
      if (project === null) return;
      const existing = project.record.workspaceState.printObservations ?? [];
      if (existing.some((o) => o.observationId === observation.observationId)) {
        return; // idempotent
      }
      const payload: CalibrationWorkspacePayload = {
        ...payloadFor(project),
        printObservations: [...existing, observation],
      };
      await bumpAndSave(
        replacePayload(project, payload),
        environment.now(),
        'Print observation saved locally.',
      );
    },
    [bumpAndSave, environment],
  );

  /**
   * Persist the validated asset SHA-256 checksum with the given domain attempt
   * ID. Used by `handlePickAndValidateAsset` so provenance survives a reload.
   */
  const storeAttemptAssetSha256 = useCallback(
    async (attemptId: string, sha256: string): Promise<void> => {
      const project = activeProjectRef.current;
      if (project === null) return;
      const existing =
        project.record.workspaceState.assetSha256ByAttemptId ?? {};
      const payload: CalibrationWorkspacePayload = {
        ...payloadFor(project),
        assetSha256ByAttemptId: { ...existing, [attemptId]: sha256 },
      };
      await bumpAndSave(
        replacePayload(project, payload),
        environment.now(),
        'Asset SHA-256 saved with attempt.',
      );
    },
    [bumpAndSave, environment],
  );

  const refreshProjectContext =
    useCallback(async (): Promise<CalibrationPrinterContext | null> => {
      const project = activeProjectRef.current;
      if (selectedProfileId === null || project === null) return null;
      try {
        await flush();
      } catch (cause) {
        reportError(
          errorMessage(
            cause,
            'Save pending changes before refreshing context.',
          ),
        );
        return null;
      }
      const profileId = selectedProfileId;
      const projectId = project.record.projectId;
      const epoch = ++contextRequestEpochRef.current;
      setLiveMessage(
        'Refreshing the authoritative printer configuration snapshot.',
      );
      try {
        // Sequential, not parallel: the profile request is pinned to the
        // revision this context actually reports, so it cannot be issued until
        // the context is known. Resolving both at once meant the profile call
        // had no printer to scope to and fell back to the whole farm.
        const context = await calibrationApi().getCalibrationPrinterContext({
          profileId,
          printerId: project.record.printerId,
        });
        if (
          profileIdRef.current !== profileId ||
          contextRequestEpochRef.current !== epoch ||
          activeProjectRef.current?.record.projectId !== projectId
        )
          return null;
        const profileResponse = await calibrationApi().listOrcaProfiles({
          profileId,
          printerId: project.record.printerId,
          ...(context.configurationRevision === null
            ? {}
            : { configurationRevision: context.configurationRevision }),
        });
        if (
          profileIdRef.current !== profileId ||
          contextRequestEpochRef.current !== epoch ||
          activeProjectRef.current?.record.projectId !== projectId ||
          profileResponse.printerId !== project.record.printerId
        )
          return null;
        setOrcaProfiles(profileResponse.profiles);
        setLiveMessage(
          `Authoritative current context loaded for ${context.displayName}; no project snapshot was changed.`,
        );
        return context;
      } catch (cause) {
        if (
          profileIdRef.current !== profileId ||
          contextRequestEpochRef.current !== epoch ||
          activeProjectRef.current?.record.projectId !== projectId
        )
          return null;
        reportError(
          errorMessage(
            cause,
            'The current printer context could not be refreshed.',
          ),
        );
        return null;
      }
    }, [flush, reportError, selectedProfileId]);

  const sync = useCallback(
    async (projectId?: string): Promise<void> => {
      if (selectedProfileId === null) return;
      const profileId = selectedProfileId;
      setLiveMessage('Synchronizing queued calibration changes.');
      setAlertMessage(null);
      try {
        await flush();
        if (profileIdRef.current !== profileId) return;
        const result = await calibrationApi().syncCalibrationNow({
          profileId,
          ...(projectId === undefined ? {} : { projectId }),
        });
        if (profileIdRef.current !== profileId) return;
        if (result.phase === 'failed') {
          reportError(result.error ?? 'Calibration synchronization failed.');
          return;
        }
        await refresh();
        if (result.phase === 'succeeded') {
          setLiveMessage('Calibration synchronization completed.');
        } else if (result.phase === 'partialConflict') {
          setLiveMessage(
            `Synchronization completed with ${result.conflictCount} conflict${result.conflictCount === 1 ? '' : 's'}.`,
          );
        } else {
          setLiveMessage(`Synchronization status: ${result.phase}.`);
        }
      } catch (cause) {
        if (profileIdRef.current !== profileId) return;
        setOffline(true);
        reportError(
          errorMessage(
            cause,
            'Calibration synchronization could not be started.',
          ),
        );
      }
    },
    [flush, refresh, reportError, selectedProfileId],
  );

  const generateProfile = useCallback(async (): Promise<void> => {
    const profileId = profileIdRef.current;
    const project = activeProjectRef.current;
    if (profileId === null || project === null) {
      reportError('Open a calibration project before generating a profile.');
      return;
    }
    const operationId = environment.createId();
    setLiveMessage(
      'Generating OrcaSlicer filament profile from calibration data.',
    );
    setAlertMessage(null);
    try {
      const result = await calibrationApi().generateOrcaProfile({
        profileId,
        projectId: project.record.projectId,
        operationId,
      });
      if (profileIdRef.current !== profileId) return;
      if (result.status === 'error') {
        reportError(`Profile generation failed: ${result.error.message}`);
        return;
      }
      setGeneratedProfile({
        operationId,
        displayName: result.displayName,
        safeFilename: result.safeFilename,
        profileJsonHash: result.profileJsonHash,
        patchedFieldCount: result.patchedFieldCount,
        warnings: result.warnings,
        installedHash: null,
        backupHash: null,
        exportedHash: null,
      });
      const warningSuffix =
        result.warnings.length > 0
          ? ` ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}.`
          : '';
      setLiveMessage(
        `Profile "${result.displayName}" generated with ${result.patchedFieldCount} calibrated field${result.patchedFieldCount === 1 ? '' : 's'}.${warningSuffix}`,
      );
    } catch (cause) {
      if (profileIdRef.current !== profileId) return;
      reportError(errorMessage(cause, 'OrcaSlicer profile generation failed.'));
    }
  }, [environment, reportError]);

  const exportProfile = useCallback(async (): Promise<void> => {
    const profileId = profileIdRef.current;
    const project = activeProjectRef.current;
    if (profileId === null || project === null) {
      reportError('Open a calibration project before exporting a profile.');
      return;
    }
    if (generatedProfile === null) {
      reportError('Generate a profile before exporting it.');
      return;
    }
    setLiveMessage('Opening save dialog for OrcaSlicer profile export.');
    setAlertMessage(null);
    try {
      const result = await calibrationApi().exportOrcaProfile({
        orcaProfileId: generatedProfile.displayName,
        operationId: generatedProfile.operationId,
      });
      if (profileIdRef.current !== profileId) return;
      if (result.status === 'canceled') {
        setLiveMessage('Profile export was canceled.');
        return;
      }
      if (result.status === 'error') {
        reportError(`Profile export failed: ${result.error.message}`);
        return;
      }
      setGeneratedProfile((prev) =>
        prev ? { ...prev, exportedHash: result.profileJsonHash } : prev,
      );
      setLiveMessage(
        `Profile "${generatedProfile.displayName}" exported successfully. Hash: ${result.profileJsonHash.slice(0, 12)}…`,
      );
    } catch (cause) {
      if (profileIdRef.current !== profileId) return;
      reportError(errorMessage(cause, 'OrcaSlicer profile export failed.'));
    }
  }, [generatedProfile, reportError]);

  const installProfile = useCallback(async (): Promise<void> => {
    const profileId = profileIdRef.current;
    const project = activeProjectRef.current;
    if (profileId === null || project === null) {
      reportError('Open a calibration project before installing a profile.');
      return;
    }
    if (generatedProfile === null) {
      reportError('Generate a profile before installing it.');
      return;
    }
    setLiveMessage('Installing OrcaSlicer filament profile transactionally.');
    setAlertMessage(null);
    try {
      const result = await calibrationApi().installOrcaProfile({
        profileId,
        operationId: generatedProfile.operationId,
        confirmedProfileJsonHash: generatedProfile.profileJsonHash,
      });
      if (profileIdRef.current !== profileId) return;
      if (result.status === 'error') {
        reportError(
          `Profile installation failed: ${result.error.message}. Your existing OrcaSlicer profile was not changed. Select Restore from backup if a backup exists, then select Install transactionally to retry.`,
        );
        return;
      }
      setGeneratedProfile((prev) =>
        prev
          ? {
              ...prev,
              installedHash: result.installedHash,
              backupHash: result.backupHash,
            }
          : prev,
      );
      setLiveMessage(
        `Profile "${generatedProfile.displayName}" installed successfully. A backup was created.`,
      );
    } catch (cause) {
      if (profileIdRef.current !== profileId) return;
      reportError(
        errorMessage(cause, 'OrcaSlicer profile installation failed.'),
      );
    }
  }, [generatedProfile, reportError]);

  const restoreProfile = useCallback(async (): Promise<void> => {
    const profileId = profileIdRef.current;
    const project = activeProjectRef.current;
    if (profileId === null || project === null) {
      reportError('Open a calibration project before restoring a profile.');
      return;
    }
    if (generatedProfile === null || generatedProfile.backupHash === null) {
      reportError('No install backup is available to restore from.');
      return;
    }
    setLiveMessage('Restoring OrcaSlicer profile from backup.');
    setAlertMessage(null);
    try {
      const result = await calibrationApi().restoreOrcaProfile({
        profileId,
        operationId: generatedProfile.operationId,
        backupHash: generatedProfile.backupHash,
      });
      if (profileIdRef.current !== profileId) return;
      if (result.status === 'error') {
        reportError(`Profile restore failed: ${result.error.message}`);
        return;
      }
      setGeneratedProfile((prev) =>
        prev ? { ...prev, installedHash: null, backupHash: null } : prev,
      );
      setLiveMessage(
        `Profile restored from backup. Hash: ${result.restoredHash.slice(0, 12)}…. Your previous OrcaSlicer profile is back in place. Select Generate OrcaSlicer profile to try the calibrated profile again.`,
      );
    } catch (cause) {
      if (profileIdRef.current !== profileId) return;
      reportError(errorMessage(cause, 'OrcaSlicer profile restore failed.'));
    }
  }, [generatedProfile, reportError]);

  const value = useMemo<CalibrationWorkspaceStoreValue>(
    () => ({
      profileId: selectedProfileId,
      profileName,
      disabled,
      environment,
      view,
      selectedStageId,
      availability,
      records,
      unhydratedProjects,
      recoveryByProject,
      loading,
      offline,
      error,
      activeProject,
      metadataDraft,
      metadataError,
      creation,
      orcaProfiles,
      liveMessage,
      alertMessage,
      generatedProfile,
      manageProfiles,
      refresh,
      sync,
      flush,
      navigate,
      openProject,
      openStage,
      loadCreationData,
      selectPrinter,
      loadProjectProfiles,
      createProject,
      dispatchEvent,
      updateMetadata,
      updateStepDraft,
      updateWorkflowDraft,
      setPhysicalMatch,
      addPhoto,
      storePrintObservation,
      storeAttemptAssetSha256,
      refreshProjectContext,
      announce,
      reportError,
      generateProfile,
      exportProfile,
      installProfile,
      restoreProfile,
    }),
    [
      activeProject,
      addPhoto,
      alertMessage,
      announce,
      availability,
      createProject,
      creation,
      disabled,
      dispatchEvent,
      environment,
      error,
      exportProfile,
      flush,
      generatedProfile,
      generateProfile,
      installProfile,
      liveMessage,
      loadCreationData,
      selectPrinter,
      loadProjectProfiles,
      loading,
      manageProfiles,
      metadataDraft,
      metadataError,
      navigate,
      offline,
      openProject,
      openStage,
      orcaProfiles,
      profileName,
      records,
      recoveryByProject,
      refresh,
      refreshProjectContext,
      reportError,
      restoreProfile,
      selectedProfileId,
      selectedStageId,
      setPhysicalMatch,
      storeAttemptAssetSha256,
      storePrintObservation,
      sync,
      unhydratedProjects,
      updateMetadata,
      updateStepDraft,
      updateWorkflowDraft,
      view,
    ],
  );

  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}

export function useCalibrationWorkspaceStore(): CalibrationWorkspaceStoreValue {
  const value = useContext(StoreContext);
  if (value === null)
    throw new Error('Calibration workspace store is unavailable.');
  return value;
}
