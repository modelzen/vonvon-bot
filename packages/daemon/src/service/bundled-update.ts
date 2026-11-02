import { randomBytes } from 'node:crypto';
import type { DesktopUpdateReport, Event } from '@vonvon/protocol';
import { RpcError } from '../server/errors';
import { log as daemonLog } from '../core/logger';
import { acquireUpdateLock, finishOwnedUpdate, readUpdateStatus, writeUpdateStatus, type UpdateStatus } from './update';
import { RESTART_PENDING_MS, restartPending } from './standalone-update';

/**
 * devices 7.5, U4: a server the desktop app carries (`bundled`) is updated with the app, by the desktop shell on its own
 * computer. This daemon asks that shell over its loopback connection (`desktopUpdateRequest`), and turns the shell's
 * reports (`machine.desktopUpdateReport`) into `update-status.json`, which every client follows. macOS only for 0.9.0
 * (owner 2026-11-02): a Windows desktop app is updated on that computer.
 */

/** The shell's connection: the hub's peer, as far as this module needs it. */
export interface DesktopShellPeer { readonly id: string; readonly open: boolean; event(event: Event): void }
type Log = Pick<typeof daemonLog, 'info' | 'warn'>;
type Timers = { setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void };
export interface BundledUpdateDeps {
  /** This computer's desktop shells, oldest connection first (http.ts `isDesktopShell`). */
  shells: () => readonly DesktopShellPeer[];
  /** This daemon's version: the update goes from it. */
  version: string;
  /** This device's name, as the words for another device say it. */
  deviceName: () => string;
  platform?: NodeJS.Platform;
  log?: Log;
  now?: () => number;
  timers?: Timers;
}
export type BundledCheck = { current: string; latest: string | null; hasUpdate: boolean; desktopShell?: boolean; message?: string };
export interface BundledUpdate {
  /** `fresh: false` answers with the last check this process made, without asking the shell again. */
  check(by: string, fresh: boolean): Promise<BundledCheck>;
  /** Starts the update and answers at once; `local`: asked from this computer, which the refusals say otherwise. */
  apply(by: string, local: boolean): string;
  report(peer: DesktopShellPeer, report: DesktopUpdateReport): void;
  /** A shell negotiated: after `restarting`, it means the app came back without the new version. */
  shellAttached(peer: DesktopShellPeer): void;
  shellDetached(peer: DesktopShellPeer): void;
  /** Timers off; a lock still held goes (the next start reads the record as interrupted). */
  close(): void;
}

/** How long a check waits for the shell: its manifest read alone may take 15 s (DT/updates.ts `fetchManifest`). */
export const CHECK_WAIT_MS = 20_000;
/** From the request to the shell's first report. */
export const FIRST_REPORT_MS = 30_000;
/** Between two reports while it downloads: the shell gives a download 10 minutes. */
export const STALLED_MS = 15 * 60_000;
/** After `restarting`: the new app should have stopped this daemon by then. As long as `pendingRestart` refuses. */
export const RESTARTED_MS = RESTART_PENDING_MS;

export const BUNDLED_TEXT = {
  notRunning: (device: string): string => `「${device}」的服务端是桌面端自带的，要那台电脑上的 Vonvon Bot 桌面端开着才能远程更新。在那台电脑上打开 Vonvon Bot 后再试，或者直接在那里更新。`,
  notRunningHere: '这台电脑的服务端是桌面端自带的，打开 Vonvon Bot 桌面端后再更新，或者直接在桌面端里更新。',
  windows: (device: string): string => `「${device}」的服务端是 Windows 桌面端自带的，还不能从别的设备更新。请在那台电脑上打开 Vonvon Bot 更新。`,
  windowsHere: '这个服务端随 Vonvon Bot 桌面应用提供，请在桌面应用里更新。',
  noAnswer: '那台电脑上的 Vonvon Bot 没有回应，稍后再试。',
  restartPending: '上一次更新还在重启，稍后再试。',
  busy: '已有更新正在进行。',
  notYours: '这次更新已经结束或不是发给你的。',
  noFirstReport: '那台电脑上的 Vonvon Bot 没有回应更新请求。',
  stalled: '下载桌面端更新超时。',
  closed: '那台电脑上的 Vonvon Bot 在更新完成前关掉了。',
  notReplaced: '桌面端重启后没有换上新版本。在那台电脑上退出 Vonvon Bot 再打开一次。',
  reopened: (version: string): string => `桌面端重新打开了，但服务端还是 ${version}，没能换上新版本。在那台电脑上退出 Vonvon Bot 再打开一次。`,
  upToDate: '已是最新',
} as const;

/**
 * A restart under way that a new update must not start over (devices-ui-4 4.2): a standalone one (I3's
 * `restartPending`, records with `previous`), or one the desktop runs, which has none.
 */
export function pendingRestart(status: UpdateStatus | null, now: number): boolean {
  if (restartPending(status, now)) return true;
  return status?.phase === 'restarting' && status.via === 'desktop' && now - status.at < RESTART_PENDING_MS;
}

const newId = (): string => `dur_${randomBytes(8).toString('hex')}`;
const sameRecord = (a: UpdateStatus | null, b: UpdateStatus): boolean => a !== null && a.at === b.at && a.phase === b.phase && a.via === b.via && a.detail === b.detail;

export function createBundledUpdate(deps: BundledUpdateDeps): BundledUpdate {
  const log = deps.log ?? daemonLog;
  const now = deps.now ?? Date.now;
  const timers: Timers = deps.timers ?? {
    setTimeout: (run, ms) => { const timer = setTimeout(run, ms); timer.unref(); return timer; },
    clearTimeout: timer => { clearTimeout(timer as NodeJS.Timeout); },
  };
  const windows = (deps.platform ?? process.platform) === 'win32';
  let last: BundledCheck | undefined;
  let checking: { id: string; peer: DesktopShellPeer; done: Promise<BundledCheck>; settle(result: BundledCheck): void; timer: unknown } | undefined;
  /** The update under way, from the request until it ends: its record, the lock until `restarting`, the one watchdog. */
  let applying: { id: string; peer: DesktopShellPeer; record: UpdateStatus; release?: (() => void) | undefined; restarting: boolean; timer?: unknown } | undefined;

  const shell = (): DesktopShellPeer | undefined => [...deps.shells()].reverse().find(peer => peer.open);
  const send = (peer: DesktopShellPeer, requestId: string, action: 'check' | 'apply', by: string): void => {
    peer.event({ type: 'event', event: 'desktopUpdateRequest', payload: { requestId, action, by: by.slice(0, 80) } });
  };
  function arm(ms: number, reason: string, message: string): void {
    const current = applying;
    if (!current) return;
    if (current.timer !== undefined) timers.clearTimeout(current.timer);
    current.timer = timers.setTimeout(() => {
      if (applying !== current) return;
      log.info('update', 'update-bundled-watchdog', { reason });
      fail(message);
    }, ms);
  }
  /** Ends the update, the record only while it is still ours: with the lock in hand before `restarting`, after it as I3 does. */
  function end(record: UpdateStatus): void {
    const current = applying;
    if (!current) return;
    applying = undefined;
    if (current.timer !== undefined) timers.clearTimeout(current.timer);
    try {
      if (sameRecord(readUpdateStatus(), current.record)) writeUpdateStatus(record);
      else log.info('update', 'update_record_ownership_lost', { reason: 'record_changed' });
    } finally { current.release?.(); }
  }
  function fail(message: string): void {
    const current = applying;
    if (!current) return;
    if (!current.restarting) { end({ ...base(current.record), phase: 'error', ok: false, message, at: now() }); return; }
    applying = undefined;
    if (current.timer !== undefined) timers.clearTimeout(current.timer);
    finishOwnedUpdate(current.record, 'error', message);
  }
  /** The fields every record of this update keeps. */
  const base = (record: UpdateStatus): UpdateStatus => ({ phase: record.phase, via: 'desktop', from: record.from, ...(record.to ? { to: record.to } : {}), at: record.at });
  function write(next: UpdateStatus): void {
    const current = applying;
    if (!current) return;
    if (!sameRecord(readUpdateStatus(), current.record)) {
      log.info('update', 'update_record_ownership_lost', { reason: 'record_changed' });
      applying = undefined;
      if (current.timer !== undefined) timers.clearTimeout(current.timer);
      current.release?.();
      return;
    }
    writeUpdateStatus(next);
    current.record = next;
  }

  function settleCheck(result: BundledCheck, remember: boolean): void {
    const current = checking;
    if (!current) return;
    checking = undefined;
    timers.clearTimeout(current.timer);
    if (remember) last = result;
    current.settle(result);
  }

  return {
    check(by, fresh) {
      const current = deps.version;
      if (windows) return Promise.resolve({ current, latest: null, hasUpdate: false, message: BUNDLED_TEXT.windows(deps.deviceName()) });
      const peer = shell();
      if (!peer) return Promise.resolve({ current, latest: null, hasUpdate: false, desktopShell: false });
      // An update under way: its progress is in coreUpdateStatus, and the shell is busy with it.
      if (applying) return Promise.resolve({ current, latest: applying.record.to ?? last?.latest ?? null, hasUpdate: false, desktopShell: true });
      if (!fresh && last) return Promise.resolve(last);
      if (checking) return checking.done;
      const id = newId();
      let settle!: (result: BundledCheck) => void;
      const done = new Promise<BundledCheck>(resolve => { settle = resolve; });
      const timer = timers.setTimeout(() => {
        log.info('update', 'update-bundled-watchdog', { reason: 'check-no-answer' });
        settleCheck({ current, latest: null, hasUpdate: false, desktopShell: true, message: BUNDLED_TEXT.noAnswer }, false);
      }, CHECK_WAIT_MS);
      checking = { id, peer, done, settle, timer };
      log.info('update', 'update-bundled-requested', { action: 'check', by });
      send(peer, id, 'check', by);
      return done;
    },
    apply(by, local) {
      if (windows) throw new RpcError('unsupported', local ? BUNDLED_TEXT.windowsHere : BUNDLED_TEXT.windows(deps.deviceName()));
      const peer = shell();
      if (!peer) {
        log.info('update', 'update-bundled-no-desktop');
        throw new RpcError('desktop_not_running', local ? BUNDLED_TEXT.notRunningHere : BUNDLED_TEXT.notRunning(deps.deviceName()));
      }
      if (pendingRestart(readUpdateStatus(), now())) throw new RpcError('conflict', BUNDLED_TEXT.restartPending);
      const release = acquireUpdateLock();
      if (!release) throw new RpcError('conflict', BUNDLED_TEXT.busy);
      const record: UpdateStatus = { phase: 'installing', detail: 'desktop-checking', via: 'desktop', from: deps.version, at: now() };
      try { writeUpdateStatus(record); }
      catch (error) { release(); throw error; }
      const id = newId();
      applying = { id, peer, record, release, restarting: false };
      arm(FIRST_REPORT_MS, 'no-first-report', BUNDLED_TEXT.noFirstReport);
      log.info('update', 'update-bundled-requested', { action: 'apply', by });
      send(peer, id, 'apply', by);
      return '开始更新…';
    },
    report(peer, report) {
      if (checking && report.requestId === checking.id && peer.id === checking.peer.id) {
        log.info('update', 'update-bundled-reported', { state: report.state });
        const current = deps.version;
        const latest = report.latest ?? null;
        // A download already there (下载更新 pressed there, 重启升级 not yet) is an update too: the shell installs it. Its line
        // (点击重启升级) is for the person there, so it does not come along (Codex 审查 264-1).
        if (report.state === 'available' || report.state === 'downloaded') settleCheck({ current, latest, hasUpdate: latest !== null, desktopShell: true }, true);
        else if (report.state === 'current') settleCheck({ current, latest, hasUpdate: false, desktopShell: true }, true);
        else settleCheck({ current, latest, hasUpdate: false, desktopShell: true, ...(report.message ? { message: report.message } : {}) }, true);
        return;
      }
      const current = applying;
      if (!current || report.requestId !== current.id || peer.id !== current.peer.id) throw new RpcError('invalid_request', BUNDLED_TEXT.notYours);
      log.info('update', 'update-bundled-reported', { state: report.state });
      const to = report.latest ?? current.record.to;
      const kept = { via: 'desktop' as const, from: current.record.from, ...(to ? { to } : {}) };
      if (current.restarting) {
        // Only an error can follow `restarting`: the install stopped before the app quit.
        if (report.state === 'error') fail(report.message);
        return;
      }
      switch (report.state) {
        case 'available': arm(STALLED_MS, 'stalled', BUNDLED_TEXT.stalled); return;
        case 'downloading':
          write({ ...kept, phase: 'installing', detail: 'desktop-downloading', ...(report.progress ? { progress: report.progress } : {}), at: now() });
          arm(STALLED_MS, 'stalled', BUNDLED_TEXT.stalled);
          return;
        case 'downloaded':
          write({ ...kept, phase: 'installing', detail: 'desktop-downloaded', at: now() });
          arm(STALLED_MS, 'stalled', BUNDLED_TEXT.stalled);
          return;
        case 'restarting': {
          write({ ...kept, phase: 'restarting', detail: 'draining', at: now() });
          if (applying !== current) return;
          // This process is about to be replaced: the new one ends the record (settleUpdateAtStartup).
          current.restarting = true;
          current.release?.();
          current.release = undefined;
          arm(RESTARTED_MS, 'not-replaced', BUNDLED_TEXT.notReplaced);
          return;
        }
        case 'current': end({ ...kept, phase: 'done', ok: true, message: BUNDLED_TEXT.upToDate, at: now() }); return;
        default: end({ ...kept, phase: 'error', ok: false, message: report.message || '桌面端更新没有完成。', at: now() });
      }
    },
    shellAttached(peer) {
      const current = applying;
      if (!current?.restarting || peer.id === current.peer.id) return;
      log.info('update', 'update-bundled-watchdog', { reason: 'reopened' });
      fail(BUNDLED_TEXT.reopened(deps.version));
    },
    shellDetached(peer) {
      if (checking?.peer.id === peer.id) settleCheck({ current: deps.version, latest: null, hasUpdate: false, desktopShell: false }, false);
      const current = applying;
      if (!current || current.restarting || peer.id !== current.peer.id) return;
      log.info('update', 'update-bundled-watchdog', { reason: 'closed' });
      fail(BUNDLED_TEXT.closed);
    },
    close() {
      if (checking) settleCheck({ current: deps.version, latest: null, hasUpdate: false, desktopShell: false }, false);
      const current = applying;
      applying = undefined;
      if (current?.timer !== undefined) timers.clearTimeout(current.timer);
      current?.release?.();
    },
  };
}
