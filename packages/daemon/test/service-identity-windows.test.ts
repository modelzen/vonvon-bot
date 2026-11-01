import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalWindowsRoot, createSidReader, parseWhoamiSid, serviceTarget, SidUnavailable, windowsTaskName } from '../src/service/identity';
import { fail, ok, recorder, SID, WHOAMI } from './service-windows-fixture';

/** In the root folder: a standard user may create a task there, not a folder (I4a review F2). */
const NAME = /^\\VonvonBot-[0-9a-f]{12}-[0-9a-f]{12}$/;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('names the task after the user and the data root, whatever the case or a trailing backslash (C7)', () => {
  const name = windowsTaskName(SID, 'C:\\Users\\U\\.vonvon-bot\\');
  expect(name).toMatch(NAME);
  expect(windowsTaskName(SID, 'C:\\Users\\U\\.vonvon-bot')).toBe(name);
  expect(windowsTaskName(SID, 'c:\\users\\u\\.VONVON-BOT')).toBe(name);
  expect(windowsTaskName(SID, 'C:\\Users\\U\\.\\.vonvon-bot')).toBe(name);
  expect(canonicalWindowsRoot('C:\\Users\\U\\.vonvon-bot\\\\')).toBe('c:\\users\\u\\.vonvon-bot');
});

it('gives another user, or another data root, another task: the default root carries both hashes too', () => {
  const name = windowsTaskName(SID, 'C:\\Users\\U\\.vonvon-bot');
  expect(windowsTaskName('S-1-5-21-1000000001-2000000002-3000000003-1002', 'C:\\Users\\U\\.vonvon-bot')).not.toBe(name);
  expect(windowsTaskName(SID, 'C:\\Users\\U\\other')).not.toBe(name);
  expect(name.split('\\')).toEqual(['', expect.stringMatching(/^VonvonBot-/)]);
  expect(name.split('-')).toHaveLength(3);
});

it('serviceTarget carries the task name and the SID; a malformed SID is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'vonvon-win-identity-')); dirs.push(root);
  const target = serviceTarget({ platform: 'win32', sid: SID, root });
  expect(target).toEqual({ platform: 'win32', taskName: windowsTaskName(SID, root), sid: SID });
  expect(() => serviceTarget({ platform: 'win32', sid: 'nobody', root })).toThrow(SidUnavailable);
});

it('reads the SID from the second column of whoami /user /fo csv /nh', async () => {
  expect(parseWhoamiSid(`"host\\u","${SID}"\r\n`)).toBe(SID);
  expect(parseWhoamiSid(`\r\n"域\\用户 名","${SID}"`)).toBe(SID);
  for (const output of ['', 'garbage', `"host\\u","not-a-sid"`, `"host\\u"`]) expect(() => parseWhoamiSid(output)).toThrow(SidUnavailable);

  const r = recorder(() => WHOAMI);
  const read = createSidReader(r.run);
  await expect(read()).resolves.toBe(SID);
  await expect(read()).resolves.toBe(SID);
  expect(r.calls).toEqual(['whoami /user /fo csv /nh']);
});

it('a failed or garbled whoami is SidUnavailable, and is asked again next time', async () => {
  let reply = fail('ERROR: no');
  const r = recorder(() => reply);
  const read = createSidReader(r.run);
  await expect(read()).rejects.toThrow(SidUnavailable);
  reply = ok('Sorry, no CSV here');
  await expect(read()).rejects.toThrow(SidUnavailable);
  reply = WHOAMI;
  await expect(read()).resolves.toBe(SID);
  expect(r.calls).toHaveLength(3);
});
