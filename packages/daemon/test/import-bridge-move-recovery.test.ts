import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, expect, it } from 'vitest';
import { readBridgeImportJournal, writeBridgeImportJournal, type BridgeImportJournal } from '../src/import/bridge/journal';

const roots: string[] = [];
const children = new Set<ChildProcess>();
const bytes = 'synthetic complete plist for cross-process recovery\n';
const sha256 = createHash('sha256').update(bytes).digest('hex');
afterEach(async () => {
  await Promise.all([...children].map(child => new Promise<void>(resolve => {
    child.once('close', () => resolve());
    child.kill('SIGKILL');
  })));
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const childSource = `
import { rename } from 'node:fs/promises';
import { moveFileSafely } from './move-file';
import { readBridgeImportJournal, writeBridgeImportJournal, withBridgeMoveAllocation } from './journal';
const [mode, raw] = process.argv.slice(2), input = JSON.parse(raw);
let journal = await readBridgeImportJournal(input.paths);
if (!journal) throw new Error('Missing transaction journal');
const action = journal.intents[0]?.action;
if (action?.kind !== 'move-plist') throw new Error('Missing move action');
const pause = async () => {
  process.stdout.write('INTERRUPT_READY\\n');
  await new Promise(() => { setInterval(() => undefined, 1000); });
};
const result = await moveFileSafely({ src: input.src, dst: input.dst, sha256: action.sha256, txId: journal.txId,
  operation: { sequence: 0, from: action.from, to: action.to, allocations: action.allocations },
}, {
  rename: async (from, to) => {
    if (from === input.src) throw Object.assign(new Error('controlled EXDEV'), { code: 'EXDEV' });
    await rename(from, to);
  },
  persistAllocation: async allocation => {
    journal = withBridgeMoveAllocation(journal, allocation);
    await writeBridgeImportJournal(input.paths, journal);
  },
  ...(mode === 'partial' ? { copyToHandle: async (source, target) => {
    await target.writeFile((await source.readFile()).subarray(0, 7));
    await target.sync();
    await pause();
  } } : {}),
  fault: async point => {
    if ((mode === 'empty' && point === 'after-temporary-create')
      || (mode === 'publish' && point === 'crash-after:exdev-publish')) await pause();
  },
});
process.stdout.write(JSON.stringify(result) + '\\n');
`;
async function fixture(reverse: boolean) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'bridge-move-recovery-')); roots.push(root);
  const paths = { appDir: join(root, 'app'), bridgeDir: join(root, 'source'), plistFile: join(root, 'launch/bridge.plist') };
  const txId = '11111111-1111-4111-8111-111111111111', stageDir = join(paths.appDir, 'import/bridge', txId);
  await mkdir(dirname(paths.plistFile)); await mkdir(paths.bridgeDir);
  const journal: BridgeImportJournal = {
    version: 1, txId, hostPid: process.pid, startedAt: 1, uid: 501, bridgeDir: paths.bridgeDir, plistFile: paths.plistFile,
    reservedAppIds: ['fake_bot'], acquiredLocks: [], before: { plist: { present: true, sha256 }, serviceLoaded: false,
      holders: [{ appId: 'fake_bot', pid: null, startedAt: null }] }, stageDir, stageIdentity: null,
    intents: [{ sequence: 0, completed: false, action: { kind: 'move-plist', from: reverse ? 'stage' : 'original',
      to: reverse ? 'original' : 'stage', sha256, allocations: [] } }], step: 'stopping', cleanupPending: false, outcome: null,
  };
  await writeBridgeImportJournal(paths, journal); await mkdir(stageDir);
  const src = reverse ? join(stageDir, 'bridge.plist') : paths.plistFile;
  const dst = reverse ? paths.plistFile : join(stageDir, 'bridge.plist'); await writeFile(src, bytes);
  const executable = join(root, 'child.mjs');
  await build({ stdin: { contents: childSource, resolveDir: fileURLToPath(new URL('../src/import/bridge/', import.meta.url)), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: executable });
  return { root, paths, src, dst, txId, executable };
}
function run(executable: string, mode: string, input: unknown) {
  const child = spawn(process.execPath, [executable, mode, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  let output = '', errors = '';
  let notify: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { notify = resolve; });
  child.stdout?.on('data', data => { output += data; if (output.includes('INTERRUPT_READY\n')) notify(); });
  child.stderr?.on('data', data => { errors += data; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; errors: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, output, errors }); });
  });
  return { child, ready, exit };
}
it.each([
  ['partial', false], ['partial', true], ['empty', false], ['empty', true], ['publish', false], ['publish', true],
] as const)('real SIGKILL at %s converges in a new process, reverse=%s', async (mode, reverse) => {
  const fixtureData = await fixture(reverse), { paths, src, dst, executable, txId } = fixtureData;
  const interrupted = run(executable, mode, { paths, src, dst });
  await Promise.race([interrupted.ready, interrupted.exit.then(result => { throw new Error(JSON.stringify(result)); })]);
  interrupted.child.kill('SIGKILL'); expect((await interrupted.exit).signal).toBe('SIGKILL');
  const interruptedJournal = await readBridgeImportJournal(paths), action = interruptedJournal?.intents[0]?.action;
  if (action?.kind !== 'move-plist' || !action.allocations[0]) throw new Error('Missing durable allocation');
  const allocation = action.allocations[0];
  expect(allocation.inode === null).toBe(mode === 'empty');
  const temporary = join(dirname(dst), `.bridge.plist.vonvon-${txId}-0-${allocation.nonce}.tmp`);
  expect(await readFile(src, 'utf8')).toBe(bytes);
  if (mode === 'publish') {
    expect(await readFile(dst, 'utf8')).toBe(bytes);
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    expect(await readFile(temporary, 'utf8')).toBe(mode === 'partial' ? bytes.slice(0, 7) : '');
    await expect(readFile(dst)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  const recovered = await run(executable, 'recover', { paths, src, dst }).exit;
  expect(recovered).toMatchObject({ code: 0, signal: null, errors: '' }); expect(JSON.parse(recovered.output)).toEqual({ kind: 'moved' });
  await expect(readFile(src)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readFile(dst, 'utf8')).toBe(bytes);
  expect(createHash('sha256').update(await readFile(dst)).digest('hex')).toBe(sha256);
  expect(await readdir(dirname(dst))).toEqual(['bridge.plist']);
  const journalFile = join(paths.appDir, 'import/bridge/journal.json'), finalBytes = await readFile(journalFile);
  const finalJournal = await readBridgeImportJournal(paths), finalAction = finalJournal?.intents[0]?.action;
  if (finalAction?.kind !== 'move-plist') throw new Error('Missing recovered journal');
  expect(finalAction.allocations[0]?.nonce).toBe(allocation.nonce); expect(finalAction.allocations[0]?.inode).not.toBeNull();
  expect(finalJournal?.txId).toBe(txId); expect(finalJournal?.intents[0]?.completed).toBe(false);
  const retried = await run(executable, 'recover', { paths, src, dst }).exit;
  expect(retried.code).toBe(0); expect(JSON.parse(retried.output)).toEqual({ kind: 'moved' });
  expect(await readFile(journalFile)).toEqual(finalBytes); expect(await readFile(dst, 'utf8')).toBe(bytes);
});
