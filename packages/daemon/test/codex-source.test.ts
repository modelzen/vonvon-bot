import { afterEach, expect, it, vi } from 'vitest';
import { codexSource } from '../src/environment/codex-source';

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['/Applications/Codex.app/Contents/Resources/codex', 'app'],
  ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', 'app'],
  ['C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd', 'npm'],
  ['/prefix/lib/node_modules/@openai/codex/bin/codex.js', 'npm'],
  ['/opt/homebrew/Caskroom/codex/1.0/bin/codex', 'homebrew'],
  ['/custom/codex', 'unknown'],
])('describes the selected installation %s', (bin, source) => {
  vi.stubEnv('CODEX_BIN', undefined);
  expect(codexSource(bin, false)).toMatchObject({source, updateInstructions: expect.stringContaining('刷新模型')});
});

it('preserves explicit choices and distinguishes managed ownership', () => {
  vi.stubEnv('CODEX_BIN', undefined);
  expect(codexSource('/data/managed/codex', true)).toEqual({source: 'managed'});
  vi.stubEnv('CODEX_BIN', '/custom/codex');
  expect(codexSource('/custom/codex', false)).toMatchObject({source: 'explicit'});
});
