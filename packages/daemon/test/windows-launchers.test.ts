import { mkdtemp, readdir, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LAUNCHER_FAILURE_EXIT, parseCurrentTxt, renderWindowsLaunchers, writeWindowsLaunchers } from '../src/service/windows-launchers';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('renders two launchers that differ only in the marker on line 2', () => {
  const launchers = renderWindowsLaunchers();
  const cli = launchers['bin\\vonvon.cmd'].split('\r\n');
  const server = launchers['bin\\vonvon-server.cmd'].split('\r\n');
  expect(cli[1]).toBe('rem Vonvon Bot server CLI v1');
  expect(server[1]).toBe('rem Vonvon Bot server supervisor v1');
  expect([...cli.slice(0, 1), ...cli.slice(2)]).toEqual([...server.slice(0, 1), ...server.slice(2)]);
});

it('is CRLF batch that reads current.txt, falls back to line 2, and passes arguments and the exit code through', () => {
  const text = renderWindowsLaunchers()['bin\\vonvon-server.cmd'];
  expect(text.endsWith('\r\n')).toBe(true);
  expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  for (const part of [
    '@echo off', 'setlocal EnableExtensions DisableDelayedExpansion', 'set "VONVON_ROOT=%~dp0.."',
    'for /f "usebackq delims=" %%L in ("%VONVON_ROOT%\\current.txt") do (',
    'if defined VONVON_PREV ( set "VONVON_VER=%VONVON_PREV%" )',
    '"%VONVON_ROOT%\\releases\\%VONVON_VER%\\node\\node.exe" "%VONVON_ROOT%\\releases\\%VONVON_VER%\\app\\bin\\vonvon.mjs" %*',
    'exit /b %ERRORLEVEL%', `exit /b ${LAUNCHER_FAILURE_EXIT}`, 'is missing',
  ]) expect(text).toContain(part);
  // The version check comes after the read, and the fallback before the second check.
  expect(text.indexOf('if not defined VONVON_VER')).toBeGreaterThan(text.indexOf('for /f'));
  expect(text.indexOf('no usable release')).toBeGreaterThan(text.indexOf('VONVON_VER=%VONVON_PREV%'));
});

it('quotes every path: each %VONVON_ROOT% sits inside a quoted string, and no path is expanded inside a ( … ) block', () => {
  const text = renderWindowsLaunchers()['bin\\vonvon.cmd'];
  for (const line of text.split('\r\n')) {
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      if (line.startsWith('%VONVON_ROOT%', i)) expect(quoted, line).toBe(true);
    }
    expect(quoted, `unbalanced quotes: ${line}`).toBe(false);
  }
  // Lines inside a block (indented) expand versions only.
  for (const line of text.split('\r\n').filter(line => line.startsWith('  '))) expect(line).not.toContain('%VONVON_ROOT%');
  expect(text).not.toContain('EnableDelayedExpansion');
});

it('writes both launchers through .cmd.tmp and leaves no temporary file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-launchers-')); dirs.push(root);
  const steps: string[] = [];
  const written = await writeWindowsLaunchers(root, {
    mkdir: (path, options) => mkdir(path, options),
    writeFile: async (path, data) => { steps.push(`write ${path.slice(root.length)}`); await writeFile(path, data); },
    rename: async (from, to) => { steps.push(`rename ${from.slice(root.length)} ${to.slice(root.length)}`); await rename(from, to); },
  });
  const bin = join(root, 'bin');
  expect(written).toEqual([join(bin, 'vonvon.cmd'), join(bin, 'vonvon-server.cmd')]);
  expect((await readdir(bin)).sort()).toEqual(['vonvon-server.cmd', 'vonvon.cmd']);
  expect(await readFile(join(bin, 'vonvon.cmd'), 'utf8')).toBe(renderWindowsLaunchers()['bin\\vonvon.cmd']);
  const sep = join('a', 'b').slice(1, 2);
  expect(steps).toEqual([
    `write ${sep}bin${sep}vonvon.cmd.tmp`, `rename ${sep}bin${sep}vonvon.cmd.tmp ${sep}bin${sep}vonvon.cmd`,
    `write ${sep}bin${sep}vonvon-server.cmd.tmp`, `rename ${sep}bin${sep}vonvon-server.cmd.tmp ${sep}bin${sep}vonvon-server.cmd`,
  ]);
  // Rewriting replaces the old files in place.
  await writeWindowsLaunchers(root);
  expect((await readdir(bin)).sort()).toEqual(['vonvon-server.cmd', 'vonvon.cmd']);
});

it('parseCurrentTxt reads current.txt the way for /f does', () => {
  expect(parseCurrentTxt('1.0.1\n1.0.0\n')).toEqual({ version: '1.0.1', previous: '1.0.0' });
  expect(parseCurrentTxt('1.0.0\n\n')).toEqual({ version: '1.0.0', previous: undefined });
  expect(parseCurrentTxt('1.0.0\n')).toEqual({ version: '1.0.0' });
  expect(parseCurrentTxt('1.0.1\r\n1.0.0\r\n')).toEqual({ version: '1.0.1', previous: '1.0.0' });
  expect(parseCurrentTxt('')).toBeNull();
  expect(parseCurrentTxt('x\n')).toBeNull();
  expect(parseCurrentTxt('\n')).toBeNull();
  expect(parseCurrentTxt('1.0.1\nnot-a-version\n')).toEqual({ version: '1.0.1' });
});
