import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
