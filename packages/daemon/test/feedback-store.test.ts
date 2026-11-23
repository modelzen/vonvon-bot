import {execFileSync, spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {FileFeedbackStore} from '../src/feedback/store.js';
import {feedbackDraftSchema, type FeedbackAttachment, type FeedbackDraft, type FeedbackOperation} from '../src/feedback/types.js';

let scratch: string;
let root: string;
let store: FileFeedbackStore;
const children = new Set<ChildProcess>();
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'feedback-store-')));
  root = join(scratch, 'private');
  store = new FileFeedbackStore(root);
});
afterEach(async () => {
  await Promise.all([...children].map(async child => {
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }));
  children.clear();
  await rm(scratch, {recursive: true, force: true});
});

function draft(operationId = randomUUID(), attachments: FeedbackAttachment[] = []): FeedbackDraft {
  return feedbackDraftSchema.parse({
    operationId, trackingCode: 'VV-0123456789ABCDEF', createdAt: 1000, expiresAt: 86401000,
    actor: {botId: 'bot-1', appId: 'cli_feedback', tenantKey: 'tenant-1', openId: 'ou_author', chatId: 'oc_feedback', messageId: 'message-1'},
    accountName: '同名用户', destination: {baseToken: 'baseToken', tableId: 'tblFeedback', shareToken: 'shrFeedback'},
    summary: {kind: 'bug', title: '图片发送失败', description: '选择截图后无法发送。'},
    attachments, digest: 'a'.repeat(64),
  });
}

async function selectedFile(name: string, content = 'user selected image'): Promise<string> {
  const path = join(scratch, name);
  await writeFile(path, content);
  return path;
}

async function sparseFile(name: string, bytes: number): Promise<string> {
  const path = await selectedFile(name, '');
  await truncate(path, bytes);
  return path;
}

function attachmentPath(operationId: string, attachment: FeedbackAttachment): string {
  return join(store.directory(operationId), ...attachment.relativePath.split('/'));
}

describe('FileFeedbackStore private attachment snapshots', () => {
  it('copies only explicitly selected files, preserves readable names, and isolates equal names', async () => {
    const operationId = randomUUID();
    const chosen = await selectedFile('操作截图.png', 'screenshot');
    await selectedFile('private-session.log', 'not selected');
    const otherDirectory = join(scratch, 'other');
    await mkdir(otherDirectory);
    const sameName = join(otherDirectory, '操作截图.png');
    await writeFile(sameName, 'another screenshot');

    const staged = await store.stage(operationId, [chosen, sameName]);
    expect(staged.map(file => file.filename)).toEqual(['操作截图.png', '操作截图.png']);
    expect(new Set(staged.map(file => file.relativePath)).size).toBe(2);
    expect(await readdir(store.directory(operationId))).toEqual(['attachments']);
    const snapshots = await Promise.all(staged.map(async file => {
      expect(file.relativePath).toMatch(/^attachments\/[a-f0-9-]{36}\/操作截图\.png$/);
      const bytes = await readFile(attachmentPath(operationId, file));
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      return bytes.toString();
    }));
    expect(snapshots).toEqual(['screenshot', 'another screenshot']);
  });

  it('keeps the reviewed snapshot when the original is changed or deleted', async () => {
    const operationId = randomUUID();
    const original = await selectedFile('截图.png', 'reviewed bytes');
    const attachments = await store.stage(operationId, [original]);
    await writeFile(original, 'changed after review');
    await rm(original);
    await expect(store.verify(draft(operationId, attachments))).resolves.toBeUndefined();
    for (const attachment of attachments) expect(await readFile(attachmentPath(operationId, attachment), 'utf8')).toBe('reviewed bytes');
  });

  it('detects same-size tampering with a staged snapshot', async () => {
    const operationId = randomUUID();
    const attachments = await store.stage(operationId, [await selectedFile('截图.png', 'before')]);
    for (const attachment of attachments) await writeFile(attachmentPath(operationId, attachment), 'after!');
    await expect(store.verify(draft(operationId, attachments))).rejects.toThrow(/附件/);
  });

  it('creates private directories and files even under a previously permissive root', async () => {
    await mkdir(root, {mode: 0o777});
    await chmod(root, 0o777);
    const operationId = randomUUID();
    const attachments = await store.stage(operationId, [await selectedFile('截图.png')]);
    await store.create({state: 'prepared', draft: draft(operationId, attachments)});
    if (process.platform === 'win32') return;
    for (const directory of [root, store.directory(operationId), join(store.directory(operationId), 'attachments')]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    for (const path of [join(store.directory(operationId), 'operation.json'), ...attachments.map(file => attachmentPath(operationId, file))]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it('accepts the per-file size boundary and rejects oversized or empty files', async () => {
    const max = 20 * 1024 * 1024;
    const accepted = await store.stage(randomUUID(), [await sparseFile('boundary.png', max)]);
    expect(accepted.map(file => file.bytes)).toEqual([max]);
    await expect(store.stage(randomUUID(), [await sparseFile('too-large.png', max + 1)])).rejects.toThrow(/20 MB/);
    await expect(store.stage(randomUUID(), [await selectedFile('empty.png', '')])).rejects.toThrow(/普通附件/);
  });

  it('limits both attachment count and total bytes', async () => {
    const file = await selectedFile('chosen.png');
    await expect(store.stage(randomUUID(), Array.from({length: 7}, () => file))).rejects.toThrow(/6 个/);
    expect(await store.stage(randomUUID(), Array.from({length: 6}, () => file))).toHaveLength(6);
    const max = await sparseFile('20mb.png', 20 * 1024 * 1024);
    const extra = await selectedFile('extra.txt', 'x');
    await expect(store.stage(randomUUID(), [max, max, extra])).rejects.toThrow(/40 MB/);
  });

  it('rejects directories, relative selections, and operation path traversal', async () => {
    await expect(store.stage(randomUUID(), [scratch])).rejects.toThrow(/普通附件/);
    await expect(store.stage(randomUUID(), ['relative.png'])).rejects.toThrow(/明确选中/);
    expect(() => new FileFeedbackStore('relative-root')).toThrow(/绝对目录/);
    expect(() => store.directory('../outside')).toThrow();
    await expect(store.stage('../outside', [])).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('rejects a real FIFO with no writer without blocking a worker', async () => {
    const pipe = join(scratch, 'no-writer.pipe');
    execFileSync('mkfifo', [pipe]);
    const bundle = join(scratch, 'fifo-store.cjs');
    await build({entryPoints: [fileURLToPath(new URL('../src/feedback/store.ts', import.meta.url))], outfile: bundle,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent'});
    const result = spawnSync(process.execPath, ['-e', `
      const {FileFeedbackStore}=require(process.argv[1]);
      new FileFeedbackStore(process.argv[2]).stage(process.argv[3],[process.argv[4]]).then(
        ()=>{process.stderr.write('FIFO was accepted');process.exitCode=1},
        error=>process.stdout.write(error.message)
      );`, bundle, root, randomUUID(), pipe], {encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL'});
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/普通附件文件/);
  });

  it.each(['relative', 'missing', 'empty', 'oversized'])('removes only the newly created operation when a later attachment is invalid: %s', async invalid => {
    const operationId = randomUUID();
    const selected = await selectedFile('private-screenshot.png', 'selected private screenshot');
    let second = 'relative.png';
    if (invalid === 'missing') second = join(scratch, 'missing.png');
    if (invalid === 'empty') second = await selectedFile('empty.png', '');
    if (invalid === 'oversized') second = await sparseFile('oversized.png', 20 * 1024 * 1024 + 1);
    await expect(store.stage(operationId, [selected, second])).rejects.toThrow();
    await expect(lstat(store.directory(operationId))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readdir(root)).toEqual([]);
    expect(await readFile(selected, 'utf8')).toBe('selected private screenshot');
    expect(await store.stage(operationId, [selected])).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('rejects a selected symbolic link and symbolic links replacing staged files', async () => {
    const target = await selectedFile('target.png');
    const link = join(scratch, 'link.png');
    await symlink(target, link);
    await expect(store.stage(randomUUID(), [link])).rejects.toThrow();
    const operationId = randomUUID();
    const attachments = await store.stage(operationId, [target]);
    for (const file of attachments) {
      const staged = attachmentPath(operationId, file);
      await rm(staged);
      await symlink(target, staged);
    }
    await expect(store.verify(draft(operationId, attachments))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link storage root without writing through it', async () => {
    const outside = join(scratch, 'outside');
    await mkdir(outside);
    await symlink(outside, root);
    await expect(store.stage(randomUUID(), [])).rejects.toThrow(/目录/);
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects a symbolic link replacing the staged attachment directory', async () => {
    const operationId = randomUUID();
    const attachments = await store.stage(operationId, [await selectedFile('截图.png', 'reviewed bytes')]);
    const outside = join(scratch, 'outside-attachments');
    await mkdir(outside);
    await writeFile(join(outside, '截图.png'), 'reviewed bytes');
    for (const file of attachments) {
      const directory = dirname(attachmentPath(operationId, file));
      await rm(directory, {recursive: true});
      await symlink(outside, directory);
    }
    await expect(store.verify(draft(operationId, attachments))).rejects.toThrow();
  });

  it('rejects attachment traversal even when outside bytes match the reviewed digest', async () => {
    const operationId = randomUUID();
    const outside = await selectedFile('outside.png', 'matching bytes');
    await store.stage(operationId, []);
    const bytes = await readFile(outside);
    const malformed: FeedbackDraft = {...draft(operationId), attachments: [{
      filename: 'outside.png', relativePath: '../../outside.png', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }]};
    await expect(store.verify(malformed)).rejects.toThrow();
  });
});

describe('FileFeedbackStore persisted operations', () => {
  it('round trips state while refusing to create over an existing operation', async () => {
    const original: FeedbackOperation = {state: 'prepared', draft: draft()};
    await store.stage(original.draft.operationId, []);
    await store.create(original);
    const second = new FileFeedbackStore(root);
    await expect(second.read(original.draft.operationId)).resolves.toEqual(original);
    await expect(second.create({state: 'cancelled', draft: original.draft})).rejects.toThrow(/不能覆盖/);
    await expect(second.read(original.draft.operationId)).resolves.toEqual(original);
    await second.write({state: 'sending', draft: original.draft, sentAt: 2000});
    await expect(store.read(original.draft.operationId)).resolves.toMatchObject({state: 'sending', sentAt: 2000});
  });

  it('refuses a record whose internal operation ID belongs to another operation', async () => {
    const operationId = randomUUID();
    await store.stage(operationId, []);
    await writeFile(join(store.directory(operationId), 'operation.json'), JSON.stringify({state: 'prepared', draft: draft()}));
    await expect(store.read(operationId)).rejects.toThrow(/不匹配/);
  });

  it('rejects malformed and oversized persisted operation files', async () => {
    const operationId = randomUUID();
    await store.stage(operationId, []);
    const path = join(store.directory(operationId), 'operation.json');
    await writeFile(path, JSON.stringify({state: 'submitted', draft: draft(operationId)}));
    await expect(store.read(operationId)).rejects.toThrow();
    await writeFile(path, ' '.repeat(200001));
    await expect(store.read(operationId)).rejects.toThrow(/无效/);
  });

  it.skipIf(process.platform === 'win32')('rejects a symbolic link replacing the persisted operation file', async () => {
    const operation = {state: 'prepared', draft: draft()} satisfies FeedbackOperation;
    await store.stage(operation.draft.operationId, []);
    const outside = await selectedFile('outside-operation.json', JSON.stringify(operation));
    await symlink(outside, join(store.directory(operation.draft.operationId), 'operation.json'));
    await expect(store.read(operation.draft.operationId)).rejects.toThrow(/无效/);
  });

  it('never removes or overwrites an existing operation when a stage collides with its UUID', async () => {
    const operationId = randomUUID();
    const attachments = await store.stage(operationId, [await selectedFile('original.png', 'original')]);
    const original: FeedbackOperation = {state: 'prepared', draft: draft(operationId, attachments)};
    await store.create(original);
    const ledgerPath = join(store.directory(operationId), 'operation.json');
    const ledger = await readFile(ledgerPath, 'utf8');
    await expect(store.stage(operationId, [await selectedFile('new.png', 'new'), 'relative.png'])).rejects.toThrow();
    expect(await readFile(ledgerPath, 'utf8')).toBe(ledger);
    await expect(store.read(operationId)).resolves.toEqual(original);
    await expect(store.verify(original.draft)).resolves.toBeUndefined();
    for (const file of attachments) expect(await readFile(attachmentPath(operationId, file), 'utf8')).toBe('original');
  });

  it('releases the lock when a critical section fails', async () => {
    const operationId = randomUUID();
    await expect(store.exclusive(operationId, async () => {throw new Error('operation failed');})).rejects.toThrow('operation failed');
    await expect(new FileFeedbackStore(root).exclusive(operationId, async () => 'recovered')).resolves.toBe('recovered');
  });

  it('serializes two independent processes editing the same operation', async () => {
    const bundle = join(scratch, 'feedback-store.cjs');
    await build({entryPoints: [fileURLToPath(new URL('../src/feedback/store.ts', import.meta.url))], outfile: bundle,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent'});
    const operationId = randomUUID();
    await store.create({state: 'prepared', draft: draft(operationId)});
    const counterPath = join(store.directory(operationId), 'counter.txt');
    await writeFile(counterPath, '0');
    const startWhenReady: Array<() => void> = [];
    const worker = (label: string): Promise<{code: number | null; stderr: string}> => {
      const source = `
        const {FileFeedbackStore}=require(process.argv[1]);
        const fs=require('node:fs/promises');
        const path=require('node:path');
        const store=new FileFeedbackStore(process.argv[2]);
        process.stdout.write('ready');
        process.stdin.once('data',()=>{
          store.exclusive(process.argv[3],async()=>{
            const dir=store.directory(process.argv[3]);
            await fs.appendFile(path.join(dir,'sequence.txt'),'begin '+process.argv[4]+'\\n');
            const current=Number(await fs.readFile(path.join(dir,'counter.txt'),'utf8'));
            await new Promise(resolve=>setTimeout(resolve,60));
            await fs.writeFile(path.join(dir,'counter.txt'),String(current+1));
            await fs.appendFile(path.join(dir,'sequence.txt'),'end '+process.argv[4]+'\\n');
          }).then(()=>process.stdin.destroy(),error=>{console.error(error);process.exitCode=1;process.stdin.destroy()});
        });`;
      const child = spawn(process.execPath, ['-e', source, bundle, root, operationId, label], {stdio: ['pipe', 'pipe', 'pipe']});
      children.add(child);
      let stderr = '';
      child.stderr?.setEncoding('utf8').on('data', (text: string) => {stderr += text;});
      child.stdout?.once('data', () => {
        startWhenReady.push(() => {child.stdin?.write('start');});
        if (startWhenReady.length === 2) for (const start of startWhenReady) start();
      });
      return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => {children.delete(child); resolve({code, stderr});});
      });
    };
    for (const result of await Promise.all([worker('A'), worker('B')])) expect(result, result.stderr).toEqual({code: 0, stderr: ''});
    expect(await readFile(counterPath, 'utf8')).toBe('2');
    const sequence = (await readFile(join(store.directory(operationId), 'sequence.txt'), 'utf8')).trim().split('\n');
    expect([['begin A', 'end A', 'begin B', 'end B'], ['begin B', 'end B', 'begin A', 'end A']]).toContainEqual(sequence);
  }, 20000);
});
