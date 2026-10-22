import {execFile} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {botPaths, paths} from '../../config/paths';
import {loadBots, registerBotEntry, reserveImportedBots, setBotActivation, unregisterImportedBots} from '../../config/bots';
import {createSecret, listSecretIds, removeSecretIfIv} from '../../config/keystore';
import {readSingleInstanceHolder} from '../../core/single-instance';
import {bridgeVersion} from '../../core/version';
import {resolveCodexBin} from '../../agent/codex-appserver/locate';
import {log} from '../../core/logger';
import {readLocalText} from './bounded-local-files';
import {createBridgeImporter, type ImporterDeps} from './transaction';
import {BridgeLocks} from './locks';
import {readBridgeDone} from './markers';

type Live = ImporterDeps['runtime'];
export type BridgeGuard = {pid?: number; message: string};
const nativeRun: ImporterDeps['run'] = (command, args) => new Promise(resolve => {
  if (!['/bin/launchctl', '/bin/ps'].includes(command)) throw new Error('Unsupported import command');
  execFile(command, [...args], {encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024}, (error, stdout, stderr) => {
    resolve({status: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr});
  });
});
/** Exactly one importer/lock owner per host. Children and one-off commands never construct it. */
function createRuntime() {
  const homeDir = realpathSync(homedir()), bridgeDir = join(homeDir, '.feishu-codex-bridge'), locks = new BridgeLocks(bridgeDir);
  let live: Live | undefined, changed: (() => void) | undefined, recoveryBlocked: Set<string> | 'all' | undefined;
  const importer = createBridgeImporter({appDir: paths.appDir, bridgeDir, homeDir,
    plistFile: join(homeDir, 'Library/LaunchAgents/ai.feishu-codex-bridge.bot.plist'), uid: process.getuid?.() ?? 0,
    platform: process.platform, version: bridgeVersion(), run: nativeRun, locks,
    registry: {
      ids: async () => {const registry = await loadBots(); return [...new Set([...registry.bots.map(bot => bot.appId), ...Object.keys(registry.allocations ?? {})])];},
      reserve: reserveImportedBots,
      register: async (bot, txId, registrationId, handle) => {
        const result = await registerBotEntry({...bot.entry, initialPreferences: bot.config.preferences}, async () => {
          const text = await readLocalText(paths.appDir, botPaths(bot.appId).configFile);
          const config = text ? JSON.parse(text) : undefined;
          if (config?.accounts?.app?.id !== bot.appId || config?.accounts?.app?.tenant !== bot.entry.tenant) throw new Error('Imported bot config changed');
        }, {txId, registrationId, onBeforePublish: handle});
        if (result.kind !== 'registered') throw new Error('Import registration conflict');
      },
      unregister: unregisterImportedBots,
      activate: async (id, active) => {await setBotActivation(id, active);},
    },
    secrets: {ids: listSecretIds, create: createSecret, remove: removeSecretIfIv},
    runtime: {
      start: async (id, fallback) => {if (!live) throw new Error('Supervisor is unavailable'); await live.start(id, fallback);},
      stop: async id => {
        if (live) return live.stop(id);
        // At boot recovery, no new children exist. Never move data while an orphan still holds its V1 lock.
        if (readSingleInstanceHolder(id, botPaths(id).processesFile)) throw new Error('Imported bot process is still running');
      },
      connection: async id => live ? live.connection(id) : 'unknown',
    },
    resolveCodex: async () => resolveCodexBin({force: true}), changed: () => changed?.(),
    fault: point => {
      const seam = process.env.VONVON_TEST_IMPORT_FAIL;
      if (seam && ['after-stop', 'after-lock', 'during-copy', 'after-copy', 'after-hooks', 'after-move', 'during-start', 'before-marker', 'after-bridge-marker'].includes(seam) && seam === point) throw new Error('Import test fault');
    },
  });
  return {
    importer,
    bind(runtime: Live, onChanged: () => void) {live = runtime; changed = onChanged;},
    async recover() {
      const seam = process.env.VONVON_TEST_IMPORT_FAIL;
      if (seam) log.warn('bridge-import', 'test_seam', {seam});
      await importer.recover();
      const {view} = await importer.status();
      if (view && (view.step === 'rollback-failed' || view.cleanupPending)) recoveryBlocked = view.bots.length ? new Set(view.bots.map(bot => bot.appId)) : 'all';
    },
    async guard(appId: string): Promise<BridgeGuard | undefined> {
      if (process.platform !== 'darwin') return;
      if (recoveryBlocked === 'all' || recoveryBlocked?.has(appId)) {
        const {view} = await importer.status();
        if (view?.step === 'rolled-back' && !view.cleanupPending) recoveryBlocked = undefined;
        else return {message: 'Bridge 导入尚未恢复完成，请先重试回滚。'};
      }
      try {
        const done = await readBridgeDone(paths.appDir, bridgeDir);
        if (!done?.bots.includes(appId)) return;
        await locks.acquire(appId, true);
      } catch {
        let pid: number | undefined;
        try {pid = locks.holder(appId)?.pid;} catch { /* malformed locks also fail closed */ }
        return { ...(pid ? {pid} : {}), message: pid ? `Bridge 正在运行这个 Bot（PID ${pid}）。先在终端运行 feishu-codex-bridge stop，Vonvon 会自动接上。` : '读不了 Bridge 的锁或导入记录。请检查后重试，Bot 暂不启动。'};
      }
    },
    releaseRemoved(ids: Set<string>) {
      // Locks for disabled Bots remain; only actual registry removal releases ownership.
      void readBridgeDone(paths.appDir, bridgeDir).then(done => {for (const id of done?.bots ?? []) if (!ids.has(id)) locks.release(id);}).catch(() => undefined);
    },
    async shutdown() {await importer.shutdown();},
    dispose() {live = undefined; changed = undefined; locks.close();},
  };
}
let instance: ReturnType<typeof createRuntime> | undefined;
export function bridgeImportRuntime(): ReturnType<typeof createRuntime> {
  if (process.send) throw new Error('Bridge import is host-only');
  return instance ??= createRuntime();
}
