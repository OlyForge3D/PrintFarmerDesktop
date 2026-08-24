/**
 * On-disk restart-resilience store for the filament calibration wizard
 * (issue #754).
 *
 * The wizard's in-flight progress (which method, which step, the in-flight
 * slice `jobId`) previously lived only in renderer memory — a documented gap
 * from PR #753. The underlying work always survived a restart (the cloned
 * profile and any written-back measurements are durable on the server, and
 * an in-flight slice job keeps running there too); what was lost was purely
 * the desktop's bookkeeping of where the operator was in the loop.
 *
 * This store closes that gap the same way `UpdateStateStore`
 * (`src/main/updateState.ts`) persists update progress: one JSON file per
 * key, written via a temp-file-then-rename so a crash mid-write never leaves
 * a torn file behind. The key here is the server profile id — a profile can
 * have at most one filament calibration wizard in flight, matching the
 * one-wizard-per-profile renderer UI.
 *
 * This is deliberately main-process-local rather than routed through the
 * Rust sidecar's SQLite store: the record is a renderer progress bookmark,
 * not durable domain data, and the sidecar's workspace-state tables are
 * shaped for the printer-calibration model (`projectId`/`printerId`-bound),
 * which the filament flow does not participate in (see
 * `.squad/decisions/inbox/vasquez-filament-calibration-reframe.md`).
 *
 * A corrupt or unparseable record is treated as absent rather than a fatal
 * error — losing the resume bookmark degrades to the pre-#754 behaviour
 * (start the wizard fresh), which is the same "fails safe, just
 * inconveniently" characterization the issue gives restart loss in general.
 * The corrupt file is removed so the failure does not repeat on every read.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { FilamentWizardStateRecord } from '../shared/ipc.js';

/** UUIDs only — this is also what keeps a profileId safe to use as a file name. */
const PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class FilamentWizardStateStore {
  readonly directory: string;
  /**
   * Serializes writes (and clears, which are also mutations) per profile id
   * so two overlapping calls for the *same* profile apply in call order
   * rather than in whichever-finishes-first order — the renderer's
   * persist-on-change effect fires fire-and-forget on every meaningful
   * state change, so overlap is reachable in practice, not just in theory.
   */
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'calibration-filament-wizard');
  }

  private filePath(profileId: string): string {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      throw new Error(
        'filament wizard state store requires a UUID server profile id',
      );
    }
    return path.join(this.directory, `${profileId}.json`);
  }

  private enqueue<T>(profileId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(profileId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // Swallow rejections in the queue chain itself (the caller still sees
    // the real error via `next`) so one failed write doesn't wedge every
    // later write for the same profile.
    this.writeQueues.set(
      profileId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * The persisted record for one server profile, or `null` if there is none
   * — including when the file on disk is corrupt, in which case it is
   * removed so the read self-heals instead of failing forever.
   */
  async read(profileId: string): Promise<FilamentWizardStateRecord | null> {
    const filePath = this.filePath(profileId);
    if (!existsSync(filePath)) return null;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return FilamentWizardStateRecord.parse(JSON.parse(raw));
    } catch {
      await fs.rm(filePath, { force: true });
      return null;
    }
  }

  async write(
    profileId: string,
    state: FilamentWizardStateRecord,
  ): Promise<void> {
    const validated = FilamentWizardStateRecord.parse(state);
    return this.enqueue(profileId, async () => {
      mkdirSync(this.directory, { recursive: true });
      const filePath = this.filePath(profileId);
      // A per-call random suffix (not just the process pid) additionally
      // guards against an interrupted process leaving a stale temp file
      // from a previous run that could otherwise collide.
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        'utf8',
      );
      await fs.rename(temporaryPath, filePath);
    });
  }

  /** Returns whether a record existed to remove. */
  async clear(profileId: string): Promise<boolean> {
    return this.enqueue(profileId, async () => {
      const filePath = this.filePath(profileId);
      if (!existsSync(filePath)) return false;
      await fs.rm(filePath, { force: true });
      return true;
    });
  }
}
