import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, LAUNCHD_LABEL } from '../src/service/identity';
import { buildUnit, SYSTEMD_UNIT_NAME } from '../src/service/systemd';
import { buildLauncherCmd, buildLauncherVbs } from '../src/service/win-startup';

// These tests cover serialization and configuration semantics. Native execution
// and executable-selection evidence live in service-smoke.test.ts.

const nativeCodexPath = join(tmpdir(), 'codex tools', 'codex');
const systemdString = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');

describe('systemd unit (buildUnit)', () => {
  const unit = buildUnit();

  it('is a well-formed user service with crash-restart + login autostart', () => {
    expect(unit).toContain('[Service]');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('runs the daemon foreground command and appends to the shared log files', () => {
    expect(unit).toMatch(/ExecStart=".+" ".+" daemon run/);
    expect(unit).toContain('StandardOutput=append:');
    expect(unit).toContain('StandardError=append:');
    expect(unit).toContain('Environment="PATH=');
  });

  it('unit name is a .service', () => {
    expect(SYSTEMD_UNIT_NAME).toMatch(/\.service$/);
  });

  it('preserves an explicit CODEX_BIN override for the background service', () => {
    withCodexBin(nativeCodexPath, () => {
      expect(buildUnit()).toContain(`Environment="CODEX_BIN=${systemdString(nativeCodexPath)}"`);
    });
  });

  it('escapes a literal percent specifier instead of allowing systemd to expand it', () => {
    withCodexBin(join(tmpdir(), 'codex%n!', 'codex'), () => {
      expect(buildUnit()).toContain('codex%%n!');
    });
  });

  it('normalizes a relative CODEX_BIN before persisting it', () => {
    withCodexBin(join('relative tools', 'codex'), () => {
      expect(buildUnit()).toContain(`Environment="CODEX_BIN=${systemdString(resolve('relative tools', 'codex'))}"`);
    });
  });

  it('omits an unset override and serializes an explicit clear', () => {
    withCodexBin(undefined, () => expect(buildUnit()).not.toContain('CODEX_BIN='));
    withCodexBin('', () => expect(buildUnit()).toContain('Environment="CODEX_BIN="'));
    withCodexBin(nativeCodexPath, () => {
      expect(buildUnit({ codexBin: null })).toContain('Environment="CODEX_BIN="');
      expect(buildUnit({ codexBin: null })).not.toContain(systemdString(nativeCodexPath));
    });
  });
});

describe('launchd definition', () => {
  it('fixes the identity, root, port and PATH without CODEX_BIN passthrough', async () => {
    const root = await resolveServiceRoot(tmpdir());
    const rendered = renderDefinition({ target: { platform: 'darwin', plistPath: '/unused.plist' }, root, port: 32123,
      distribution: { kind: 'npm', executable: process.execPath, entry: '/package/bin/vonvon.mjs' }, capturedPath: '/captured/bin' });
    if (rendered.platform !== 'darwin') throw new Error('Expected plist');
    const plist = Buffer.from(rendered.plist).toString();
    expect(plist).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>--port</string><string>32123</string>');
    expect(plist).toContain('<key>PATH</key><string>/captured/bin</string>');
    expect(plist).toContain(`<string>${root}/service.log</string>`);
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).not.toContain('CODEX_BIN');
  });
});

describe('Windows hidden launcher (.cmd)', () => {
  const cmd = buildLauncherCmd();

  it('is a CRLF batch script that sets PATH + service flag and runs the daemon', () => {
    expect(cmd.startsWith('@echo off')).toBe(true);
    expect(cmd).toContain('\r\n'); // cmd.exe needs CRLF
    expect(cmd).toContain('set "PATH=');
    expect(cmd).toContain('set "FEISHU_CODEX_BRIDGE_SERVICE=1"');
    expect(cmd).toMatch(/".+" ".+" daemon run /);
  });

  it('appends stdout and stderr to the log files', () => {
    expect(cmd).toContain('>> "');
    expect(cmd).toContain('2>> "');
  });

  it('preserves an explicit CODEX_BIN override for the background service', () => {
    withCodexBin(nativeCodexPath, () => {
      expect(buildLauncherCmd()).toContain(`set "CODEX_BIN=${nativeCodexPath}"`);
    });
  });

  it('protects literal percent/bang characters and uses UTF-8 for Unicode paths', () => {
    withCodexBin(join(tmpdir(), 'codex 中文 %USERNAME% !', 'codex.exe'), () => {
      const launcher = buildLauncherCmd();
      expect(launcher).toContain('setlocal DisableDelayedExpansion');
      expect(launcher).toContain('65001');
      expect(launcher).toContain('codex 中文 %%USERNAME%% !');
    });
  });

  it('omits an unset override and serializes an explicit clear', () => {
    withCodexBin(undefined, () => expect(buildLauncherCmd()).not.toContain('set "CODEX_BIN='));
    withCodexBin('', () => expect(buildLauncherCmd()).toContain('set "CODEX_BIN="'));
    withCodexBin(nativeCodexPath, () => {
      expect(buildLauncherCmd({ codexBin: null })).toContain('set "CODEX_BIN="');
      expect(buildLauncherCmd({ codexBin: null })).not.toContain(nativeCodexPath);
    });
  });
});

describe('Windows hidden launcher (.vbs)', () => {
  const vbs = buildLauncherVbs();

  it('runs the .cmd hidden (window style 0) and does not wait', () => {
    expect(vbs).toContain('WScript.Shell');
    expect(vbs).toMatch(/sh\.Run "cmd \/c "".+\.cmd""", 0, False/);
  });
});

function withCodexBin(value: string | undefined, fn: () => void): void {
  const prev = process.env.CODEX_BIN;
  if (value === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prev;
  }
}
