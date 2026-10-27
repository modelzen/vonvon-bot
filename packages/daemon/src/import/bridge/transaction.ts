import {randomBytes, randomUUID} from 'node:crypto';
import {lstat, mkdir, readdir, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {BridgeDetection, BridgeImportReply, BridgeImportView, BridgePreflight} from '@vonvon/protocol';
import {BridgeAlreadyRunningError} from '../../core/single-instance';
import {inspectBridgeSource, upgradeMessage, type SourceInspectionOptions} from './preflight';
import {inspectLocalPath, readLocalText} from './bounded-local-files';
import {readBridgeSnapshot, type BridgeSnapshotRead} from './snapshot';
import type {ConvertedBridgeBot} from './conversion';
import {decryptLegacySecret, loadLegacyKeystoreKey} from './legacy-keystore';
import {readBridgeImportJournal, writeBridgeImportJournal, withBridgeMoveAllocation, ownsBridgeImportStage, type BridgeImportJournal, type BridgeImportIntent, type BridgeJournalPaths} from './journal';
import {moveFileSafely, type MoveFileDeps} from './move-file';
import {removeBridgeHooks} from './hooks';
import {readBytes, ensureDirectory, publishFile, removeOwnedFile, sha256, syncDir} from './files';
import {readBridgeDone} from './markers';
import {parseBridgeServiceState, type BridgeServiceState} from './service-state';

export type ImportNote = BridgeImportView['notes'][number];
type ConvertedSnapshot = Extract<BridgeSnapshotRead, {kind: 'read'}> & {conversion: {kind: 'converted'; bots: ConvertedBridgeBot[]}};
export interface ImporterDeps extends BridgeJournalPaths {
  homeDir: string; uid: number; platform: NodeJS.Platform; version: string;
  run: NonNullable<SourceInspectionOptions['command']>;
  registry: {
    ids(): Promise<string[]>;
    reserve(ids: string[], write: () => Promise<void>): Promise<void>;
    register(bot: ConvertedBridgeBot, txId: string, registrationId: string, handle: (handle: string) => Promise<void>): Promise<void>;
    unregister(entries: {appId: string; registrationId: string; handle?: string}[]): Promise<void>;
    activate(appId: string, enabled: boolean): Promise<void>;
  };
  secrets: {ids(): Promise<string[]>; create(id: string, bytes: Buffer, iv: Buffer): Promise<void>; remove(id: string, iv: Buffer): Promise<'removed' | 'absent' | 'foreign'>};
  locks: {acquire(appId: string, allowMissing?: boolean): Promise<void>; holder(appId: string): {pid: number; startedAt: number} | undefined; release(appId: string): void};
  runtime: {start(appId: string, fallbackCodex?: string): Promise<void>; stop(appId: string): Promise<void>; connection(appId: string): Promise<string>};
  resolveCodex(): Promise<string | null>;
  changed?(): void; now?(): number; sleep?(ms: number): Promise<void>;
  fault?(point: string): void | Promise<void>;
  move?: Pick<MoveFileDeps, 'rename' | 'copyToHandle' | 'unlink'>;
  timeoutMs?: number;
}
export interface BridgeImporter {
  detect(): Promise<BridgeImportReply>; preflight(): Promise<BridgeImportReply>; start(): Promise<BridgeImportReply>;
  status(): Promise<BridgeImportReply>; rollback(): Promise<BridgeImportReply>; recover(): Promise<void>; shutdown(): Promise<void>;
}
/** Test-only crash: leave durable intents exactly as a killed process would. Never constructed from env input. */
export class ImportCrashError extends Error {}
class ImportFailure extends Error {constructor(readonly code: string, message: string) {super(message);}}
const terminal = new Set(['done', 'rolled-back', 'rollback-failed', 'refused']);
const conversionNotes = (bots: ConvertedBridgeBot[]): ImportNote[] => bots.flatMap(bot => bot.notes.map(note => ({kind: note.kind, message: note.message, appId: note.appId, ...('chatId' in note ? {chatId: note.chatId} : {})})));
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const missing = (error: unknown): boolean => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');

export function createBridgeImporter(deps: ImporterDeps): BridgeImporter {
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeout = deps.timeoutMs ?? 30_000;
  let detection: BridgeDetection | null = null, preflight: BridgePreflight | null = null, view: BridgeImportView | null = null;
  let journal: BridgeImportJournal | undefined, work: Promise<void> | undefined, stopping = false, cancelled = false;
  const stagePath = (txId: string) => join(deps.appDir, 'import/bridge', txId);
  const backupPath = (txId: string) => join(deps.appDir, 'import/bridge/backups', txId);
  const botPath = (appId: string) => join(deps.appDir, 'bots', appId);
  const hookPath = (target: 'claude' | 'codex') => join(deps.homeDir, target === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
  function snapshot(): BridgeImportReply {return structuredClone({type: 'bridgeImport', detection, preflight, view});}
  function render(): void {
    if (!journal) return;
    view = {txId: journal.txId, step: journal.step === 'staged' ? 'staging' : journal.step,
      bots: journal.bots ?? journal.reservedAppIds.map(appId => ({appId, name: appId})), notes: journal.notes ?? [],
      ...(journal.error ? {error: journal.error} : {}), cleanupPending: journal.cleanupPending,
      canRollback: journal.step !== 'done' && (journal.outcome === null || journal.step === 'rollback-failed' || journal.cleanupPending)};
    deps.changed?.();
  }
  async function save(next: BridgeImportJournal): Promise<void> {await writeBridgeImportJournal(deps, next); journal = next; render();}
  async function step(next: BridgeImportJournal['step']): Promise<void> {
    if (stopping || cancelled) throw new ImportFailure('cancelled', '导入已停止，正在恢复原来的 Bridge。');
    await save({...journal!, step: next});
  }
  async function note(value: ImportNote): Promise<void> {await save({...journal!, notes: [...(journal!.notes ?? []), value]});}
  async function intent(action: BridgeImportIntent['action']): Promise<number> {
    const sequence = journal!.intents.length;
    await save({...journal!, intents: [...journal!.intents, {sequence, completed: false, action}]});
    await deps.fault?.(`before:${action.kind}`);
    return sequence;
  }
  async function complete(sequence: number): Promise<void> {
    await deps.fault?.(`crash-after:${journal!.intents[sequence]!.action.kind}`);
    await save({...journal!, intents: journal!.intents.map(item => item.sequence === sequence ? {...item, completed: true} : item)});
  }
  async function service(): Promise<BridgeServiceState> {
    const result = await deps.run('/bin/launchctl', ['print', `gui/${deps.uid}/ai.feishu-codex-bridge.bot`]);
    const state = parseBridgeServiceState(result);
    if (!state) throw new ImportFailure('service-unknown', '无法确认原 Bridge 后台服务的状态，请稍后重试。');
    return state;
  }
  async function waitService(loaded: boolean, running = false): Promise<void> {
    const until = now() + timeout;
    for (;;) {
      const state = await service();
      if (state.loaded === loaded && (!running || state.running)) return;
      if (now() >= until) throw new ImportFailure('service-timeout', '等待 Bridge 后台服务超时。');
      await sleep(200);
    }
  }
  async function bootout(): Promise<void> {
    const state = await service();
    if (!state.loaded) return;
    if (state.stopping) {await waitService(false); return;}
    const seq = await intent({kind: 'service', operation: 'bootout'});
    const result = await deps.run('/bin/launchctl', ['bootout', `gui/${deps.uid}/ai.feishu-codex-bridge.bot`]);
    if (result.status !== 0) {
      const current = await service();
      if (current.loaded && !current.stopping) throw new ImportFailure('stop-failed', '无法停止原 Bridge 后台服务。');
    }
    await waitService(false); await complete(seq);
  }
  async function detect(): Promise<BridgeImportReply> {
    try {
      if (deps.platform !== 'darwin') detection = {kind: 'unsupported-platform', message: '只有 macOS 支持从飞书 Codex Bridge 导入。'};
      else if (await readBridgeDone(deps.appDir, deps.bridgeDir)) detection = {kind: 'imported', message: '已从飞书 Codex Bridge 导入。'};
      else if (!(await lstat(deps.bridgeDir).catch(error => {if (missing(error)) return undefined; throw error;}))) detection = {kind: 'not-found', message: '没有发现飞书 Codex Bridge 数据。'};
      else if (!(await inspectLocalPath(deps.bridgeDir, deps.bridgeDir))?.isDirectory()) detection = {kind: 'invalid', message: 'Bridge 数据路径不是文件夹，请检查后重试。'};
      else if (await inspectLocalPath(deps.bridgeDir, join(deps.bridgeDir, 'bots.json'))) detection = {kind: 'found', message: '发现飞书 Codex Bridge，可以检查并导入原有 Bot。'};
      else if (await inspectLocalPath(deps.bridgeDir, join(deps.bridgeDir, 'processes.json')) || await inspectLocalPath(deps.bridgeDir, join(deps.bridgeDir, 'config.json'))) detection = {kind: 'upgrade-required', message: upgradeMessage};
      else detection = {kind: 'not-found', message: '没有发现可导入的 Bridge 数据。'};
    } catch {detection = {kind: 'invalid', message: '无法安全读取 Bridge 数据或导入记录，请检查文件权限。'};}
    return snapshot();
  }
  async function source(): Promise<ConvertedSnapshot> {
    const result = await readBridgeSnapshot({sourceDir: deps.bridgeDir, destinationSecretsGetter: join(deps.appDir, 'secrets-getter')});
    if (result.kind !== 'read' || result.issues.length || result.conversion.kind !== 'converted') throw new ImportFailure('source-invalid', '旧数据存在格式问题，无法完整导入所有 Bot。请先修复后重试。');
    return result as ConvertedSnapshot;
  }
  async function conflicts(ids: string[]): Promise<void> {
    const existing = await deps.registry.ids(), secrets = await deps.secrets.ids();
    for (const appId of ids) {
      if (existing.includes(appId) || secrets.includes(`app-${appId}`) || await inspectLocalPath(deps.appDir, botPath(appId))) throw new ImportFailure('destination-conflict', 'Vonvon 中已有相同 Bot 或对应数据。请处理冲突后重新检查。');
    }
  }
  async function check(): Promise<ConvertedSnapshot | undefined> {
    await detect();
    preflight = {canImport: false, bots: [], service: 'unknown', bundledCodex: 'unknown', problems: [], notes: []};
    const problem = (code: string, message: string, appId?: string) => preflight!.problems.push({code, message, ...(appId ? {appId} : {})});
    if (detection?.kind !== 'found') {problem(detection?.kind ?? 'unknown', detection?.message ?? '无法检查旧数据。'); return;}
    const report = await inspectBridgeSource({sourceDir: deps.bridgeDir, homeDir: deps.homeDir, platform: deps.platform, command: deps.run});
    if (report.kind !== 'inspected') {problem(report.kind, report.kind === 'upgrade-required' ? report.message : '无法读取完整的 Bridge 数据。'); return;}
    preflight.bots = structuredClone(report.bots) as BridgePreflight['bots']; preflight.service = report.service; preflight.bundledCodex = report.bundledCodex;
    if (!report.bots.length) problem('no-bots', '旧 Bridge 中没有可导入的 Bot。');
    if (report.service === 'unknown') problem('service-unknown', '无法确认 Bridge 是否正在运行。');
    for (const bot of report.bots) {
      if (!['decryptable', 'plaintext', 'external-reference'].includes(bot.secret)) problem('secret-unavailable', bot.secret === 'cannot-decrypt' ? '旧密钥无法解开；若改过主机名，请先在原 Bridge 重新扫码刷新这个 Bot。' : '这个 Bot 的凭据无法安全读取。', bot.appId);
      if (bot.problems.length) problem('bot-invalid', '这个 Bot 的旧配置或会话记录有问题。', bot.appId);
      if (bot.running === 'unknown') problem('process-unknown', '无法确认这个 Bot 的旧进程状态。', bot.appId);
      if (bot.running === 'running' && report.service === 'stopped') problem('manual-process', 'Bridge 正在终端里运行。先在那个终端按 Ctrl+C 停掉，再重试导入。', bot.appId);
      if (bot.directories.some(dir => dir.state !== 'present')) problem('workspace-missing', '部分原工作目录不存在或无法读取，请先恢复目录。', bot.appId);
    }
    let result: ConvertedSnapshot | undefined;
    try {
      await conflicts(report.bots.map(bot => bot.appId));
      result = await source(); preflight.notes = conversionNotes(result.conversion.bots);
      for (const target of ['claude', 'codex'] as const) {const bytes = await readBytes(hookPath(target)); if (bytes) removeBridgeHooks(bytes);}
      // A damaged prior transaction must be recovered before another transaction can reserve Bot IDs.
      const previous = await readBridgeImportJournal(deps);
      if (previous && (previous.outcome === null || previous.cleanupPending)) problem('recovery-pending', '上一次导入尚未恢复完成，请先重试回滚。');
    } catch (error) {problem(error instanceof ImportFailure ? error.code : 'preflight-failed', error instanceof ImportFailure ? error.message : '检查发现无法安全读取的数据，请检查旧配置、hook 和目标数据目录。');}
    preflight.canImport = preflight.problems.length === 0;
    return preflight.canImport ? result : undefined;
  }
  async function movePlist(from: 'original' | 'stage', to: 'stage' | 'original' | 'backup', hash: string) {
    // Resume the original allocation receipts in BOTH directions after a crash. A new intent would orphan a
    // partially copied reverse EXDEV file and incorrectly call the rollback clean.
    const previous = journal!.intents.find(item => item.action.kind === 'move-plist' && item.action.from === from && item.action.to === to && item.action.sha256 === hash);
    const seq = previous?.sequence ?? await intent({kind: 'move-plist', from, to, sha256: hash, allocations: []});
    return movePlistIntent(seq);
  }
  async function movePlistIntent(seq: number) {
    const action = journal!.intents[seq]!.action;
    if (action.kind !== 'move-plist') throw new Error('Invalid plist intent');
    const location = (value: 'original' | 'stage' | 'backup') => value === 'original' ? deps.plistFile : join(value === 'stage' ? journal!.stageDir : backupPath(journal!.txId), 'bridge.plist');
    await ensureDirectory(toParent(location(action.to)));
    const result = await moveFileSafely({src: location(action.from), dst: location(action.to), sha256: action.sha256, txId: journal!.txId,
      operation: {sequence: seq, from: action.from, to: action.to, allocations: action.allocations}}, {...deps.move,
      persistAllocation: async allocation => save(withBridgeMoveAllocation(journal!, allocation))});
    if (result.kind === 'moved') await complete(seq);
    return result;
  }
  async function stageFile(appId: string, relative: string, bytes: string | Buffer): Promise<void> {
    const seq = await intent({kind: 'write-file', appId, file: relative, sha256: sha256(bytes)});
    await publishFile(join(journal!.stageDir, 'bots', appId, relative), bytes, null); await complete(seq);
  }
  async function copyOutbound(appId: string): Promise<void> {
    const root = join(deps.bridgeDir, 'bots', appId); let count = 0, skipped = 0;
    async function walk(relative: string) {
      const entries = await readdir(join(root, relative), {withFileTypes: true});
      for (const entry of entries) {
        if (++count > 4096) throw new ImportFailure('copy-limit', '已发文件记录过多，导入已安全停止。');
        const file = join(relative, entry.name);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {skipped++; continue;}
        await inspectLocalPath(root, join(root, file));
        if (entry.isDirectory()) await walk(file);
        else {const bytes = await readBytes(join(root, file)); if (!bytes) throw new Error('Source disappeared'); await stageFile(appId, file, bytes);}
      }
    }
    await walk('outbound-files');
    if (skipped) await note({kind: 'skipped-files', appId, message: `已发文件记录中的 ${skipped} 个链接或特殊文件未复制。`});
  }
  async function stageSecret(bot: ConvertedBridgeBot, snapshot: ConvertedSnapshot): Promise<void> {
    if (bot.secret.kind === 'external') return;
    const iv = randomBytes(12), id = `app-${bot.appId}`, seq = await intent({kind: 'create-secret', appId: bot.appId, id, iv: iv.toString('hex')});
    let bytes: Buffer | undefined;
    try {
      if (bot.secret.kind === 'plaintext') {
        const raw = await readLocalText(deps.bridgeDir, join(deps.bridgeDir, 'bots', bot.appId, 'config.json'));
        const value = raw ? JSON.parse(raw) : undefined;
        if (value?.accounts?.app?.id !== bot.appId || typeof value.accounts.app.secret !== 'string' || !value.accounts.app.secret) throw new Error('Credential changed');
        bytes = Buffer.from(value.accounts.app.secret);
      } else {
        const key = await loadLegacyKeystoreKey(deps.bridgeDir);
        if (key.state !== 'ready') throw new Error('Legacy key unavailable');
        try {const envelope = snapshot.legacySecrets[bot.secret.id]; if (envelope) bytes = decryptLegacySecret(key.key, envelope);}
        finally {key.key.fill(0);}
      }
      if (!bytes) throw new ImportFailure('secret-decrypt', '旧凭据无法解开，已停止导入。');
      await deps.secrets.create(id, bytes, iv); await complete(seq);
    } finally {bytes?.fill(0); iv.fill(0);}
  }
  async function hooks(): Promise<void> {
    for (const target of ['claude', 'codex'] as const) {
      const path = hookPath(target), bytes = await readBytes(path);
      if (!bytes) continue;
      const converted = removeBridgeHooks(bytes);
      if (!converted.changed) continue;
      const backup = join(backupPath(journal!.txId), `${target}-hooks.json`);
      await publishFile(backup, bytes, null);
      const mode = (await lstat(path)).mode & 0o777;
      const seq = await intent({kind: 'hook', target, before: sha256(bytes), after: sha256(converted.bytes), mode});
      await publishFile(path, converted.bytes, sha256(bytes), mode); await complete(seq);
    }
    await note({kind: 'hook-backup', message: `原 hook 设置的备份保留在 ${backupPath(journal!.txId)}。`});
  }
  async function stopLateService(): Promise<void> {
    const bytes = await readBytes(deps.plistFile);
    if (bytes) {
      const seq = await intent({kind: 'late-plist', sha256: sha256(bytes)});
      await publishFile(join(backupPath(journal!.txId), 'bridge.plist.late'), bytes, null);
      if (!await removeOwnedFile(deps.plistFile, sha256(bytes))) throw new ImportFailure('service-changed', 'Bridge 在导入期间又被启动，请重试。');
      await complete(seq);
    }
    await bootout();
  }
  async function execute(initial: ConvertedSnapshot): Promise<void> {
    const ids = initial.identity.bots.map(bot => bot.appId);
    const plist = await readBytes(deps.plistFile), beforeService = await service();
    const holders = ids.map(appId => ({appId, pid: deps.locks.holder(appId)?.pid ?? null, startedAt: deps.locks.holder(appId)?.startedAt ?? null}));
    const txId = view!.txId;
    const first: BridgeImportJournal = {version: 1, txId, hostPid: process.pid, startedAt: now(), bridgeDir: deps.bridgeDir, plistFile: deps.plistFile, uid: deps.uid,
      reservedAppIds: ids, acquiredLocks: [], before: {plist: plist ? {present: true, sha256: sha256(plist)} : {present: false}, serviceLoaded: beforeService.loaded, holders},
      stageDir: stagePath(txId), stageIdentity: null, intents: [], step: 'stopping', cleanupPending: false, outcome: null,
      bots: initial.conversion.bots.map(bot => ({appId: bot.appId, name: bot.entry.botName ?? bot.entry.desiredName})), notes: conversionNotes(initial.conversion.bots)};
    await deps.registry.reserve(ids, async () => {await conflicts(ids); await save(first);});
    const stage = await intent({kind: 'stage-directory', appId: null});
    await mkdir(journal!.stageDir, {mode: 0o700});
    const stat = await lstat(journal!.stageDir); await syncDir(toParent(journal!.stageDir));
    await save({...journal!, stageIdentity: {dev: stat.dev, ino: stat.ino}}); await complete(stage);
    if (plist && (await movePlist('original', 'stage', sha256(plist))).kind !== 'moved') throw new ImportFailure('plist-conflict', '原 Bridge 启动配置发生变化，导入已停止。');
    await bootout(); await deps.fault?.('after-stop');
    await step('locking');
    for (const appId of ids) {
      const until = now() + timeout, before = holders.find(item => item.appId === appId)!;
      for (;;) {
        try {await deps.locks.acquire(appId); break;}
        catch (error) {
          if (!(error instanceof BridgeAlreadyRunningError)) throw error;
          const holder = deps.locks.holder(appId);
          if (!before.pid || holder?.pid !== before.pid || holder.startedAt !== before.startedAt) throw new ImportFailure('bridge-restarted', '导入期间有另一个 Bridge 进程启动，请先停止它。');
          if (now() >= until) throw new ImportFailure('lock-timeout', '旧 Bridge 尚未退出，无法安全接管。');
          await sleep(100);
        }
      }
      await save({...journal!, acquiredLocks: [...journal!.acquiredLocks, appId]});
    }
    if ((await service()).loaded) throw new ImportFailure('bridge-restarted', 'Bridge 后台服务在导入期间又被启动。');
    await deps.fault?.('after-lock'); await step('staging');
    const current = await source();
    if (JSON.stringify(current.identity.bots) !== JSON.stringify(initial.identity.bots)) throw new ImportFailure('source-changed', '导入期间 Bridge 的 Bot 列表变了，请重试。');
    await save({...journal!, notes: conversionNotes(current.conversion.bots)});
    for (const [index, bot] of current.conversion.bots.entries()) {
      const seq = await intent({kind: 'stage-directory', appId: bot.appId});
      await ensureDirectory(join(journal!.stageDir, 'bots', bot.appId)); await complete(seq);
      for (const [file, value] of [['config.json', bot.config], ['projects.json', bot.projects], ['sessions.json', bot.sessions]] as const) await stageFile(bot.appId, file, json(value));
      if (bot.commentInstructions !== null) await stageFile(bot.appId, 'comment-instructions.md', bot.commentInstructions);
      if (bot.copy.includes('outbound-files/**')) await copyOutbound(bot.appId);
      await stageFile(bot.appId, `.vonvon-import-${txId}`, '');
      await stageSecret(bot, current);
      if (index === 0) await deps.fault?.('during-copy');
    }
    await deps.fault?.('after-copy'); await step('codex');
    const codex = await deps.resolveCodex();
    const fallback = !codex && preflight?.bundledCodex === 'present' ? join(deps.bridgeDir, 'codex-cli/node_modules/.bin/codex') : undefined;
    await note({kind: 'codex', message: codex ? '继续使用本机已有的 Codex。' : fallback ? '使用原 Bridge 自带的 Codex。' : '没有找到 Codex，请到工具设置中安装；Claude 群不受影响。'});
    await step('hooks'); await hooks(); await deps.fault?.('after-hooks'); await step('moving');
    await ensureDirectory(join(deps.appDir, 'bots'));
    for (const bot of current.conversion.bots) {
      if ((await deps.registry.ids()).includes(bot.appId) || await inspectLocalPath(deps.appDir, botPath(bot.appId))) throw new ImportFailure('destination-conflict', '目标 Bot 数据在导入期间发生变化。');
      const seq = await intent({kind: 'move-bot', appId: bot.appId});
      await rename(join(journal!.stageDir, 'bots', bot.appId), botPath(bot.appId)); await syncDir(join(deps.appDir, 'bots')); await complete(seq);
      const registrationId = randomUUID(), registration = await intent({kind: 'register-bot', appId: bot.appId, registrationId});
      await deps.registry.register(bot, txId, registrationId, async handle => {
        const item = journal!.intents[registration]!;
        if (item.action.kind !== 'register-bot') throw new Error('Invalid registration intent');
        await save({...journal!, intents: journal!.intents.map(row => row.sequence === registration ? {...item, action: {...item.action, handle}} : row)});
      });
      await complete(registration); await deps.registry.activate(bot.appId, bot.entry.active);
      if (!bot.entry.active) await note({kind: 'inactive-bot', appId: bot.appId, message: '这个 Bot 在原 Bridge 中未启用，导入后保持未启用。'});
    }
    await deps.fault?.('after-move'); await step('starting');
    const active = current.conversion.bots.filter(bot => bot.entry.active);
    for (const [index, bot] of active.entries()) {
      const seq = await intent({kind: 'start-bot', appId: bot.appId});
      await deps.runtime.start(bot.appId, fallback); await complete(seq);
      if (index === 0) await deps.fault?.('during-start');
    }
    await Promise.all(active.map(async bot => {
      const until = now() + (deps.timeoutMs ?? 60_000);
      for (;;) {
        if (stopping || cancelled) throw new ImportFailure('cancelled', '导入已停止。');
        if (await deps.runtime.connection(bot.appId) === 'connected') return;
        if (now() >= until) throw new ImportFailure('connection-timeout', '导入的 Bot 没有全部连上飞书，正在恢复原 Bridge。');
        await sleep(1000);
      }
    }));
    await step('finishing'); await stopLateService(); await deps.fault?.('before-marker');
    const bridgeMarker = json({version: 1, migratedAt: now(), bots: ids, vonvonVersion: deps.version});
    const marker = await intent({kind: 'marker', target: 'bridge', sha256: sha256(bridgeMarker)});
    await publishFile(join(deps.bridgeDir, 'vonvon-migration.json'), bridgeMarker, null); await complete(marker); await deps.fault?.('after-bridge-marker');
    await note({kind: 'keep-source', message: '旧目录不要删，空白项目还在里面。旧会话续接需要保留原目录和 CODEX_HOME。'});
    const done = json({version: 1, txId, at: now(), bridgeDir: deps.bridgeDir, bots: ids}), commit = await intent({kind: 'marker', target: 'done', sha256: sha256(done)});
    await publishFile(join(deps.appDir, 'import/bridge/done.json'), done, null); await complete(commit);
    await save({...journal!, step: 'done', outcome: 'done', cleanupPending: false});
    detection = {kind: 'imported', message: '已从飞书 Codex Bridge 导入。'};
    // Keep the plist and hook backups for the receipt. The former workspace is never removed.
    if (plist) await movePlist('stage', 'backup', sha256(plist));
  }
  async function rollbackJournal(): Promise<void> {
    if (!journal) return;
    // The durable destination marker alone decides commitment, even if the last journal write was interrupted.
    const committed = await readBridgeDone(deps.appDir, deps.bridgeDir);
    if (committed) {
      if (committed.txId !== journal.txId) throw new Error('Migration commit ownership conflict');
      await save({...journal, step: 'done', outcome: 'done', cleanupPending: false}); return;
    }
    if (journal.outcome === 'done') throw new Error('Committed migration marker is missing');
    await save({...journal, step: 'rolling-back', outcome: null, cleanupPending: true});
    let failed = false;
    const recordFailure = async (message: string) => {failed = true; await note({kind: 'recovery-warning', message});};
    const actions = () => journal!.intents.map(item => item.action);
    for (const action of actions()) if (action.kind === 'marker' && action.target === 'bridge') {
      if (!await removeOwnedFile(join(deps.bridgeDir, 'vonvon-migration.json'), action.sha256)) await recordFailure('Bridge 的迁移标记被修改，未删除。');
    }
    // If a child may still be using the new data, keep every Bridge lock and do not restore the old service.
    try {
      for (const action of actions()) if (action.kind === 'start-bot') await deps.runtime.stop(action.appId);
      const entries = actions().filter((action): action is Extract<BridgeImportIntent['action'], {kind: 'register-bot'}> => action.kind === 'register-bot');
      if (entries.length) await deps.registry.unregister(entries);
      for (const action of actions().reverse()) if (action.kind === 'move-bot') {
        const dest = botPath(action.appId), source = join(journal.stageDir, 'bots', action.appId);
        if (!await inspectLocalPath(deps.appDir, dest)) continue;
        const marker = await readBytes(join(dest, `.vonvon-import-${journal.txId}`));
        if (marker === undefined || marker.length !== 0) throw new Error('Imported Bot directory ownership changed');
        if (await inspectLocalPath(deps.appDir, source)) throw new Error('Imported stage directory conflict');
        await ensureDirectory(toParent(source)); await rename(dest, source); await syncDir(toParent(dest)); await syncDir(toParent(source));
      }
    } catch {
      await note({kind: 'recovery-warning', message: '导入的 Bot 尚未安全停止，或数据被其他进程改动。为避免两个服务同时运行，尚未恢复 Bridge；请重试回滚。'});
      await save({...journal!, step: 'rollback-failed', outcome: 'rollback-failed', cleanupPending: true}); return;
    }
    for (const action of actions().reverse()) if (action.kind === 'hook') {
      try {
        const path = hookPath(action.target), bytes = await readBytes(path), backup = await readBytes(join(backupPath(journal.txId), `${action.target}-hooks.json`));
        if (bytes && sha256(bytes) === action.before) continue;
        if (bytes && sha256(bytes) === action.after && backup && sha256(backup) === action.before) await publishFile(path, backup, action.after, action.mode);
        else await note({kind: 'hook-changed', message: `${action.target} 的 hook 设置后来被改过，未覆盖；原件在 ${backupPath(journal.txId)}。`});
      } catch {await recordFailure('原 hook 设置未能恢复，备份已保留，请重试回滚。');}
    }
    for (const appId of journal.acquiredLocks) deps.locks.release(appId);
    // A crash between acquire and journal receipt can leave a held lock in this process too.
    for (const appId of journal.reservedAppIds) deps.locks.release(appId);
    let serviceFailed = false;
    try {
      if (journal.before.plist.present) {
        // Resume any interrupted forward EXDEV move first. This recognizes its reserved temporary inode.
        const forward = journal.intents.find(item => item.action.kind === 'move-plist' && item.action.from === 'original' && item.action.to === 'stage');
        if (forward) {
          const current = await readBytes(deps.plistFile), staged = await readBytes(join(journal.stageDir, 'bridge.plist'));
          if (!staged && current && sha256(current) === journal.before.plist.sha256) {
            const action = forward.action;
            if (action.kind === 'move-plist' && action.allocations.length) await movePlistIntent(forward.sequence);
          }
        }
        const result = await movePlist('stage', 'original', journal.before.plist.sha256);
        if (result.kind === 'conflict') {
          const preserved = await movePlist('stage', 'backup', journal.before.plist.sha256);
          if (preserved.kind !== 'moved') throw new Error('Cannot preserve original plist');
          await note({kind: 'plist-changed', message: `Bridge 的启动配置被修改，保留现在的配置；原件在 ${backupPath(journal.txId)}。`});
        } else if (result.kind === 'missing') throw new Error('Original plist unavailable');
      }
      if (journal.before.serviceLoaded) {
        // A previous bootout may still be finishing when recovery begins. Wait for it to unload before
        // bootstrapping the restored plist; waiting for that dying job to run again can never succeed.
        let current = await service();
        if (current.stopping) {await waitService(false); current = await service();}
        if (!current.loaded) {
          if (!await readBytes(deps.plistFile)) throw new Error('Missing service definition');
          const seq = await intent({kind: 'service', operation: 'bootstrap'});
          const result = await deps.run('/bin/launchctl', ['bootstrap', `gui/${deps.uid}`, deps.plistFile]);
          if (result.status !== 0 && !(await service()).loaded) throw new Error('Bootstrap failed');
          await waitService(true, true); await complete(seq);
        } else await waitService(true, true);
      }
    } catch {serviceFailed = true; await recordFailure('Bridge 没能重新启动。请重试回滚，或在终端运行 feishu-codex-bridge start。');}
    let cleanupPending = serviceFailed || failed;
    for (const action of actions()) if (action.kind === 'create-secret') {
      try {
        const result = await deps.secrets.remove(action.id, Buffer.from(action.iv, 'hex'));
        if (result === 'foreign') await note({kind: 'secret-changed', appId: action.appId, message: '这条新凭据后来被修改，未删除。'});
      } catch {cleanupPending = true; await recordFailure('导入创建的凭据尚未清理完成。');}
    }
    try {
      const stage = await inspectLocalPath(deps.appDir, journal.stageDir);
      if (stage) {
        if (!ownsBridgeImportStage(journal, stage) || await inspectLocalPath(deps.appDir, join(journal.stageDir, 'bridge.plist'))) throw new Error('Stage still owns original data');
        // Narrow deletion: UUID path + durable inode, after all original files are restored/backed up.
        await rm(journal.stageDir, {recursive: true}); await syncDir(toParent(journal.stageDir));
      }
    } catch {cleanupPending = true; await recordFailure('导入暂存数据尚未清理完成，已保留以便恢复。');}
    await save({...journal, step: failed ? 'rollback-failed' : 'rolled-back', outcome: failed ? 'rollback-failed' : 'rolled-back', cleanupPending});
  }
  async function hydrate(): Promise<void> {
    if (work || view) return;
    const saved = await readBridgeImportJournal(deps);
    if (saved) {journal = saved; render();}
  }
  async function recover(): Promise<void> {
    try {
      await hydrate();
      if (!journal) return;
      const done = await readBridgeDone(deps.appDir, deps.bridgeDir);
      if (done) {
        if (done.txId !== journal.txId) throw new Error('Commit ownership conflict');
        if (journal.step !== 'done') await save({...journal, step: 'done', outcome: 'done', cleanupPending: false});
        return;
      }
      if (journal.outcome === null || journal.cleanupPending || journal.outcome === 'rollback-failed') {
        await save({...journal, error: {code: 'interrupted', message: '上一次导入中途退出，正在恢复原 Bridge。'}});
        await rollbackJournal();
      }
    } catch {
      view = {txId: journal?.txId ?? '', step: 'rollback-failed', bots: journal?.bots ?? [], notes: journal?.notes ?? [],
        cleanupPending: true, canRollback: false, error: {code: 'recovery-unreadable', message: '无法安全读取或恢复导入记录。数据保持原样，请检查文件权限与导入备份。'}};
      deps.changed?.();
    }
  }
  async function failed(error: unknown, txId: string): Promise<void> {
    if (error instanceof ImportCrashError) throw error;
    const safe = error instanceof ImportFailure ? {code: error.code, message: error.message} : {code: 'import-failed', message: '导入未完成，正在恢复原来的 Bridge；原数据会保留。'};
    if (journal?.txId === txId) {
      try {
        const done = await readBridgeDone(deps.appDir, deps.bridgeDir);
        if (done?.txId === txId) {await save({...journal, step: 'done', outcome: 'done', cleanupPending: false}); return;}
        await save({...journal, error: safe}); await rollbackJournal();
      } catch {
        view = {txId, step: 'rollback-failed', bots: journal.bots ?? [], notes: journal.notes ?? [], cleanupPending: true, canRollback: true,
          error: {code: 'rollback-incomplete', message: '恢复尚未完成，原数据与备份已保留，请重试回滚。'}};
      }
    } else view = {txId, step: 'refused', bots: [], notes: [], cleanupPending: false, canRollback: false, error: safe};
    deps.changed?.();
  }
  async function start(): Promise<BridgeImportReply> {
    if (work || stopping) return snapshot();
    const txId = randomUUID(); cancelled = false;
    view = {txId, step: 'checking', bots: [], notes: [], cleanupPending: false, canRollback: false}; deps.changed?.();
    work = Promise.resolve().then(async () => {
      const initial = await check();
      if (!initial) throw new ImportFailure('preflight-refused', preflight?.problems.map(item => item.message).join('；') || '预检未通过。');
      await execute(initial);
    }).catch(error => failed(error, txId)).finally(() => {work = undefined; deps.changed?.();});
    // A test crash deliberately rejects; contain the background rejection while status/recovery keep durable evidence.
    void work.catch(() => undefined);
    return snapshot();
  }
  return {
    detect: async () => {await hydrate().catch(() => undefined); return detect();},
    preflight: async () => {if (!work) await check(); return snapshot();},
    start,
    status: async () => {await hydrate().catch(() => undefined); return snapshot();},
    rollback: async () => {
      if (work) {cancelled = true; return snapshot();}
      await hydrate();
      if (!journal || journal.step === 'done') return snapshot();
      work = rollbackJournal().catch(error => failed(error, journal!.txId)).finally(() => {work = undefined;});
      void work.catch(() => undefined); return snapshot();
    },
    recover,
    shutdown: async () => {stopping = true; cancelled = true; await work;},
  };
}
function toParent(path: string): string {return path.slice(0, path.lastIndexOf('/')) || '/';}
