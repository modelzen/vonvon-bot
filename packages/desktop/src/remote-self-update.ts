import {
  DESKTOP_SELF_UPDATE_CAPABILITY, type DesktopUpdate, type DesktopUpdateReport, type DesktopUpdateReportState, type DesktopUpdateRequestPayload,
} from '@vonvon/protocol';
import type { VonvonClient } from '@vonvon/client/browser';
import { StartHostRefusal } from './daemon-manager.js';
import { DesktopUpdateError } from './updates.js';

/**
 * devices 7.5, U4: another device updates this computer's Vonvon Bot. The daemon this app carries asks the shell over
 * the shell's own loopback connection (`desktopUpdateRequest`), and the shell runs the app's update as if 下载更新 and
 * 重启升级 were pressed here, reporting each step back (`machine.desktopUpdateReport`). macOS only for 0.9.0 (owner
 * 2026-11-02). No dialog: who asked is the owner, and an unattended computer would wait forever; the menu bar and the
 * window say who is updating and that the restart interrupts the conversations in progress.
 */

/** The app's updater (`DesktopUpdater`): `install` downloads first, and the second time quits and installs. */
export interface SelfUpdater { check(): Promise<DesktopUpdate>; install(): Promise<DesktopUpdate>; readonly busy: boolean }
type Owner = { readonly client: Pick<VonvonClient, 'admin' | 'machine' | 'onDesktopUpdateRequest'> };
export interface RemoteSelfUpdateDeps {
  updater: SelfUpdater;
  /** This computer's daemon connection now (`DesktopBridge.localOwner`), and each new one (`onLocalOwner`). */
  owner(): Owner | null;
  onOwner(listener: (owner: Owner) => void): () => void;
  /** The app is quitting or already cleaning up. */
  quitting(): boolean;
  /** The menu bar's and the window's line; undefined takes it away. */
  notice(text: string | undefined): void;
  /** The app's own update card follows what the remote update did. */
  publish(update: DesktopUpdate): void;
  log(event: string, fields?: Record<string, string | number>): void;
  /** How long `aboutToRestart` waits for the daemon to take the report. */
  reportWaitMs?: number;
}
export interface RemoteSelfUpdate {
  /** A remote update is under way: this computer's own 重启升级 waits for it. */
  readonly busy: boolean;
  /** The app's latest update state from its own checks, which a check asked while it downloads answers with. */
  observe(update: DesktopUpdate): void;
  /** `beforeUpdateInstall`'s first step: tells the daemon the app restarts now, while the connection is still there. */
  aboutToRestart(): Promise<void>;
  dispose(): void;
}

export const REMOTE_UPDATE_TEXT = {
  notice: (by: string): string => `${by}正在更新这台电脑上的 Vonvon Bot。下载好后会直接重启，正在进行的对话会被中断。`,
  quitting: '那台电脑上的 Vonvon Bot 正在退出。',
  downloading: '那台电脑正在下载桌面端更新，稍后再查。',
  failed: '桌面端更新没有完成。',
  restarting: '下载好了，正在重启。',
  /** This computer's 重启升级 while a remote update runs. */
  localRefused: '正在按另一台设备的请求更新，下载好后会自动安装并重启。',
} as const;

/** An updater's or the shell's own words go back as they are; anything else could carry paths. */
const safeMessage = (error: unknown): string =>
  (error instanceof DesktopUpdateError || error instanceof StartHostRefusal) && error.message ? error.message : REMOTE_UPDATE_TEXT.failed;
const codeOf = (error: unknown): string =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'error';

export function startRemoteSelfUpdate(deps: RemoteSelfUpdateDeps): RemoteSelfUpdate {
  let disposed = false;
  let known: DesktopUpdate | undefined;
  type Applying = { client: Owner['client']; requestId: string; latest?: string | undefined };
  let applying: Applying | undefined;
  let watched: { client: Owner['client']; off(): void } | undefined;

  function send(client: Owner['client'], requestId: string, state: DesktopUpdateReportState, message: string, latest?: string): Promise<void> {
    const report: DesktopUpdateReport = { type: 'desktopUpdateReport', requestId, state, message: message.slice(0, 1024), ...(latest ? { latest } : {}) };
    return client.machine(report).then(() => undefined, error => { deps.log('remote-update-report-failed', { state, code: codeOf(error) }); });
  }
  const sendUpdate = (client: Owner['client'], requestId: string, update: DesktopUpdate): Promise<void> =>
    send(client, requestId, update.state, update.message, update.latest);
  function publish(update: DesktopUpdate): void {
    known = update;
    deps.publish(update);
  }
  function finish(): void {
    applying = undefined;
    deps.notice(undefined);
  }

  async function check(client: Owner['client'], requestId: string): Promise<void> {
    // Downloading, for another device or for the person here: the updater is busy, and its last state says enough.
    if (applying || deps.updater.busy) {
      await (known ? sendUpdate(client, requestId, known) : send(client, requestId, 'error', REMOTE_UPDATE_TEXT.downloading));
      return;
    }
    let found: DesktopUpdate;
    try { found = await deps.updater.check(); }
    catch (error) { await send(client, requestId, 'error', safeMessage(error)); return; }
    publish(found);
    await sendUpdate(client, requestId, found);
  }

  async function apply(client: Owner['client'], requestId: string, by: string): Promise<void> {
    if (deps.quitting()) { await send(client, requestId, 'error', REMOTE_UPDATE_TEXT.quitting); return; }
    if (applying) { await send(client, requestId, 'error', '已有更新正在进行。'); return; }
    const current: Applying = { client, requestId };
    applying = current;
    deps.notice(REMOTE_UPDATE_TEXT.notice(by));
    try {
      const found = await deps.updater.check();
      publish(found);
      current.latest = found.latest;
      if (found.state === 'available') {
        await send(client, requestId, 'downloading', found.message, found.latest);
        const got = await deps.updater.install();
        publish(got);
        if (got.state !== 'downloaded') { await sendUpdate(client, requestId, got); finish(); return; }
        current.latest = got.latest ?? current.latest;
        await send(client, requestId, 'downloaded', got.message, current.latest);
      } else if (found.state !== 'downloaded') { await sendUpdate(client, requestId, found); finish(); return; }
      // Quit, or the daemon connection that asked went away, while it downloaded: no restart now. The download stays
      // for 重启升级 here.
      if (disposed || deps.quitting() || watched?.client !== client) { await send(client, requestId, 'error', REMOTE_UPDATE_TEXT.quitting); finish(); return; }
      deps.log('remote-update-installing');
      // beforeUpdateInstall reports `restarting` (aboutToRestart), closes the app's connections, then the app quits.
      await deps.updater.install();
    } catch (error) {
      await send(client, requestId, 'error', safeMessage(error));
      finish();
    }
  }

  function handle(client: Owner['client'], payload: DesktopUpdateRequestPayload): void {
    if (disposed) return;
    deps.log('remote-update-requested', { action: payload.action });
    void (payload.action === 'check' ? check(client, payload.requestId) : apply(client, payload.requestId, payload.by));
  }

  /** Declares the capability on this connection, once: the daemon takes only the first negotiate of a connection. */
  function attach(owner: Owner): void {
    const client = owner.client;
    if (disposed || watched?.client === client) return;
    watched?.off();
    // Listening first, so a request right after the daemon took the negotiate is not missed.
    const off = client.onDesktopUpdateRequest(payload => handle(client, payload));
    const entry = { client, off };
    watched = entry;
    void client.admin({ type: 'negotiate', capabilities: [DESKTOP_SELF_UPDATE_CAPABILITY] }).then(reply => {
      if (reply.kind !== 'negotiated') throw Object.assign(new Error('refused'), { code: reply.kind === 'refused' ? reply.code : reply.kind });
    }).catch(error => {
      // An older daemon, or one already negotiated: remote updates then answer desktop_not_running, and this line says why.
      deps.log('remote-update-negotiate-refused', { code: codeOf(error) });
      off();
      if (watched === entry) watched = undefined;
    });
  }

  const offOwner = deps.onOwner(attach);
  const first = deps.owner();
  if (first) attach(first);

  return {
    get busy() { return applying !== undefined; },
    observe(update) { known = update; },
    async aboutToRestart() {
      const current = applying;
      if (!current) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        send(current.client, current.requestId, 'restarting', REMOTE_UPDATE_TEXT.restarting, current.latest),
        new Promise<void>(resolve => { timer = setTimeout(resolve, deps.reportWaitMs ?? 2_000); }),
      ]);
      clearTimeout(timer);
    },
    dispose() {
      disposed = true;
      offOwner();
      watched?.off();
      watched = undefined;
    },
  };
}
