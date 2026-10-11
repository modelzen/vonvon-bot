import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot } from '../src/service/identity';
import { buildLauncherCmd } from '../src/service/win-startup';

const bin = resolve(import.meta.dirname, '../bin/vonvon.mjs');

function assertPackagedCommand(args: string[], port?: number): void {
  expect(args).toEqual([process.execPath, bin, 'daemon', 'run', ...(port ? ['--port', String(port)] : [])]);
  expect(existsSync(bin)).toBe(true);
  const result = spawnSync(args[0]!, [...args.slice(1), '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Run in the foreground');
  expect(result.stdout).toContain('--port <port>');
}

describe('OS service foreground entry', () => {
  it('launchd calls the packaged daemon command', async () => {
    const root = await resolveServiceRoot(tmpdir());
    const rendered = renderDefinition({ target: { platform: 'darwin', plistPath: '/unused.plist' }, root, port: 32123, distribution: { kind: 'npm', executable: process.execPath, entry: bin }, capturedPath: '/usr/bin' });
    if (rendered.platform !== 'darwin') throw new Error('Expected plist');
    const plist = Buffer.from(rendered.plist).toString();
    const argumentsXml = plist.match(/<key>ProgramArguments<\/key>\s*<array>(.*?)<\/array>/s)?.[1];
    expect(argumentsXml).toBeDefined();
    const args = [...argumentsXml!.matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]!);
    assertPackagedCommand(args, 32123);
  });

  it('systemd calls the packaged daemon command', async () => {
    const root = await resolveServiceRoot(tmpdir());
    const rendered = renderDefinition({ target: { platform: 'linux', unitPath: '/unused.service' }, root, port: 32123,
      distribution: { kind: 'npm', executable: process.execPath, entry: bin }, capturedPath: '/usr/bin' });
    if (rendered.platform !== 'linux') throw new Error('Expected unit');
    const line = Buffer.from(rendered.unit).toString().match(/^ExecStart=(.*)$/m)?.[1];
    expect(line).toBeDefined();
    const args = [...line!.matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)].map(match =>
      match[1]?.replace(/\\([\\"])/g, '$1').replace(/%%/g, '%').replace(/\$\$/g, '$') ?? match[2]!,
    );
    assertPackagedCommand(args, 32123);
  });

  it('Windows login launcher calls the packaged daemon command', () => {
    const cmd = buildLauncherCmd({ cliBinPath: bin });
    const line = cmd.split('\r\n').find((part) => part.includes(`"${bin}" daemon`));
    expect(line).toBeDefined();
    const args = [...line!.matchAll(/"([^"]+)"|\b(daemon|run)\b/g)].slice(0, 4).map((match) => match[1] ?? match[2]!);
    assertPackagedCommand(args);
  });
});


describe('Windows relaunch helper entry', () => {
  it('refuses relaunch without touching the request or taking a data lease and stays hidden', () => {
    const root = mkdtempSync(join(tmpdir(), 'vonvon-relaunch-cli-'));
    try {
      const data = join(root, 'data');
      const requestDir = join(root, 'request');
      mkdirSync(data); mkdirSync(requestDir);
      writeFileSync(join(data, '.access'), 'admission must not be entered');
      const env = { ...process.env, HOME: root, USERPROFILE: root, VONVON_HOME: data };
      const result = spawnSync(process.execPath, [bin, '__win-relaunch', join(requestDir, 'missing.json')], { env, encoding: 'utf8', timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('Vonvon Bot cannot manage an OS service in this version. Use vonvon daemon start and vonvon daemon stop.');
      expect(readdirSync(requestDir)).toEqual([]);
      expect(readdirSync(data)).toEqual(['.access']);
      expect(readFileSync(join(data, '.access'), 'utf8')).toBe('admission must not be entered');
      const help = spawnSync(process.execPath, [bin, '--help'], { env, encoding: 'utf8', timeout: 10_000 });
      expect(help.status).toBe(0);
      expect(help.stdout).not.toContain('__win-relaunch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
