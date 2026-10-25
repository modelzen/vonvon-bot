import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {createDirectorySuggestions, directorySuggestionWorkerSource} from '../src/server/directory-suggestions';

const resources: Array<{root: string; search: ReturnType<typeof createDirectorySuggestions>}> = [];
afterEach(async () => {
  for (const {root, search} of resources.splice(0)) { search.close(); await rm(root, {recursive: true, force: true}); }
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-directory-process-')));
  await mkdir(join(root, 'work', 'paseo'), {recursive: true});
  execFileSync('mkfifo', [join(root, 'blocked.pipe')]);
  // This is a genuine blocking filesystem syscall in a real child process, not
  // a mocked timeout Promise. Normal queries still execute the compiled worker.
  const prologue = `if(process.argv[2].includes('blocked')){require('node:fs').writeFileSync(process.argv[1]+'/ready-'+process.argv[2].replaceAll('/','_'),String(process.pid));require('node:fs').readFileSync(process.argv[1]+'/blocked.pipe');}\n`;
  const search = createDirectorySuggestions(prologue + directorySuggestionWorkerSource);
  resources.push({root, search});
  const ready = async (query: string) => {
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(join(root, `ready-${query.replaceAll('/', '_')}`), 'utf8')); expect(pid).toBeGreaterThan(0); });
    return pid;
  };
  return {root, search, ready};
}
const exited = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

it('keeps explicit paths usable after two searches are blocked in filesystem syscalls', async () => {
  const {root, search, ready} = await fixture();
  const first = search.search(root, 'blocked-one');
  const second = search.search(root, 'blocked-two');
  const pids = await Promise.all([ready('blocked-one'), ready('blocked-two')]);
  const started = Date.now();
  const result = await search.search(root, '~/work/');
  expect(Date.now() - started).toBeLessThan(1000);
  expect(result.entries.map(entry => entry.name)).toEqual(['work', 'paseo']);
  expect(result.truncated).toBe(false);
  expect((await first).truncated).toBe(true);
  search.close();
  expect((await second).truncated).toBe(true);
  await vi.waitFor(() => expect(pids.every(exited)).toBe(true));
});

it('hard-times out a hung name search and kills the actual worker process', async () => {
  const {root, search, ready} = await fixture();
  const started = Date.now();
  const result = search.search(root, 'blocked-name');
  const pid = await ready('blocked-name');
  expect((await result).truncated).toBe(true);
  expect(Date.now() - started).toBeLessThan(2500);
  await vi.waitFor(() => expect(exited(pid)).toBe(true));
  expect((await search.search(root, '~/work/')).entries.map(entry => entry.name)).toEqual(['work', 'paseo']);
});

it('reports a timeout when an explicit path never produced a verified directory', async () => {
  const {root, search, ready} = await fixture();
  const result = expect(search.search(root, '~/blocked-path')).rejects.toMatchObject({code: 'directory_timeout'});
  const pid = await ready('~/blocked-path');
  await result;
  await vi.waitFor(() => expect(exited(pid)).toBe(true));
});

it('closes pending directory workers immediately without waiting for blocked I/O', async () => {
  const {root, search, ready} = await fixture();
  const result = search.search(root, 'blocked-shutdown');
  const pid = await ready('blocked-shutdown');
  const started = Date.now();
  search.close();
  expect((await result).truncated).toBe(true);
  expect(Date.now() - started).toBeLessThan(250);
  await vi.waitFor(() => expect(exited(pid)).toBe(true));
  await expect(search.search(root, '')).rejects.toMatchObject({code: 'directory_closed'});
});
