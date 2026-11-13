import {mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {SourceHistory} from '../src/recipe-source-history';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });

it('preserves every committed intent across restart, paginates in UUID order, and separates identities', () => {
  const dir = mkdtempSync(join(tmpdir(),'source-history-'));
  dirs.push(dir);
  const path = join(dir,'source.sqlite');
  const target = {accountId:'A',deviceId:'device',deviceKey:'original-key',botId:'bot'};
  const history = new SourceHistory(path);
  const ids = Array.from({length:36},(_,i) => '00000000-0000-7000-8000-'+String(i).padStart(12,'0'));
  for (const id of ids) history.remember(target,id,'original-binding');
  history.remember(target,ids[0]!,'original-binding');
  expect(() => history.remember(target,ids[0]!,'new-registration')).toThrow();
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  history.close();
  const reopened = new SourceHistory(path);
  const first = reopened.page(target,'original-binding');
  expect(first.ids).toHaveLength(32);
  expect(first.nextCursor).toBe(ids[4]);
  const second = reopened.page(target,'original-binding',first.nextCursor!);
  expect([...first.ids,...second.ids]).toEqual([...ids].reverse());
  expect(second.nextCursor).toBeNull();
  expect(reopened.page(target,'new-binding').ids).toEqual([]);
  for (const otherTarget of [{...target,accountId:'B'}, {...target,deviceKey:'new-key'}, {...target,botId:'other-bot'}]) {
    expect(reopened.page(otherTarget,'original-binding').ids).toEqual([]);
    expect(() => reopened.page(otherTarget,'original-binding',first.nextCursor!)).toThrow();
  }
  reopened.close();
});
