import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, symlink, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeGeneratedDefinition, renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, serviceTarget } from '../src/service/identity';
import { readRegistration } from '../src/service/registration';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-definition-'));
  directories.push(base);
  const root = await resolveServiceRoot(base);
  return { root, port: 43121, distribution: { kind: 'npm' as const, executable: '/usr/local/bin/node', entry: '/opt/Vonvon/bin/vonvon.mjs' }, capturedPath: '/usr/local/bin:/usr/bin' };
}

describe.skipIf(process.platform === 'win32')('POSIX definition bytes and real filesystem readback', () => {
  it('owns root verification and resolves directory aliases', async () => {
    const input = await fixture();
    const alias = join(input.root, 'alias');
    await symlink(input.root, alias);
    expect(await resolveServiceRoot(alias)).toBe(input.root);
    const file = join(input.root, 'file');
    await writeFile(file, '');
    await expect(resolveServiceRoot(file)).rejects.toThrow('not a directory');
    await expect(resolveServiceRoot(join(input.root, 'missing'))).rejects.toThrow();
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} recognizes ours, other-root, absent and malformed without invoking a manager`, async () => {
      const input = await fixture();
      const target = serviceTarget({ platform, home: input.root, xdgConfigHome: undefined });
      const location = target.platform === 'darwin' ? target.plistPath : target.platform === 'linux' ? target.unitPath : '';
      const bytes = renderDefinition({ ...input, target });
      const content = bytes.platform === 'darwin' ? bytes.plist : bytes.platform === 'linux' ? bytes.unit : Buffer.alloc(0);
      if (target.platform === 'win32') throw new Error('POSIX target required');
      expect(await readRegistration({ target, requestedRoot: input.root })).toEqual({ kind: 'absent' });
      await mkdir(join(location, '..'), { recursive: true });
      await writeFile(location, content);
      expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('ours');
      const other = await fixture();
      expect((await readRegistration({ target, requestedRoot: other.root })).kind).toBe('other-root');
      await writeFile(location, Buffer.concat([content, Buffer.from('\nmalicious command\n')]));
      expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
      await writeFile(location, Buffer.from([0xff, 0xfe, 0xff]));
      expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
      await rm(location);
      await symlink(join(input.root, 'missing'), location);
      expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
    });
  }

  it('fails closed for directories, unreadable files, unresolved roots and noncanonical recorded roots', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'linux', home: input.root, xdgConfigHome: undefined });
    if (target.platform !== 'linux') throw new Error('Expected unit target');
    await mkdir(target.unitPath, { recursive: true });
    expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
    await rm(target.unitPath, { recursive: true });
    const bytes = renderDefinition({ ...input, target });
    if (bytes.platform !== 'linux') throw new Error('Expected unit');
    await writeFile(target.unitPath, bytes.unit);
    expect((await readRegistration({ target, requestedRoot: join(input.root, 'missing') })).kind).toBe('unrecognized');
    await chmod(target.unitPath, 0);
    try {
      if (process.getuid?.() !== 0) {
        const result = await readRegistration({ target, requestedRoot: input.root });
        expect(result.kind).toBe('unrecognized');
        if (result.kind === 'unrecognized') expect(result.location).toBe(target.unitPath);
      }
    } finally { await chmod(target.unitPath, 0o600); }
    const alias = join(input.root, 'alias');
    await symlink(input.root, alias);
    const aliased = Buffer.from(bytes.unit).toString().split(input.root).join(alias);
    await writeFile(target.unitPath, aliased);
    expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
    await rm(alias);
    expect((await readRegistration({ target, requestedRoot: input.root })).kind).toBe('unrecognized');
  });

  it('serializes independent launchd argv, XML literals and restart policy', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'darwin', home: input.root });
    const bytes = renderDefinition({ ...input, target, distribution: { kind: 'desktop', executable: '/Applications/Vonvon & "Bot".app/Electron', entry: "/app/<entry>'/main.js" } });
    if (bytes.platform !== 'darwin') throw new Error('Expected plist');
    const text = Buffer.from(bytes.plist).toString();
    expect(text).toContain('<key>ProgramArguments</key><array><string>/Applications/Vonvon &amp; &quot;Bot&quot;.app/Electron</string><string>/app/&lt;entry&gt;&apos;/main.js</string><string>daemon</string><string>run</string><string>--port</string><string>43121</string></array>');
    expect(text).toContain('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>');
    expect(text).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(text).toContain('<key>ThrottleInterval</key><integer>5</integer>');
    expect(text).not.toMatch(/ExitTimeOut|CODEX_BIN/);
    expect(decodeGeneratedDefinition(target, bytes).distribution.kind).toBe('desktop');
    for (const changed of [text.replace('&amp;', '&unknown;'), text.replace('<key>PATH</key>', '<key>PATH</key><key>PATH</key>'), text.replace('<false/>', '<true/>'), text + '<!-- extra -->']) {
      expect(() => decodeGeneratedDefinition(target, { platform: 'darwin', plist: Buffer.from(changed) })).toThrow();
    }
  });

  it('serializes systemd percent and dollar literals with fixed policy and rejects injected directives', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'linux', home: input.root, xdgConfigHome: undefined });
    const bytes = renderDefinition({ ...input, target, distribution: { kind: 'npm', executable: '/node %n/$HOME/"bin"', entry: '/app/$HOME/中文\\entry.mjs' }, capturedPath: '/bin/%n:$HOME' });
    if (bytes.platform !== 'linux') throw new Error('Expected unit');
    const text = Buffer.from(bytes.unit).toString();
    expect(text).toContain('ExecStart="/node %%n/$HOME/\\"bin\\"" "/app/$$HOME/中文\\\\entry.mjs" daemon run --port 43121\n');
    expect(text).toContain('Environment="PATH=/bin/%%n:$HOME"\n');
    expect(text).toContain('Restart=on-failure\nRestartSec=5\nTimeoutStopSec=infinity\n');
    expect(text).toContain('WantedBy=default.target\n');
    expect(text).not.toMatch(/CODEX_BIN|ELECTRON_RUN_AS_NODE/);
    expect(decodeGeneratedDefinition(target, bytes).distribution.executable).toBe('/node %n/$HOME/"bin"');
    for (const changed of [text + 'ExecStartPre=/bin/evil\n', text.replace('Restart=on-failure', 'Restart=always'), text.replace('%%n', '%n'), text.replace('$$HOME', '$HOME'), text.replace('[Service]', '[Service]\nEnvironment="VONVON_HOME=/evil"')]) {
      expect(() => decodeGeneratedDefinition(target, { platform: 'linux', unit: Buffer.from(changed) })).toThrow();
    }
  });

  it('decodes literal executable dollars separately from expanded argument dollars', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'linux', home: input.root, xdgConfigHome: undefined });
    const bytes = renderDefinition({ ...input, target, distribution: { kind: 'npm', executable: '/opt/$literal/node', entry: '/opt/$literal/main.mjs' } });
    if (bytes.platform !== 'linux') throw new Error('Expected unit');
    const text = Buffer.from(bytes.unit).toString();
    expect(text.split('\n').find((line) => line.startsWith('ExecStart='))).toBe('ExecStart="/opt/$literal/node" "/opt/$$literal/main.mjs" daemon run --port 43121');
    expect(decodeGeneratedDefinition(target, bytes).distribution).toEqual({ kind: 'npm', executable: '/opt/$literal/node', entry: '/opt/$literal/main.mjs' });
    const doubledExecutable = text.replace('"/opt/$literal/node"', () => '"/opt/$$literal/node"');
    expect(decodeGeneratedDefinition(target, { platform: 'linux', unit: Buffer.from(doubledExecutable) }).distribution.executable).toBe('/opt/$$literal/node');
  });

  it('includes Electron Node mode only for the desktop systemd definition', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'linux', home: input.root, xdgConfigHome: undefined });
    const bytes = renderDefinition({ ...input, target, distribution: { kind: 'desktop', executable: '/opt/Vonvon/electron', entry: '/opt/Vonvon/main.js' } });
    if (bytes.platform !== 'linux') throw new Error('Expected unit');
    expect(Buffer.from(bytes.unit).toString()).toContain('ExecStart="/opt/Vonvon/electron" "/opt/Vonvon/main.js" daemon run --port 43121\n');
    expect(Buffer.from(bytes.unit).toString()).toContain('Environment="ELECTRON_RUN_AS_NODE=1"\n');
    expect(decodeGeneratedDefinition(target, bytes).distribution.kind).toBe('desktop');
  });

  it('rejects unsafe input before serialization', async () => {
    const input = await fixture();
    const target = serviceTarget({ platform: 'linux', home: input.root, xdgConfigHome: undefined });
    for (const port of [0, 65536, NaN, 1.5]) expect(() => renderDefinition({ ...input, target, port })).toThrow();
    for (const kind of ['development', 'unknown'] as const) expect(() => renderDefinition({ ...input, target, distribution: { kind } })).toThrow();
    for (const capturedPath of ['a\nb', 'a\u0000b', '\ud800']) expect(() => renderDefinition({ ...input, target, capturedPath })).toThrow();
    expect(() => renderDefinition({ ...input, target, distribution: { kind: 'npm', executable: 'node', entry: '/entry' } })).toThrow();
  });
});

function windowsFixture(desktop: boolean) {
  const root = 'C:\\Users\\中文 & %USERNAME% !\\Vonvon';
  const cmdPath = `${root}\\service\\vonvon-bot.cmd`;
  const vbsPath = `${root}\\service\\vonvon-bot.vbs`;
  const escapedRoot = 'C:\\Users\\中文 & %%USERNAME%% !\\Vonvon';
  const cmd = [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "ERRORLEVEL="',
    '"%SystemRoot%\\System32\\chcp.com" 65001 >nul',
    'if errorlevel 1 exit /b 1',
    `set "VONVON_HOME=${escapedRoot}"`,
    'set "VONVON_SERVICE=windows"',
    'set "PATH=C:\\工具 %%PATH%% !;C:\\Windows\\System32"',
    ...(desktop ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []),
    ':run',
    `"C:\\Program Files\\Vonvon\\node.exe" "C:\\程序\\bin\\vonvon.mjs" daemon run --port 43121 >> "${escapedRoot}\\service.log" 2>> "${escapedRoot}\\service.err.log"`,
    'if "%errorlevel%"=="0" exit /b 0',
    '"%SystemRoot%\\System32\\reg.exe" query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "Vonvon Bot" >nul 2>&1',
    'if errorlevel 1 exit /b 0',
    '"%SystemRoot%\\System32\\ping.exe" -n 6 127.0.0.1 >nul',
    'goto run', '',
  ].join('\r\n');
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    'Set env = sh.Environment("Process")',
    `env("VONVON_LAUNCHER") = "${cmdPath}"`,
    'sh.Run """" & sh.ExpandEnvironmentStrings("%SystemRoot%") & "\\System32\\cmd.exe"" /d /v:on /s /c """"!VONVON_LAUNCHER!""""", 0, False', '',
  ].join('\r\n');
  return {
    target: { platform: 'win32' as const, cmdPath, vbsPath },
    bytes: { platform: 'win32' as const, cmd: Buffer.from(cmd), vbs: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]), runValue: `wscript.exe //B "${vbsPath}"` },
    root,
  };
}

describe('Windows pure byte recognition on every host', () => {
  for (const desktop of [false, true]) {
    it(`recognizes an independently written ${desktop ? 'desktop' : 'npm'} launcher pair`, () => {
      const { target, bytes, root } = windowsFixture(desktop);
      expect(decodeGeneratedDefinition(target, bytes)).toEqual({ root, port: 43121, capturedPath: 'C:\\工具 %PATH% !;C:\\Windows\\System32', distribution: { kind: desktop ? 'desktop' : 'npm', executable: 'C:\\Program Files\\Vonvon\\node.exe', entry: 'C:\\程序\\bin\\vonvon.mjs' } });
    });
  }
  it('rejects extra executable statements, partial siblings, malformed encoding and alternate Run invocations', () => {
    const { target, bytes } = windowsFixture(false);
    const text = bytes.cmd.toString();
    for (const cmd of [Buffer.from(text + 'evil.exe\r\n'), Buffer.from(text.replace('%%USERNAME%%', '%USERNAME%')), Buffer.from(text.replace('DisableDelayedExpansion', 'EnableDelayedExpansion')), Buffer.from(text.replace('EnableExtensions ', '')), Buffer.from(text.replace('set "ERRORLEVEL="\r\n', '')), Buffer.from(text.replace('goto run', 'goto run\r\nset "VONVON_HOME=C:\\evil"')), Buffer.from([0xff])]) {
      expect(() => decodeGeneratedDefinition(target, { ...bytes, cmd })).toThrow();
    }
    for (const vbs of [Buffer.alloc(0), bytes.vbs.subarray(2), Buffer.concat([bytes.vbs, Buffer.from([0])]), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('evil', 'utf16le')]), Buffer.from([0xff, 0xfe, 0x00, 0xd8])]) {
      expect(() => decodeGeneratedDefinition(target, { ...bytes, vbs })).toThrow();
    }
    expect(() => decodeGeneratedDefinition(target, { ...bytes, runValue: bytes.runValue + ' & evil.exe' })).toThrow();
    expect(() => decodeGeneratedDefinition({ ...target, cmdPath: 'C:\\elsewhere\\vonvon-bot.cmd' }, bytes)).toThrow();
  });
});

describe.skipIf(process.platform !== 'win32')('Windows native filesystem registration', () => {
  for (const inheritedErrorlevel of ['0', '1']) {
    for (const childExit of [0, 75]) {
      it(`uses actual child exit ${childExit} with inherited ERRORLEVEL=${inheritedErrorlevel}`, async () => {
        const { root } = await fixture();
        const target = serviceTarget({ platform: 'win32', root });
        const entry = join(root, 'child.cjs');
        const marker = join(root, 'child-ran.txt');
        await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(${childExit});`);
        const bytes = renderDefinition({ target, root, port: 43121, distribution: { kind: 'npm', executable: process.execPath, entry }, capturedPath: win32.dirname(process.execPath) });
        if (bytes.platform !== 'win32') throw new Error('Expected Windows bytes');
        const lines = Buffer.from(bytes.cmd).toString().split('\r\n');
        const decision = lines.indexOf('if "%errorlevel%"=="0" exit /b 0');
        expect(decision).toBeGreaterThan(0);
        const probe = join(root, 'exit-decision.cmd');
        await writeFile(probe, [...lines.slice(0, decision + 1), 'exit /b 75', ''].join('\r\n'));
        const systemRoot = process.env.SystemRoot;
        if (!systemRoot) throw new Error('SystemRoot is required for native cmd testing');
        const child = spawnSync(win32.join(systemRoot, 'System32', 'cmd.exe'), ['/d', '/e:off', '/v:on', '/s', '/c', '""!VONVON_LAUNCHER!""'], {
          cwd: root,
          env: { SystemRoot: systemRoot, TEMP: root, TMP: root, HOME: root, USERPROFILE: root, ERRORLEVEL: inheritedErrorlevel, VONVON_LAUNCHER: probe },
          windowsVerbatimArguments: true,
          encoding: 'utf8',
          timeout: 5000,
        });
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status, child.stderr).toBe(childExit);
        expect(await readFile(marker, 'utf8')).toBe('ran');
      });
    }
  }

  it('follows the supplied Run locator to another root and inspects withdrawn local leftovers', async () => {
    const { root } = await fixture();
    const other = await fixture();
    const target = serviceTarget({ platform: 'win32', root });
    const otherTarget = serviceTarget({ platform: 'win32', root: other.root });
    if (target.platform !== 'win32' || otherTarget.platform !== 'win32') throw new Error('Expected Windows target');
    const input = { target, requestedRoot: root };
    expect(await readRegistration({ ...input, windowsRun: { kind: 'absent' } })).toEqual({ kind: 'absent' });
    expect((await readRegistration({ ...input, windowsRun: { kind: 'unavailable', reason: 'access denied' } })).kind).toBe('unrecognized');
    const bytes = renderDefinition({ target: otherTarget, root: other.root, port: 43121, distribution: { kind: 'npm', executable: process.execPath, entry: win32.join(other.root, 'bin', 'vonvon.mjs') }, capturedPath: 'C:\\Windows\\System32' });
    if (bytes.platform !== 'win32') throw new Error('Expected Windows bytes');
    await mkdir(win32.dirname(otherTarget.cmdPath), { recursive: true });
    await writeFile(otherTarget.cmdPath, bytes.cmd);
    await writeFile(otherTarget.vbsPath, bytes.vbs);
    expect((await readRegistration({ ...input, windowsRun: { kind: 'value', type: 'REG_SZ', value: bytes.runValue } })).kind).toBe('other-root');
    expect((await readRegistration({ ...input, windowsRun: { kind: 'value', type: 'REG_EXPAND_SZ', value: bytes.runValue } })).kind).toBe('unrecognized');
    expect((await readRegistration({ target: otherTarget, requestedRoot: other.root, windowsRun: { kind: 'absent' } })).kind).toBe('ours');
    await rm(otherTarget.cmdPath);
    expect((await readRegistration({ target: otherTarget, requestedRoot: other.root, windowsRun: { kind: 'absent' } })).kind).toBe('unrecognized');
  });
});


it('keeps pure service modules disconnected from legacy mutation and process execution', async () => {
  for (const file of ['identity', 'definitions', 'registration']) {
    const source = await readFile(new URL(`../src/service/${file}.ts`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:child_process|from ['"]\.\/(?:control|adapter|launchd|systemd|win-startup)['"]|CODEX_BIN|feishu|bridge/);
  }
});
