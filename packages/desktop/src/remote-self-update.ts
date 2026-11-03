import {
  DESKTOP_SELF_UPDATE_CAPABILITY, type DesktopUpdate, type DesktopUpdateReport, type DesktopUpdateReportState, type DesktopUpdateRequestPayload,
} from '@vonvon/protocol';
import { ConnectionError, type VonvonClient } from '@vonvon/client/browser';
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
type Owner = { readonly client: Pick<VonvonClient, 'admin' | 'machine' | 'onDesktopUpdateRequest' | 'onError'> };
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
  /** `beforeUpdateInstall`'s first step: tells the daemon the app restarts now, while the connection is still there.
   * Throws when the daemon refused it or the connection closed: the install stops before the app quits. */
  aboutToRestart(): Promise<void>;
  dispose(): void;
}

export const REMOTE_UPDATE_TEXT = {
  notice: (by: string): string => `${by}正在更新这台电脑上的 Vonvon Bot。下载好后会直接重启，正在进行的对话会被中断。`,
  quitting: '那台电脑上的 Vonvon Bot 正在退出。',
  downloading: '那台电脑正在下载桌面端更新，稍后再查。',
  failed: '桌面端更新没有完成。',
  restarting: '下载好了，正在重启。',
  /** The daemon did not take `restarting` (refused, or the connection closed): no restart, the download stays. */
  notRestarting: '服务端没有收到要重启的消息，这次没有重启，下载好的更新还在。',
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

  /** True once the daemon took the report. */
  function send(client: Owner['client'], requestId: string, state: DesktopUpdateReportState, message: string, latest?: string): Promise<boolean> {
    const report: DesktopUpdateReport = { type: 'desktopUpdateReport', requestId, state, message: message.slice(0, 1024), ...(latest ? { latest } : {}) };
    return client.machine(report).then(() => true, error => { deps.log('remote-update-report-failed', { state, code: codeOf(error) }); return false; });
  }
  const sendUpdate = (client: Owner['client'], requestId: string, update: DesktopUpdate): Promise<boolean> =>
    send(client, requestId, update.state, update.message, update.latest);
  function publish(update: DesktopUpdate): void {
    known = update;
    deps.publish(update);
  }
  function finish(current: Applying): void {
    if (applying !== current) return;
    applying = undefined;
    deps.notice(undefined);
  }
  /**
   * The daemon connection a remote update came on closed, or another took its place (Codex 审查 265-2): it ends here, at
   * once. The download goes on and stays for 重启升级 here; nothing restarts, and nothing more goes to that connection.
   * The daemon there ends its record as failed: its peer left, or the next process found it cut short.
   */
  function connectionGone(client: Owner['client']): void {
    const current = applying;
    if (current?.client !== client) return;
    deps.log('remote-update-connection-lost');
    finish(current);
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
    // Still this update, on the connection it came on: connectionGone ends it otherwise, and dispose lets that go.
    const going = (): boolean => applying === current && watched?.client === client;
    try {
      const found = await deps.updater.check();
      publish(found);
      if (!going()) return;
      current.latest = found.latest;
      let words = found.message;
      if (found.state === 'available') {
        await send(client, requestId, 'downloading', found.message, found.latest);
        const got = await deps.updater.install();
        publish(got);
        if (!going()) return;
        if (got.state !== 'downloaded') { await sendUpdate(client, requestId, got); finish(current); return; }
        current.latest = got.latest ?? current.latest;
        words = got.message;
      } else if (found.state !== 'downloaded') { await sendUpdate(client, requestId, found); finish(current); return; }
      // The last report before the restart, a download already there included: the daemon has to take it on the
      // connection that asked, or there is no restart now (Codex 审查 265-2). The download stays for 重启升级 here.
      const taken = await send(client, requestId, 'downloaded', words, current.latest);
      if (!going()) return;
      if (!taken) { deps.log('remote-update-not-installing'); finish(current); return; }
      // The app started quitting while it downloaded: no restart now either.
      if (deps.quitting()) { await send(client, requestId, 'error', REMOTE_UPDATE_TEXT.quitting); finish(current); return; }
      deps.log('remote-update-installing');
      // beforeUpdateInstall reports `restarting` (aboutToRestart), closes the app's connections, then the app quits.
      await deps.updater.install();
    } catch (error) {
      if (applying === current) await send(client, requestId, 'error', safeMessage(error));
      finish(current);
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
    const previous = watched;
    previous?.off();
    const entry = { client, off: (): void => {} };
    watched = entry;
    if (previous) connectionGone(previous.client);
    // Listening first, so a request right after the daemon took the negotiate is not missed.
    const offRequests = client.onDesktopUpdateRequest(payload => handle(client, payload));
    // The connection closed (the daemon there crashed or was restarted): the bridge tells only once the next one is ready.
    const offError = client.onError(error => {
      if (!(error instanceof ConnectionError)) return;
      if (watched === entry) { entry.off(); watched = undefined; }
      connectionGone(client);
    });
    entry.off = () => { offRequests(); offError(); };
    void client.admin({ type: 'negotiate', capabilities: [DESKTOP_SELF_UPDATE_CAPABILITY] }).then(reply => {
      if (reply.kind !== 'negotiated') throw Object.assign(new Error('refused'), { code: reply.kind === 'refused' ? reply.code : reply.kind });
    }).catch(error => {
      // An older daemon, or one already negotiated: remote updates then answer desktop_not_running, and this line says why.
      deps.log('remote-update-negotiate-refused', { code: codeOf(error) });
      entry.off();
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
      // A daemon slow to answer is not waited for; one that refused it, or a connection that closed, stops the restart.
      const taken = await Promise.race([
        send(current.client, current.requestId, 'restarting', REMOTE_UPDATE_TEXT.restarting, current.latest),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), deps.reportWaitMs ?? 2_000); }),
      ]);
      clearTimeout(timer);
      if (!taken || applying !== current) throw new DesktopUpdateError(REMOTE_UPDATE_TEXT.notRestarting);
    },
    dispose() {
      disposed = true;
      offOwner();
      watched?.off();
      watched = undefined;
    },
  };
}
