import { expect, it, vi } from 'vitest';
import { RpcError, type VonvonClient } from '@vonvon/client';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { runDirList, runDirSuggest } from '../src/cli/commands/dir';

/** cli-3-groups: dir list / suggest, the web page's folder picker in a terminal, through a fake client behind the real withDaemon. */
function harness(directory: (request: never) => unknown) {
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ close, directory }) as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, { local: 50, feishu: 50 });
  let out = '';
  return { close, daemon, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, clear: () => { out = ''; } };
}
const host = { cwd: '/home/u/work', home: '/home/u', platform: 'linux' as const };
const entries = [
  { name: '.config', path: '/home/u/.config', hidden: true },
  { name: 'app', path: '/home/u/app', hidden: false },
  { name: 'docs', path: '/home/u/docs', hidden: false },
];

// main 必败: there was no dir list
it('dir list prints the visible folders, --all the hidden ones too, and --json always all of them', async () => {
  const directory = vi.fn(async (_request: unknown) => ({ kind: 'entries', path: '/home/u', parent: null, entries, truncated: false }));
  const h = harness(directory);
  await runDirList(undefined, {}, h.io(), h.daemon, host);
  expect(directory).toHaveBeenCalledWith({ type: 'list' });
  expect(h.out()).toBe('/home/u/app\n/home/u/docs\n');
  h.clear(); await runDirList(undefined, { all: true }, h.io(), h.daemon, host);
  expect(h.out()).toBe('/home/u/.config\n/home/u/app\n/home/u/docs\n');
  h.clear(); await runDirList('~', {}, h.io(true), h.daemon, host);
  expect(directory).toHaveBeenLastCalledWith({ type: 'list', path: '/home/u' });
  expect(JSON.parse(h.out())).toEqual({ ok: true, path: '/home/u', parent: null, entries, truncated: false });
  // a relative path is taken from this computer's working directory
  h.clear(); await runDirList('../docs', {}, h.io(), h.daemon, host);
  expect(directory).toHaveBeenLastCalledWith({ type: 'list', path: '/home/u/docs' });
  expect(h.close).toHaveBeenCalledTimes(4);
});

it('dir list says when there is nothing to show and when the list was cut', async () => {
  const hiddenOnly = harness(async () => ({ kind: 'entries', path: '/home/u/x', parent: '/home/u', entries: [entries[0]], truncated: false }));
  await runDirList('/home/u/x', {}, hiddenOnly.io(), hiddenOnly.daemon, host);
  expect(hiddenOnly.out()).toBe('/home/u/x 下没有子文件夹（另有 1 个隐藏的，加 --all 列出）。\n');
  const many = Array.from({ length: 1000 }, (_, i) => ({ name: `d${i}`, path: `/home/u/d${i}`, hidden: false }));
  const cut = harness(async () => ({ kind: 'entries', path: '/home/u', parent: null, entries: many, truncated: true }));
  await runDirList(undefined, {}, cut.io(), cut.daemon, host);
  expect(cut.out().trimEnd().split('\n').at(-1)).toBe('只列了前 1000 个');
});

it('dir list: a folder that is not there is an argument error in the daemon\'s words', async () => {
  const h = harness(async () => { throw new RpcError('invalid_directory', '找不到这个目录，请检查路径。'); });
  await expect(runDirList('nope', {}, h.io(), h.daemon, host)).rejects.toMatchObject({ kind: 'bad-args', reason: 'invalid_directory', message: '读取目录失败：找不到这个目录，请检查路径。' });
  const outside = harness(async () => { throw new RpcError('outside_home', '目录必须位于用户主目录内。'); });
  await expect(runDirList('/etc', {}, outside.io(), outside.daemon, host)).rejects.toMatchObject({ kind: 'bad-args', reason: 'outside_home' });
});

// main 必败: there was no dir suggest
it('dir suggest sends what was typed as it is and prints one path a line', async () => {
  const reply = { kind: 'suggestions', root: '/home/u', path: null, parent: null, entries: entries.slice(1), truncated: false };
  const directory = vi.fn(async (_request: unknown) => reply);
  const h = harness(directory);
  await runDirSuggest('~/ap', h.io(), h.daemon);
  expect(directory).toHaveBeenCalledWith({ type: 'suggest', query: '~/ap' });
  expect(h.out()).toBe('/home/u/app\n/home/u/docs\n');
  h.clear(); await runDirSuggest('ap', h.io(true), h.daemon);
  expect(JSON.parse(h.out())).toEqual({ ok: true, root: '/home/u', path: null, parent: null, entries: entries.slice(1), truncated: false });
  const none = harness(async () => ({ ...reply, entries: [] }));
  await runDirSuggest('zzz', none.io(), none.daemon);
  expect(none.out()).toBe('没有找到匹配的文件夹。\n');
});
