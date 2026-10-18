import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { getterContents, isBridgeGetter } from '../src/config/data-compatibility';
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
it('recognizes the legacy getter path only through a validated directory alias', () => {
  const home = mkdtempSync(join(tmpdir(), 'vonvon-alias-')); homes.push(home);
  const root = join(home, '.vonvon-bridge'); mkdirSync(root);
  const wrapper = join(root, 'secrets-getter'); writeFileSync(wrapper, 'fixture');
  const legacy = join(home, '.feishu-codex-bridge');
  expect(isBridgeGetter(join(legacy, 'secrets-getter'), [], home, wrapper)).toBe(false);
  symlinkSync(root, legacy, process.platform === 'win32' ? 'junction' : 'dir');
  expect(isBridgeGetter(join(legacy, 'secrets-getter'), [], home, wrapper)).toBe(true);
  expect(isBridgeGetter('/arbitrary/program', ['secrets', 'get'], home, wrapper)).toBe(false);
});

it('recognizes only a Node provider proven by the exact generated wrapper', () => {
  const home = mkdtempSync(join(tmpdir(), 'vonvon-provider-')); homes.push(home);
  const root = join(home, '.vonvon-bridge'); mkdirSync(root);
  const wrapper = join(root, 'secrets-getter');
  const old = { nodePath: 'C:\\removed\\node.exe', cliPath: "C:\\runtime A's\\cli.mjs" };
  const args = [old.cliPath, 'secrets', 'get'];
  writeFileSync(wrapper, getterContents(old));
  expect(isBridgeGetter(old.nodePath, args, home, wrapper)).toBe(true);
  expect(isBridgeGetter(old.nodePath, ['C:\\custom\\cli.mjs', 'secrets', 'get'], home, wrapper)).toBe(false);
});
