import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, LAUNCHD_LABEL, SYSTEMD_UNIT_NAME } from '../src/service/identity';
import { buildLauncherCmd, buildLauncherVbs } from '../src/service/win-startup';

// These tests cover serialization and configuration semantics. Native execution
// and executable-selection evidence live in service-smoke.test.ts.

const nativeCodexPath = join(tmpdir(), 'codex tools', 'codex');
describe('systemd definition', () => {
  it('fixes the identity, root, port, restart policy, logs and PATH', async () => {
    const root = await resolveServiceRoot(tmpdir());
    const rendered = renderDefinition({ target: { platform: 'linux', unitPath: '/unused.service' }, root, port: 32123,
      distribution: { kind: 'desktop', executable: process.execPath, entry: '/package/tools %n/$entry.mjs' }, capturedPath: '/captured/"tools":/bin' });
    if (rendered.platform !== 'linux') throw new Error('Expected unit');
    const unit = Buffer.from(rendered.unit).toString();
    expect(SYSTEMD_UNIT_NAME).toBe('vonvon-bot.service');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain('TimeoutStopSec=infinity');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('"/package/tools %%n/$$entry.mjs" daemon run --port 32123');
    expect(unit).toContain(`Environment="VONVON_HOME=${root}"`);
    expect(unit).toContain('Environment="VONVON_SERVICE=systemd"');
    expect(unit).toContain('Environment="ELECTRON_RUN_AS_NODE=1"');
    expect(unit).toContain('Environment="PATH=/captured/\\"tools\\":/bin"');
    expect(unit).toContain(`StandardOutput=append:${root}/service.log`);
    expect(unit).toContain(`StandardError=append:${root}/service.err.log`);
    expect(unit).not.toContain('CODEX_BIN');
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
