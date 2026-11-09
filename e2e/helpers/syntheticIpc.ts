import type { ElectronApplication } from '@playwright/test';
import type { z } from 'zod';
import { ipcSchemas, type IpcSchemas } from '../../src/shared/ipc';

type Channel = keyof IpcSchemas;
export type Reply<C extends Channel> =
  | { value: z.infer<IpcSchemas[C]['response']> }
  | { error: string }
  | { pending: true };
export type IpcReplies = { [C in Channel]?: Reply<C>[] };

/** Replaces main handlers, not the preload API, so requests still cross IPC. */
export async function installIpcReplies(
  app: ElectronApplication,
  replies: IpcReplies,
): Promise<void> {
  for (const [channel, sequence] of Object.entries(replies)) {
    if (sequence.length === 0) throw new Error(`Empty fixture: ${channel}`);
    for (const reply of sequence) {
      if ('value' in reply) {
        ipcSchemas[channel as Channel].response.parse(reply.value);
      }
    }
  }
  await app.evaluate(({ ipcMain }, definitions) => {
    const pending = new Map<string, () => void>();
    const calls = new Map<string, unknown[]>();
    Reflect.set(ipcMain, '__pfSyntheticPending', pending);
    Reflect.set(ipcMain, '__pfSyntheticCalls', calls);
    for (const [channel, sequence] of Object.entries(definitions)) {
      let index = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (_event, request: unknown) => {
        const history = calls.get(channel) ?? [];
        history.push(request);
        calls.set(channel, history);
        const reply = sequence[Math.min(index++, sequence.length - 1)]!;
        if ('error' in reply) throw new Error(reply.error);
        if ('pending' in reply) {
          await new Promise<void>((resolve) => pending.set(channel, resolve));
          const next = sequence[Math.min(index++, sequence.length - 1)]!;
          if ('error' in next) throw new Error(next.error);
          if (!('value' in next)) {
            throw new Error(
              `Pending fixture ${channel} needs a settled reply.`,
            );
          }
          return next.value;
        }
        return reply.value;
      });
    }
  }, replies);
}

export async function releaseIpcReply(
  app: ElectronApplication,
  channel: Channel,
): Promise<void> {
  await app.evaluate(({ ipcMain }, target) => {
    const pending = Reflect.get(ipcMain, '__pfSyntheticPending') as
      Map<string, () => void> | undefined;
    const release = pending?.get(target);
    if (!release) throw new Error(`No pending fixture reply: ${target}`);
    pending!.delete(target);
    release();
  }, channel);
}

export async function ipcRequests(
  app: ElectronApplication,
  channel: Channel,
): Promise<unknown[]> {
  return app.evaluate(({ ipcMain }, target) => {
    const calls = Reflect.get(ipcMain, '__pfSyntheticCalls') as
      Map<string, unknown[]> | undefined;
    if (!calls) throw new Error('Synthetic IPC fixture is not installed.');
    return calls.get(target) ?? [];
  }, channel);
}
