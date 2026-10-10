import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlist } from '../src/service/launchd';
import { buildUnit } from '../src/service/systemd';
import { buildLauncherCmd } from '../src/service/win-startup';

const bin = resolve(import.meta.dirname, '../bin/vonvon.mjs');

function assertPackagedCommand(args: string[]): void {
  expect(args).toEqual([process.execPath, bin, 'daemon', 'run']);
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
  it('launchd calls the packaged daemon command', () => {
    const plist = buildPlist({ cliBinPath: bin });
    const argumentsXml = plist.match(/<key>ProgramArguments<\/key>\s*<array>(.*?)<\/array>/s)?.[1];
    expect(argumentsXml).toBeDefined();
    const args = [...argumentsXml!.matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]!);
    assertPackagedCommand(args);
  });

  it('systemd calls the packaged daemon command', () => {
    const unit = buildUnit({ cliBinPath: bin });
    const line = unit.match(/^ExecStart=(.*)$/m)?.[1];
    expect(line).toBeDefined();
    const args = [...line!.matchAll(/"([^"]+)"|\b(daemon|run)\b/g)].map((match) => match[1] ?? match[2]!);
    assertPackagedCommand(args);
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
