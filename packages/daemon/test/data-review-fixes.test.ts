import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn(), debug: vi.fn() } }));

import { findSecretShape } from '../src/bot/memory-secret-shape';
import { MemoryStore, projectMemoryLocation } from '../src/bot/memory-store';
import { memoryRpc } from '../src/server/rpc/memory';
import { NotWiredYetError, type AdminService } from '../src/admin/service';
import { bindProject, listProjectsIn } from '../src/project/registry';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'data-review-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const human = { via: 'ui', botId: '', actorRole: 'desktop' } as const;
const DESKTOP = { role: 'desktop' } as const;

describe('memory.json integrity survives ordinary writes', () => {
  it('an outside edit stays unverified across a normal write until the owner reseals', async () => {
    const dir = join(root, 'p');
    const make = () => new MemoryStore({ ...projectMemoryLocation('prj_aaaaaaaa', { library: { dir: root } as never }), dir, lockDir: join(root, 'lock') } as never);
    const store = make();
    await store.add({ text: '一', source: human, trust: 'untrusted', actor: DESKTOP });
    const file = join(dir, 'memory.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    snapshot.items[0].trust = 'trusted';
    writeFileSync(file, JSON.stringify(snapshot));
    expect((await make().read()).verified).toBe(false);
    await make().add({ text: '二', source: human, trust: 'untrusted', actor: DESKTOP });
    expect((await make().read()).verified).toBe(false);
    await make().reseal();
    expect((await make().read()).verified).toBe(true);
    await make().add({ text: '三', source: human, trust: 'untrusted', actor: DESKTOP });
    expect((await make().read()).verified).toBe(true);
  });
});

describe('secret shape and Feishu ids', () => {
  it('lets Feishu ids and hex trace ids through', () => {
    for (const text of ['通知发到 oc_0123456789abcdef0123456789abcdef', 'ou_9f8e7d6c5b4a39281706f5e4d3c2b1a0 是主人', 'trace 0123456789abcdef0123456789abcdef'])
      expect(findSecretShape(text), text).toBeUndefined();
  });
});

describe('memory rpc in the read-only preview', () => {
  it('refuses writes, lets reads through', async () => {
    const preview = { readonlyPreview: true } as AdminService;
    await expect(memoryRpc(preview, { type: 'reseal', scope: { kind: 'bot', botId: 'x' } })).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(memoryRpc(preview, { type: 'add', scope: { kind: 'bot', botId: 'x' }, text: '甲' })).rejects.toBeInstanceOf(NotWiredYetError);
  });
});

describe('a freshly bound row is not a pending step B row', () => {
  it('carries migration.memory', async () => {
    const location = { file: join(root, 'projects.json'), dataRoot: root };
    const cwd = join(root, 'work');
    mkdirSync(cwd);
    await bindProject(
      { name: 'g', chatId: 'oc_g', cwd: { kind: 'existing', path: cwd }, backend: 'codex', defaultBackend: 'codex', kind: 'multi', noMention: false, project: { id: 'prj_aaaaaaaa' } } as never,
      async () => ({ cwd, blank: false, createdAt: 1 } as never), location);
    const rows = await listProjectsIn(location.file);
    expect(typeof (rows[0] as { migration?: { memory?: number } }).migration?.memory).toBe('number');
  });
});
